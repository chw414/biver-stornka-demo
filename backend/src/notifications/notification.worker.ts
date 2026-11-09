import { pool } from '../db.js';
import { getSettings } from '../lib/settings.js';
import { logger } from '../lib/logger.js';
import type { ChannelRegistry } from './channels/registry.js';
import type { ChannelName, NotificationKind, SendResult } from './channels/types.js';
import { renderMessage } from './messages.js';

const LEASE = '2 minutes';
const BATCH = 20;
const MAX_ATTEMPTS = 6;
const BACKOFF_MIN = [1, 5, 15, 60, 180]; // minuty po kolejnych nieudanych próbach

interface Claimed {
  id: string; appointment_id: string; kind: NotificationKind; channel: ChannelName | null;
  attempts: number; recipient_e164: string | null;
  appt_status: string; starts_at: Date; reference_code: string; service_name: string;
  phone_e164: string | null; whatsapp_opt_in: boolean;
}

/**
 * Pobiera należne powiadomienia z dzierżawą (locked_until). FOR UPDATE SKIP LOCKED pozwala
 * uruchomić kilka workerów równolegle bez podwójnej wysyłki. Gdy worker padnie w trakcie,
 * dzierżawa wygasa i inny worker podejmie zadanie (gwarancja "co najmniej raz").
 */
async function claim(): Promise<Claimed[]> {
  const { rows } = await pool.query<Claimed>(
    `WITH due AS (
       SELECT id FROM notifications
        WHERE status = 'pending' AND scheduled_for <= now()
          AND (locked_until IS NULL OR locked_until < now())
        ORDER BY scheduled_for
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     ), leased AS (
       UPDATE notifications n
          SET locked_until = now() + interval '${LEASE}', attempts = n.attempts + 1
         FROM due WHERE n.id = due.id
       RETURNING n.id, n.appointment_id, n.kind, n.channel, n.attempts, n.recipient_e164
     )
     SELECT l.*, a.status AS appt_status, a.starts_at, a.reference_code, a.service_name_snapshot AS service_name,
            c.phone_e164,
            EXISTS (SELECT 1 FROM customer_consents cc JOIN legal_documents d ON d.id = cc.document_id
                     WHERE cc.customer_id = c.id AND d.kind = 'whatsapp' AND cc.withdrawn_at IS NULL) AS whatsapp_opt_in
       FROM leased l
       JOIN appointments a ON a.id = l.appointment_id
       JOIN customers c ON c.id = a.customer_id`,
    [BATCH],
  );
  return rows;
}

/** Pierwszy kanał z listy (zaczynając od `from`), który jest skonfigurowany i dozwolony dla klienta. */
function pickChannel(order: ChannelName[], registry: ChannelRegistry, optIn: boolean, after?: ChannelName): ChannelName | null {
  const start = after ? order.indexOf(after) + 1 : 0;
  for (const name of order.slice(start)) {
    const ch = registry.get(name);
    if (ch && (!ch.requiresOptIn || optIn)) return name;
  }
  return null;
}

async function finish(id: string, status: 'cancelled' | 'failed', reason: string, extra: { channel?: ChannelName | null; error?: string } = {}) {
  await pool.query(
    `UPDATE notifications SET status = $2, error_code = $3, last_error = $4, channel = COALESCE($5, channel), locked_until = NULL
      WHERE id = $1`,
    [id, status, reason, extra.error ?? null, extra.channel ?? null]);
}

/**
 * Po trwałej porażce kanału: zapasowe powiadomienie kolejnym kanałem z listy (np. SMS po WhatsAppie).
 * Używane też przez webhook, gdy porażka przychodzi asynchronicznie (np. 131026 — numer bez WhatsAppa).
 */
export async function createFallback(notificationId: string, failedChannel: ChannelName, registry: ChannelRegistry): Promise<string | null> {
  const settings = await getSettings();
  const { rows: [n] } = await pool.query<{ appointment_id: string; kind: NotificationKind; recipient_e164: string | null; whatsapp_opt_in: boolean }>(
    `SELECT n.appointment_id, n.kind, n.recipient_e164,
            EXISTS (SELECT 1 FROM customer_consents cc JOIN legal_documents d ON d.id = cc.document_id
                     WHERE cc.customer_id = a.customer_id AND d.kind = 'whatsapp' AND cc.withdrawn_at IS NULL) AS whatsapp_opt_in
       FROM notifications n JOIN appointments a ON a.id = n.appointment_id WHERE n.id = $1`, [notificationId]);
  if (!n) return null;
  const next = pickChannel(settings.notification_channels, registry, n.whatsapp_opt_in, failedChannel);
  if (!next) return null;
  const { rows: [f] } = await pool.query<{ id: string }>(
    `INSERT INTO notifications (appointment_id, kind, channel, recipient_e164, scheduled_for, fallback_of)
     SELECT $1, $2, $3, $4, now(), $5
      WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE fallback_of = $5)  -- idempotentnie (powtórzone webhooki)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [n.appointment_id, n.kind, next, n.recipient_e164, notificationId]);
  if (f) logger.info({ notificationId, fallbackId: f.id, channel: next }, 'Utworzono powiadomienie zapasowe');
  return f?.id ?? null;
}

async function processOne(n: Claimed, registry: ChannelRegistry): Promise<void> {
  const settings = await getSettings();

  // 1. Czy wysyłka ma jeszcze sens? (wizyta mogła zostać anulowana / przesunięta / minąć, gdy worker nie działał)
  if (n.kind !== 'cancellation' && n.appt_status !== 'confirmed') return finish(n.id, 'cancelled', 'APPOINTMENT_NOT_ACTIVE');
  if (n.kind !== 'cancellation' && n.starts_at <= new Date()) return finish(n.id, 'cancelled', 'APPOINTMENT_PASSED');
  const to = n.phone_e164 ?? n.recipient_e164;
  if (!to) return finish(n.id, 'cancelled', 'NO_RECIPIENT');

  // 2. Kanał: przypisany (ponowienie / fallback) albo wybrany teraz wg ustawień i zgód
  const channelName = n.channel ?? pickChannel(settings.notification_channels, registry, n.whatsapp_opt_in);
  if (!channelName) return finish(n.id, 'cancelled', 'NO_CHANNEL'); // np. brak zgody na WhatsApp i brak SMS
  const channel = registry.get(channelName);
  if (!channel) return finish(n.id, 'failed', 'CHANNEL_NOT_CONFIGURED', { channel: channelName });
  if (channel.requiresOptIn && !n.whatsapp_opt_in) {
    // zgodę wycofano po zaplanowaniu — przejdź na kolejny kanał, jeśli jest
    await finish(n.id, 'cancelled', 'OPT_IN_WITHDRAWN', { channel: channelName });
    await createFallback(n.id, channelName, registry);
    return;
  }

  // 3. Wysyłka
  const message = renderMessage({ kind: n.kind, serviceName: n.service_name, startsAt: n.starts_at, referenceCode: n.reference_code, timezone: settings.timezone });
  let result: SendResult;
  try {
    result = await channel.send({ to, message, callbackData: n.id });
  } catch (err) {
    result = { status: 'retry', errorCode: 'EXCEPTION', error: err instanceof Error ? err.message : String(err) };
  }

  // 4. Wynik
  if (result.status === 'accepted') {
    await pool.query(
      `UPDATE notifications SET status = 'sent', channel = $2, provider = $3, provider_message_id = $4,
              recipient_e164 = $5, sent_at = now(), locked_until = NULL, error_code = NULL, last_error = NULL
        WHERE id = $1`,
      [n.id, channelName, channel.provider, result.providerMessageId, to]);
    return;
  }

  if (result.status === 'retry' && n.attempts < MAX_ATTEMPTS) {
    const delay = BACKOFF_MIN[Math.min(n.attempts - 1, BACKOFF_MIN.length - 1)]!;
    await pool.query(
      `UPDATE notifications SET channel = $2, error_code = $3, last_error = $4,
              locked_until = now() + make_interval(mins => $5::int)
        WHERE id = $1`,
      [n.id, channelName, result.errorCode, result.error, delay]);
    logger.warn({ notificationId: n.id, channel: channelName, code: result.errorCode, retryInMin: delay }, 'Wysyłka do ponowienia');
    return;
  }

  await finish(n.id, 'failed', result.errorCode, { channel: channelName, error: result.error });
  logger.error({ notificationId: n.id, channel: channelName, code: result.errorCode, error: result.error }, 'Wysyłka nieudana');
  await createFallback(n.id, channelName, registry);
}

/** Jedna iteracja workera. Zwraca liczbę przetworzonych powiadomień. */
export async function runNotificationTick(registry: ChannelRegistry): Promise<number> {
  const batch = await claim();
  // równolegle, ale w obrębie małej paczki — limity przepustowości WhatsApp są dużo wyższe
  await Promise.all(batch.map((n) => processOne(n, registry).catch((err) =>
    logger.error({ err, notificationId: n.id }, 'Błąd przetwarzania powiadomienia (dzierżawa wygaśnie, zadanie wróci)'))));
  return batch.length;
}
