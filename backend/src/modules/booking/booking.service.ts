import type pg from 'pg';
import { withTransaction } from '../../db.js';
import { AppError, Errors } from '../../errors.js';
import { getSettings } from '../../lib/settings.js';
import { generateReferenceCode } from '../../lib/referenceCode.js';
import { addDays, findSlots, localDates } from './availability.repository.js';
import { getPublicService } from './services.repository.js';
import { createPhoneVerifier } from './phoneVerifier.js';
import { lockDays } from './booking.core.js';
import { grantWhatsAppConsent } from '../consents/whatsappConsent.js';
import type { CreateBookingInput } from './booking.schemas.js';

export interface BookingContext {
  idempotencyKey: string;
  ip: string | null;
  userAgent: string | null;
}

export interface BookingResult {
  replayed: boolean;
  appointment: {
    referenceCode: string;
    startsAt: string;
    endsAt: string;
    serviceName: string;
    status: string;
  };
}

/**
 * Tworzy rezerwację online.
 *
 * Gwarancja braku podwójnej rezerwacji ma 2 warstwy:
 *  1. Blokada pesymistyczna: SELECT ... FOR UPDATE na wierszu dnia w booking_day_locks.
 *     Rezerwacje na TEN SAM dzień wykonują się po kolei; różne dni — równolegle.
 *     Pod blokadą sprawdzamy wolne stanowiska i wybieramy jedno — bez wyścigu.
 *  2. Constraint EXCLUDE w bazie (appt_no_overlap_per_station) — ostatnia linia obrony.
 *     Jego naruszenie (23P01) mapujemy na 409 w errorHandlerze.
 *
 * Wywołania zewnętrzne (SMS, Google Calendar) NIE dzieją się tutaj: zapisujemy notifications
 * i outbox_events w tej samej transakcji, a worker wykona je po commicie.
 */
export async function createOnlineBooking(input: CreateBookingInput, ctx: BookingContext): Promise<BookingResult> {
  const settings = await getSettings();

  // Hook pod przyszłe OTP — dziś zawsze ok
  const verification = await createPhoneVerifier(settings.phone_verification).verify(input.phone, input.verificationToken);
  if (!verification.ok) throw Errors.phoneNotVerified();

  return withTransaction(async (tx) => {
    // Nie czekamy na blokadę w nieskończoność — przy przeciążeniu zwracamy 503 (Retry-After)
    await tx.query(`SET LOCAL lock_timeout = '5s'`);

    const service = await getPublicService(tx, input.serviceId);
    if (!service) throw Errors.serviceNotFound();

    const { today, day } = await localDates(tx, settings.timezone, input.startsAt);
    if (!day || day < today || day > addDays(today, settings.booking_horizon_days)) throw Errors.invalidSlot();

    // ---- 1. BLOKADA PESYMISTYCZNA DNIA -------------------------------------------------
    await lockDays(tx, [day]);
    // Od tego miejsca do COMMIT żadna inna rezerwacja na ten dzień nie przejdzie.

    // ---- 2. Idempotencja (po blokadzie, więc powtórzone żądanie zobaczy wynik pierwszego) --
    const replay = await findByIdempotencyKey(tx, ctx.idempotencyKey);
    if (replay) {
      if (replay.service_id !== input.serviceId || replay.starts_at.getTime() !== new Date(input.startsAt).getTime()) {
        throw Errors.idempotencyMismatch();
      }
      return { replayed: true, appointment: toDto(replay) };
    }

    // ---- 3. Czy termin jest poprawny i czy jest wolne stanowisko? -----------------------
    const [slot] = await findSlots(tx, {
      from: day,
      to: day,
      durationMin: service.duration_minutes,
      timezone: settings.timezone,
      leadMin: settings.min_lead_time_minutes,
      exactStart: input.startsAt,
    });
    if (!slot) throw Errors.invalidSlot();            // poza godzinami / poza siatką / za blisko
    const stationId = slot.free_station_ids[0];
    if (stationId === undefined) throw Errors.slotTaken(); // termin poprawny, ale oba stanowiska zajęte

    // ---- 4. Klient i pojazd (bez nadpisywania istniejących danych) ----------------------
    const customerId = await upsertCustomer(tx, input.phone, input.fullName);
    const vehicleId = await upsertVehicle(tx, customerId, input.vehicle);

    // ---- 5. Wizyta ---------------------------------------------------------------------
    const { rows: [appt] } = await tx.query<AppointmentRow>(
      `INSERT INTO appointments
         (reference_code, customer_id, vehicle_id, service_id, station_id, starts_at, ends_at,
          source, service_name_snapshot, price_from_snapshot, customer_notes, booked_full_name,
          idempotency_key, created_ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'online', $8, $9, $10, $11, $12, $13)
       RETURNING id, reference_code, service_id, starts_at, ends_at, service_name_snapshot, status`,
      [
        generateReferenceCode(), customerId, vehicleId, service.id, stationId, slot.starts_at, slot.ends_at,
        service.name, service.price_from_pln, input.notes || null, input.fullName,
        ctx.idempotencyKey, ctx.ip,
      ],
    );
    if (!appt) throw new AppError(500, 'INTERNAL', 'Nie udało się zapisać wizyty');

    // ---- 6. Zgody, powiadomienia, outbox, audyt — atomowo z wizytą ---------------------
    await recordConsents(tx, customerId, appt.id, ctx);
    if (input.whatsappOptIn) {
      await grantWhatsAppConsent(tx, { customerId, appointmentId: appt.id, ip: ctx.ip, userAgent: ctx.userAgent });
    }
    await scheduleNotifications(tx, appt.id, input.phone, slot.starts_at, settings.reminder_offset_hours);
    await tx.query(
      `INSERT INTO outbox_events (aggregate_id, event_type, payload) VALUES ($1, 'appointment.created', $2)`,
      [appt.id, { appointmentId: appt.id }],
    );
    await tx.query(
      `INSERT INTO audit_log (actor, action, entity_type, entity_id, changes, ip_address)
       VALUES ('customer', 'appointment.create', 'appointment', $1, $2, $3)`,
      [appt.id, { source: 'online', serviceId: service.id, startsAt: slot.starts_at, stationId }, ctx.ip],
    );

    return { replayed: false, appointment: toDto(appt) };
  });
}

// ------------------------------------------------------------------------------------------

interface AppointmentRow {
  id: string;
  reference_code: string;
  service_id: number;
  starts_at: Date;
  ends_at: Date;
  service_name_snapshot: string;
  status: string;
}

function toDto(a: AppointmentRow): BookingResult['appointment'] {
  return {
    referenceCode: a.reference_code,
    startsAt: a.starts_at.toISOString(),
    endsAt: a.ends_at.toISOString(),
    serviceName: a.service_name_snapshot,
    status: a.status,
  };
}

async function findByIdempotencyKey(tx: pg.PoolClient, key: string) {
  const { rows } = await tx.query<AppointmentRow>(
    `SELECT id, reference_code, service_id, starts_at, ends_at, service_name_snapshot, status
       FROM appointments WHERE idempotency_key = $1`,
    [key],
  );
  return rows[0] ?? null;
}

/**
 * Nowy klient → INSERT. Istniejący (ten sam telefon) → tylko jego id.
 * Celowo NIE nadpisujemy imienia: bez weryfikacji numeru ktoś mógłby podmienić dane obcej osoby.
 * Wpisane imię zostaje w appointments.booked_full_name, admin poprawi dane klienta ręcznie.
 * Przy równoległym INSERT tego samego numeru drugi czeka na indeks unikalny, dostaje DO NOTHING,
 * a następny SELECT (nowy snapshot w READ COMMITTED) widzi już zatwierdzony wiersz.
 */
async function upsertCustomer(tx: pg.PoolClient, phone: string, fullName: string): Promise<string> {
  const ins = await tx.query<{ id: string }>(
    `INSERT INTO customers (phone_e164, full_name) VALUES ($1, $2)
     ON CONFLICT (phone_e164) DO NOTHING RETURNING id`,
    [phone, fullName],
  );
  if (ins.rows[0]) return ins.rows[0].id;
  const sel = await tx.query<{ id: string }>('SELECT id FROM customers WHERE phone_e164 = $1', [phone]);
  return sel.rows[0]!.id;
}

async function upsertVehicle(
  tx: pg.PoolClient,
  customerId: string,
  v: CreateBookingInput['vehicle'],
): Promise<string> {
  const ins = await tx.query<{ id: string }>(
    `INSERT INTO vehicles (customer_id, make, model, registration_number) VALUES ($1, $2, $3, $4)
     ON CONFLICT ON CONSTRAINT vehicles_unique_per_customer DO NOTHING RETURNING id`,
    [customerId, v.make, v.model, v.registrationNumber],
  );
  if (ins.rows[0]) return ins.rows[0].id;
  const sel = await tx.query<{ id: string }>(
    'SELECT id FROM vehicles WHERE customer_id = $1 AND registration_number = $2',
    [customerId, v.registrationNumber],
  );
  return sel.rows[0]!.id;
}

/** Zapisuje akceptację AKTUALNYCH wersji regulaminu i polityki prywatności (jeden checkbox w formularzu). */
async function recordConsents(tx: pg.PoolClient, customerId: string, appointmentId: string, ctx: BookingContext) {
  const { rowCount } = await tx.query(
    `INSERT INTO customer_consents (customer_id, document_id, appointment_id, ip_address, user_agent)
     SELECT $1, d.id, $2, $3, $4
       FROM (SELECT DISTINCT ON (kind) id, kind
               FROM legal_documents
              WHERE kind IN ('terms', 'privacy') AND published_at <= now()
              ORDER BY kind, published_at DESC) d`,
    [customerId, appointmentId, ctx.ip, ctx.userAgent?.slice(0, 255) ?? null],
  );
  if (rowCount !== 2) throw Errors.misconfigured('brak opublikowanego regulaminu lub polityki prywatności');
}

/** Kanał (WhatsApp / SMS) wybiera worker w chwili wysyłki — tu tylko CO i KIEDY. */
async function scheduleNotifications(
  tx: pg.PoolClient,
  appointmentId: string,
  phone: string,
  startsAt: Date,
  reminderOffsetHours: number,
) {
  await tx.query(
    `INSERT INTO notifications (appointment_id, kind, recipient_e164, scheduled_for)
     VALUES ($1, 'confirmation', $2, now())`,
    [appointmentId, phone],
  );
  // Przypomnienie tylko wtedy, gdy moment wysyłki jest jeszcze w przyszłości
  await tx.query(
    `INSERT INTO notifications (appointment_id, kind, recipient_e164, scheduled_for)
     SELECT $1, 'reminder_24h', $2, $3::timestamptz - make_interval(hours => $4::int)
      WHERE $3::timestamptz - make_interval(hours => $4::int) > now()`,
    [appointmentId, phone, startsAt, reminderOffsetHours],
  );
}
