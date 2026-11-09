import type pg from 'pg';
import { config } from '../config.js';
import { pool, withTransaction } from '../db.js';
import { getSettings } from '../lib/settings.js';
import { logger } from '../lib/logger.js';
import { CalendarApiError, type GoogleCalendarClient } from './googleCalendar.client.js';

const BATCH = 10;
const MAX_ATTEMPTS = 8;
const BACKOFF_MIN = [1, 2, 5, 15, 30, 60, 120];

export type CalendarTarget = GoogleCalendarClient | 'log' | 'disabled';

interface ClaimedEvent { id: string; aggregate_id: string; event_type: string; attempts: number }

/**
 * Pobranie paczki zdarzeń. Globalna blokada doradcza na czas samego "claimu" (milisekundy) gwarantuje,
 * że dla danej wizyty w danym momencie przetwarzane jest najwyżej JEDNO zdarzenie — inaczej dwa workery
 * mogłyby odczytać różne wersje stanu i zapisać do Google starszą jako ostatnią.
 */
async function claim(): Promise<ClaimedEvent[]> {
  return withTransaction(async (tx: pg.PoolClient) => {
    await tx.query('SELECT pg_advisory_xact_lock(727275)');
    const { rows } = await tx.query<ClaimedEvent>(
      `WITH candidates AS (
         SELECT * FROM (
           SELECT DISTINCT ON (aggregate_id) id, aggregate_id
             FROM outbox_events
            WHERE (status = 'pending' AND next_attempt_at <= now())
               OR (status = 'processing' AND locked_until < now())     -- worker padł w trakcie
            ORDER BY aggregate_id, id DESC   -- NAJNOWSZE zdarzenie wizyty: stan bieżący obejmuje starsze
         ) x
         WHERE NOT EXISTS (SELECT 1 FROM outbox_events p
                            WHERE p.aggregate_id = x.aggregate_id AND p.id <> x.id
                              AND p.status = 'processing' AND p.locked_until >= now())
         ORDER BY id
         LIMIT $1
       )
       UPDATE outbox_events o
          SET status = 'processing', locked_until = now() + interval '2 minutes', attempts = o.attempts + 1
         FROM candidates c WHERE o.id = c.id
       RETURNING o.id, o.aggregate_id, o.event_type, o.attempts`,
      [BATCH]);
    return rows;
  });
}

interface ApptState {
  status: string; starts_at: Date; ends_at: Date; reference_code: string; service_name: string;
  station_name: string; source: string; make: string; model: string; registration_number: string | null;
  full_name: string | null; phone_e164: string | null; customer_notes: string | null;
}

function buildEvent(id: string, a: ApptState, timeZone: string) {
  const mark = a.status === 'completed' ? '✓ ' : a.status === 'no_show' ? '✗ ' : '';
  const vehicle = [a.make, a.model, a.registration_number].filter(Boolean).join(' ');
  const lines = [
    `Rezerwacja: ${a.reference_code}`,
    `Stanowisko: ${a.station_name}`,
    `Źródło: ${a.source === 'online' ? 'online' : a.source === 'phone' ? 'telefon' : 'z ulicy'}`,
    `Pojazd: ${vehicle}`,
  ];
  if (config.GOOGLE_CALENDAR_INCLUDE_PII) {
    if (a.full_name) lines.push(`Klient: ${a.full_name}`);
    if (a.phone_e164) lines.push(`Telefon: ${a.phone_e164}`);
    if (a.customer_notes) lines.push(`Uwagi: ${a.customer_notes}`);
  }
  return {
    appointmentId: id, timeZone, start: a.starts_at, end: a.ends_at,
    summary: `${mark}${a.station_name} · ${a.service_name} · ${vehicle}`,
    description: lines.join('\n'),
  };
}

/** Synchronizuje AKTUALNY stan wizyty (nie odtwarza zdarzeń) — kolejność i duplikaty nie mają znaczenia. */
async function syncAppointment(appointmentId: string, target: CalendarTarget) {
  const settings = await getSettings();
  const { rows: [a] } = await pool.query<ApptState>(
    `SELECT a.status, a.starts_at, a.ends_at, a.reference_code, a.service_name_snapshot AS service_name,
            s.name AS station_name, a.source, v.make, v.model, v.registration_number,
            c.full_name, c.phone_e164, a.customer_notes
       FROM appointments a JOIN stations s ON s.id = a.station_id
       JOIN vehicles v ON v.id = a.vehicle_id JOIN customers c ON c.id = a.customer_id
      WHERE a.id = $1`, [appointmentId]);

  if (target === 'disabled') return;
  if (!a || a.status === 'cancelled') {
    if (target === 'log') logger.info({ appointmentId }, 'Kalendarz (tryb log): usuń event');
    else await target.remove(appointmentId);
    await pool.query('UPDATE appointments SET google_event_id = NULL WHERE id = $1 AND google_event_id IS NOT NULL', [appointmentId]);
    return;
  }
  const ev = buildEvent(appointmentId, a, settings.timezone);
  if (target === 'log') { logger.info({ appointmentId, summary: ev.summary }, 'Kalendarz (tryb log): upsert event'); return; }
  const eventId = await target.upsert(ev);
  await pool.query('UPDATE appointments SET google_event_id = $2 WHERE id = $1 AND google_event_id IS DISTINCT FROM $2', [appointmentId, eventId]);
}

export async function runOutboxTick(target: CalendarTarget): Promise<number> {
  const batch = await claim();
  await Promise.all(batch.map(async (e) => {
    try {
      await syncAppointment(e.aggregate_id, target);
      // stan aktualny obejmuje wszystkie wcześniejsze zdarzenia tej wizyty → oznacz je razem (koalescencja)
      await pool.query(
        `UPDATE outbox_events SET status = 'done', processed_at = now(), locked_until = NULL, last_error = NULL
          WHERE aggregate_id = $1 AND id <= $2 AND status IN ('pending', 'processing')`,
        [e.aggregate_id, e.id]);
    } catch (err) {
      const retryable = !(err instanceof CalendarApiError) || err.retryable;
      const msg = err instanceof Error ? err.message : String(err);
      if (retryable && e.attempts < MAX_ATTEMPTS) {
        const delay = BACKOFF_MIN[Math.min(e.attempts - 1, BACKOFF_MIN.length - 1)]!;
        await pool.query(
          `UPDATE outbox_events SET status = 'pending', locked_until = NULL, last_error = $2,
                  next_attempt_at = now() + make_interval(mins => $3::int) WHERE id = $1`, [e.id, msg, delay]);
        logger.warn({ outboxId: e.id, retryInMin: delay, error: msg }, 'Synchronizacja kalendarza do ponowienia');
      } else {
        await pool.query(`UPDATE outbox_events SET status = 'failed', locked_until = NULL, last_error = $2 WHERE id = $1`, [e.id, msg]);
        logger.error({ outboxId: e.id, appointmentId: e.aggregate_id, error: msg }, 'Synchronizacja kalendarza NIEUDANA');
      }
    }
  }));
  return batch.length;
}
