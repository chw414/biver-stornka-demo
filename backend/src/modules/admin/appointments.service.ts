import type pg from 'pg';
import { pool, withTransaction, type Db } from '../../db.js';
import { AppError, Errors } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import { getSettings } from '../../lib/settings.js';
import { generateReferenceCode } from '../../lib/referenceCode.js';
import { findFreeStations, findSlots } from '../booking/availability.repository.js';
import { localDayOf, lockDays } from '../booking/booking.core.js';
import type { CreateAdminAppointmentInput, UpdateAppointmentInput } from './appointments.schemas.js';
import { grantWhatsAppConsent } from '../consents/whatsappConsent.js';

export interface AdminCtx { adminId: string; ip: string | null; idempotencyKey?: string | null }

const notFound = () => new AppError(404, 'APPOINTMENT_NOT_FOUND', 'Nie znaleziono wizyty');
const outsideHours = () => new AppError(422, 'OUTSIDE_BUSINESS_HOURS',
  'Termin poza godzinami pracy. Zaznacz „dodaj poza godzinami”, jeśli to celowe.');
const stationTaken = () => new AppError(409, 'STATION_TAKEN', 'Wybrane stanowisko jest zajęte w tym czasie');
const stale = (current: number) => new AppError(409, 'STALE_VERSION',
  'Wizyta została w międzyczasie zmieniona przez kogoś innego. Odśwież i spróbuj ponownie.', { currentLockVersion: current });

const addMinutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
const isAligned = (d: Date) => d.getTime() % (15 * 60_000) === 0;

interface ServiceRow { id: number; name: string; duration_minutes: number; price_from_pln: string | null }
async function getActiveService(db: Db, id: number): Promise<ServiceRow> {
  // admin może użyć także usług niepublicznych (is_public = false)
  const { rows: [s] } = await db.query<ServiceRow>(
    'SELECT id, name, duration_minutes, price_from_pln FROM services WHERE id = $1 AND is_active', [id]);
  if (!s) throw Errors.serviceNotFound();
  return s;
}

/**
 * Sprawdza godziny pracy (chyba że allowOutsideHours) i wybiera stanowisko.
 * Wywoływać WYŁĄCZNIE pod blokadą dnia (lockDays).
 */
async function resolveStation(
  tx: pg.PoolClient,
  p: { start: Date; end: Date; timezone: string; allowOutsideHours: boolean; requested?: number;
       preferred?: number; excludeAppointmentId?: string },
): Promise<number> {
  if (!isAligned(p.start) || !isAligned(p.end)) throw Errors.invalidSlot();
  if (!p.allowOutsideHours) {
    const day = await localDayOf(tx, p.start, p.timezone);
    const durationMin = (p.end.getTime() - p.start.getTime()) / 60_000;
    const [slot] = await findSlots(tx, { from: day, to: day, durationMin, timezone: p.timezone, leadMin: null, exactStart: p.start.toISOString() });
    if (!slot) throw outsideHours();
  }
  const free = await findFreeStations(tx, { startsAt: p.start, endsAt: p.end, excludeAppointmentId: p.excludeAppointmentId });
  if (p.requested !== undefined) {
    if (!free.includes(p.requested)) throw stationTaken();
    return p.requested;
  }
  if (p.preferred !== undefined && free.includes(p.preferred)) return p.preferred; // przy przesunięciu zostań na tym samym
  const first = free[0];
  if (first === undefined) throw Errors.slotTaken();
  return first;
}

// ======================================================================================
//  Ręczne dodanie wizyty (telefon / klient „z ulicy”)
// ======================================================================================
export async function createAdminAppointment(input: CreateAdminAppointmentInput, ctx: AdminCtx) {
  const settings = await getSettings();
  return withTransaction(async (tx) => {
    await tx.query(`SET LOCAL lock_timeout = '5s'`);
    const service = await getActiveService(tx, input.serviceId);
    const start = new Date(input.startsAt);
    const end = addMinutes(start, input.durationMinutes ?? service.duration_minutes);

    await lockDays(tx, [await localDayOf(tx, start, settings.timezone), await localDayOf(tx, addMinutes(end, -1), settings.timezone)]);

    if (ctx.idempotencyKey) {
      const { rows: [dup] } = await tx.query<{ id: string }>('SELECT id FROM appointments WHERE idempotency_key = $1', [ctx.idempotencyKey]);
      if (dup) return { replayed: true, appointment: await getAppointmentDetail(tx, dup.id) };
    }

    const stationId = await resolveStation(tx, {
      start, end, timezone: settings.timezone, allowOutsideHours: input.allowOutsideHours, requested: input.stationId,
    });

    const customer = await resolveCustomer(tx, input.customer);
    const vehicleId = await resolveVehicle(tx, customer.id, input.vehicle);

    const { rows: [appt] } = await tx.query<{ id: string }>(
      `INSERT INTO appointments
         (reference_code, customer_id, vehicle_id, service_id, station_id, starts_at, ends_at, source,
          service_name_snapshot, price_from_snapshot, customer_notes, admin_notes, idempotency_key, created_by_admin_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [generateReferenceCode(), customer.id, vehicleId, service.id, stationId, start, end, input.source,
       service.name, service.price_from_pln, input.customerNotes || null, input.adminNotes || null,
       ctx.idempotencyKey ?? null, ctx.adminId],
    );
    const id = appt!.id;
    if (input.whatsappOptIn) await grantWhatsAppConsent(tx, { customerId: customer.id, appointmentId: id, adminId: ctx.adminId });

    if (input.notifyCustomer && customer.phone) {
      await insertNotification(tx, id, 'confirmation', customer.phone, null);
      await insertReminder(tx, id, customer.phone, start, settings.reminder_offset_hours);
    }
    await outbox(tx, id, 'appointment.created');
    await audit(tx, { actor: 'admin', adminId: ctx.adminId, action: 'appointment.create', entityType: 'appointment', entityId: id, ip: ctx.ip,
      changes: { source: input.source, serviceId: service.id, stationId, startsAt: start, endsAt: end, outsideHours: input.allowOutsideHours } });

    return { replayed: false, existingCustomer: customer.existing, appointment: await getAppointmentDetail(tx, id) };
  });
}

async function resolveCustomer(tx: pg.PoolClient, ref: CreateAdminAppointmentInput['customer']) {
  if ('customerId' in ref) {
    const { rows: [c] } = await tx.query<{ id: string; phone_e164: string | null }>(
      'SELECT id, phone_e164 FROM customers WHERE id = $1 AND anonymized_at IS NULL', [ref.customerId]);
    if (!c) throw new AppError(422, 'CUSTOMER_NOT_FOUND', 'Nie znaleziono klienta');
    return { id: c.id, phone: c.phone_e164, existing: true };
  }
  const ins = await tx.query<{ id: string }>(
    `INSERT INTO customers (phone_e164, full_name) VALUES ($1, $2) ON CONFLICT (phone_e164) DO NOTHING RETURNING id`,
    [ref.phone, ref.fullName]);
  if (ins.rows[0]) return { id: ins.rows[0].id, phone: ref.phone, existing: false };
  // numer już w bazie → używamy istniejącego klienta; dane edytuje się świadomie w karcie klienta
  const { rows: [c] } = await tx.query<{ id: string }>('SELECT id FROM customers WHERE phone_e164 = $1', [ref.phone]);
  return { id: c!.id, phone: ref.phone, existing: true };
}

async function resolveVehicle(tx: pg.PoolClient, customerId: string, ref: CreateAdminAppointmentInput['vehicle']) {
  if ('vehicleId' in ref) {
    const { rows: [v] } = await tx.query<{ id: string }>(
      'SELECT id FROM vehicles WHERE id = $1 AND customer_id = $2', [ref.vehicleId, customerId]);
    if (!v) throw new AppError(422, 'VEHICLE_NOT_FOUND', 'Pojazd nie należy do tego klienta');
    return v.id;
  }
  const ins = await tx.query<{ id: string }>(
    `INSERT INTO vehicles (customer_id, make, model, registration_number) VALUES ($1,$2,$3,$4)
     ON CONFLICT ON CONSTRAINT vehicles_unique_per_customer DO NOTHING RETURNING id`,
    [customerId, ref.make, ref.model, ref.registrationNumber]);
  if (ins.rows[0]) return ins.rows[0].id;
  const { rows: [v] } = await tx.query<{ id: string }>(
    'SELECT id FROM vehicles WHERE customer_id = $1 AND registration_number = $2', [customerId, ref.registrationNumber]);
  return v!.id;
}

// ======================================================================================
//  Edycja: przesunięcie terminu / zmiana usługi, stanowiska, statusu, notatek
// ======================================================================================
interface LockedAppt {
  id: string; status: 'confirmed' | 'completed' | 'cancelled' | 'no_show'; lock_version: number;
  starts_at: Date; ends_at: Date; station_id: number; service_id: number; phone_e164: string | null;
}

export async function updateAppointment(id: string, input: UpdateAppointmentInput, ctx: AdminCtx) {
  const settings = await getSettings();
  return withTransaction(async (tx) => {
    await tx.query(`SET LOCAL lock_timeout = '5s'`);

    // 1. odczyt bez blokady — tylko po to, by wiedzieć, które dni zablokować
    const { rows: [peek] } = await tx.query<{ starts_at: Date; ends_at: Date }>(
      'SELECT starts_at, ends_at FROM appointments WHERE id = $1', [id]);
    if (!peek) throw notFound();

    const service = input.serviceId !== undefined ? await getActiveService(tx, input.serviceId) : null;
    const newStart = input.startsAt ? new Date(input.startsAt) : peek.starts_at;
    const currentDuration = (peek.ends_at.getTime() - peek.starts_at.getTime()) / 60_000;
    const newEnd = addMinutes(newStart, input.durationMinutes ?? service?.duration_minutes ?? currentDuration);

    // 2. blokada dni: starego i nowego terminu (posortowane — bez deadlocków)
    await lockDays(tx, await Promise.all(
      [peek.starts_at, newStart].map((d) => localDayOf(tx, d, settings.timezone))));

    // 3. właściwa blokada wiersza wizyty + kontrola wersji
    const { rows: [a] } = await tx.query<LockedAppt>(
      `SELECT a.id, a.status, a.lock_version, a.starts_at, a.ends_at, a.station_id, a.service_id, c.phone_e164
         FROM appointments a JOIN customers c ON c.id = a.customer_id
        WHERE a.id = $1 FOR UPDATE OF a`, [id]);
    if (!a) throw notFound();
    if (a.lock_version !== input.lockVersion) throw stale(a.lock_version);
    if (a.status === 'cancelled') throw new AppError(409, 'APPOINTMENT_CANCELLED', 'Nie można edytować anulowanej wizyty');

    const newStatus = input.status ?? a.status;
    const timeChanged = newStart.getTime() !== a.starts_at.getTime() || newEnd.getTime() !== a.ends_at.getTime();
    const stationChanged = input.stationId !== undefined && input.stationId !== a.station_id;
    const reoccupies = a.status === 'no_show' && newStatus === 'confirmed'; // cofnięcie no-show zajmuje znowu stanowisko

    if ((newStatus === 'completed' || newStatus === 'no_show') && newStart > new Date()) {
      throw new AppError(422, 'APPOINTMENT_NOT_STARTED', 'Nie można oznaczyć jako zakończonej / nieobecności przed jej rozpoczęciem');
    }

    let stationId = a.station_id;
    if (timeChanged || stationChanged || reoccupies) {
      stationId = await resolveStation(tx, {
        start: newStart, end: newEnd, timezone: settings.timezone, allowOutsideHours: input.allowOutsideHours,
        requested: input.stationId, preferred: a.station_id, excludeAppointmentId: a.id,
      });
    }

    await tx.query(
      `UPDATE appointments
          SET starts_at = $2, ends_at = $3, station_id = $4, status = $5,
              service_id = COALESCE($6, service_id),
              service_name_snapshot = COALESCE($7, service_name_snapshot),
              price_from_snapshot = CASE WHEN $6::int IS NULL THEN price_from_snapshot ELSE $8::numeric END,
              customer_notes = CASE WHEN $9 THEN $10 ELSE customer_notes END,
              admin_notes    = CASE WHEN $11 THEN $12 ELSE admin_notes END,
              lock_version = lock_version + 1
        WHERE id = $1`,
      [id, newStart, newEnd, stationId, newStatus, service?.id ?? null, service?.name ?? null, service?.price_from_pln ?? null,
       input.customerNotes !== undefined, input.customerNotes ?? null, input.adminNotes !== undefined, input.adminNotes ?? null],
    );

    // 4. powiadomienia
    if (timeChanged && newStatus === 'confirmed') {
      const { rows: [r] } = await tx.query<{ had: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM notifications WHERE appointment_id = $1 AND kind = 'reminder_24h') AS had`, [id]);
      await cancelPendingNotifications(tx, id, ['reminder_24h']);
      if (r!.had && a.phone_e164) await insertReminder(tx, id, a.phone_e164, newStart, settings.reminder_offset_hours);
      if (input.notifyCustomer && a.phone_e164 && newStart > new Date()) {
        await insertNotification(tx, id, 'reschedule', a.phone_e164, null);
      }
    }
    if (newStatus === 'completed' || newStatus === 'no_show') await cancelPendingNotifications(tx, id, ['reminder_24h']);

    if (timeChanged || stationChanged || service) await outbox(tx, id, 'appointment.updated');
    await audit(tx, { actor: 'admin', adminId: ctx.adminId, action: 'appointment.update', entityType: 'appointment', entityId: id, ip: ctx.ip,
      changes: {
        ...(timeChanged && { startsAt: [a.starts_at, newStart], endsAt: [a.ends_at, newEnd] }),
        ...(stationId !== a.station_id && { stationId: [a.station_id, stationId] }),
        ...(newStatus !== a.status && { status: [a.status, newStatus] }),
        ...(service && { serviceId: [a.service_id, service.id] }),
        ...(input.customerNotes !== undefined && { customerNotes: 'changed' }),
        ...(input.adminNotes !== undefined && { adminNotes: 'changed' }),
      } });

    return getAppointmentDetail(tx, id);
  });
}

// ======================================================================================
//  Anulowanie — zwalnia stanowisko, więc nie wymaga blokady dnia
// ======================================================================================
export async function cancelAppointment(
  id: string, input: { lockVersion?: number; reason?: string; notifyCustomer: boolean }, ctx: AdminCtx,
) {
  return withTransaction(async (tx) => {
    const { rows: [a] } = await tx.query<LockedAppt>(
      `SELECT a.id, a.status, a.lock_version, a.starts_at, a.ends_at, a.station_id, a.service_id, c.phone_e164
         FROM appointments a JOIN customers c ON c.id = a.customer_id
        WHERE a.id = $1 FOR UPDATE OF a`, [id]);
    if (!a) throw notFound();
    if (input.lockVersion !== undefined && a.lock_version !== input.lockVersion) throw stale(a.lock_version);
    if (a.status === 'cancelled') throw new AppError(409, 'ALREADY_CANCELLED', 'Wizyta jest już anulowana');
    if (a.status !== 'confirmed') throw new AppError(409, 'CANNOT_CANCEL', 'Można anulować tylko potwierdzoną wizytę');

    await tx.query(
      `UPDATE appointments SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'admin',
              cancellation_reason = $2, lock_version = lock_version + 1 WHERE id = $1`,
      [id, input.reason || null]);
    await cancelPendingNotifications(tx, id, ['confirmation', 'reminder_24h', 'reschedule']);
    if (input.notifyCustomer && a.phone_e164 && a.starts_at > new Date()) {
      await insertNotification(tx, id, 'cancellation', a.phone_e164, null);
    }
    await outbox(tx, id, 'appointment.cancelled');
    await audit(tx, { actor: 'admin', adminId: ctx.adminId, action: 'appointment.cancel', entityType: 'appointment', entityId: id, ip: ctx.ip,
      changes: { notified: input.notifyCustomer } });
    return getAppointmentDetail(tx, id);
  });
}

// ======================================================================================
//  Odczyt
// ======================================================================================
export async function getAppointmentDetail(db: Db, id: string) {
  const { rows: [a] } = await db.query(
    `SELECT a.id, a.reference_code AS "referenceCode", a.status, a.source,
            a.starts_at AS "startsAt", a.ends_at AS "endsAt", a.station_id AS "stationId", s.name AS "stationName",
            a.service_id AS "serviceId", a.service_name_snapshot AS "serviceName",
            a.price_from_snapshot::float AS "priceFromPln",
            a.customer_notes AS "customerNotes", a.admin_notes AS "adminNotes",
            a.booked_full_name AS "bookedFullName",
            a.cancelled_at AS "cancelledAt", a.cancelled_by AS "cancelledBy", a.cancellation_reason AS "cancellationReason",
            a.lock_version AS "lockVersion", a.created_at AS "createdAt",
            json_build_object('id', c.id, 'fullName', c.full_name, 'phone', c.phone_e164,
              'whatsappOptIn', EXISTS (SELECT 1 FROM customer_consents cc JOIN legal_documents d ON d.id = cc.document_id
                                        WHERE cc.customer_id = c.id AND d.kind = 'whatsapp' AND cc.withdrawn_at IS NULL)) AS customer,
            json_build_object('id', v.id, 'make', v.make, 'model', v.model,
                              'registrationNumber', v.registration_number, 'tireSize', v.tire_size) AS vehicle,
            (SELECT coalesce(json_agg(json_build_object(
                      'kind', n.kind, 'status', n.status, 'channel', n.channel, 'scheduledFor', n.scheduled_for,
                      'sentAt', n.sent_at, 'deliveredAt', n.delivered_at, 'readAt', n.read_at, 'errorCode', n.error_code)
                    ORDER BY n.created_at), '[]')
               FROM notifications n WHERE n.appointment_id = a.id) AS notifications
       FROM appointments a
       JOIN stations s ON s.id = a.station_id
       JOIN customers c ON c.id = a.customer_id
       JOIN vehicles v ON v.id = a.vehicle_id
      WHERE a.id = $1`, [id]);
  if (!a) throw notFound();
  return a;
}

export async function getCalendar(from: string, to: string, includeCancelled: boolean) {
  const settings = await getSettings();
  const tz = settings.timezone;
  const range: string[] = [from, to, tz];
  const RANGE_SQL = `($1::date::timestamp AT TIME ZONE $3)`;
  const RANGE_END_SQL = `(($2::date + 1)::timestamp AT TIME ZONE $3)`;

  const [stations, hours, appointments, blocks] = await Promise.all([
    pool.query(`SELECT id, name, is_active AS "isActive" FROM stations ORDER BY sort_order, id`),
    pool.query(
      `WITH days AS (SELECT d::date AS day FROM generate_series($1::date, $2::date, interval '1 day') d)
       SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
              (d.day + e.opens_at) AT TIME ZONE $3 AS "opensAt", (d.day + e.closes_at) AT TIME ZONE $3 AS "closesAt",
              e.reason
         FROM days d JOIN schedule_exceptions e ON e.day = d.day WHERE e.opens_at IS NOT NULL
       UNION ALL
       SELECT to_char(d.day, 'YYYY-MM-DD'), (d.day + bh.opens_at) AT TIME ZONE $3, (d.day + bh.closes_at) AT TIME ZONE $3, NULL
         FROM days d JOIN business_hours bh ON bh.iso_weekday = EXTRACT(ISODOW FROM d.day)::int
        WHERE NOT EXISTS (SELECT 1 FROM schedule_exceptions e WHERE e.day = d.day)
       ORDER BY 2`, range),
    pool.query(
      `SELECT id, reference_code AS "referenceCode", starts_at AS "startsAt", ends_at AS "endsAt", status, source,
              station_id AS "stationId", service_id AS "serviceId", service_name AS "serviceName",
              customer_id AS "customerId", full_name AS "customerName", phone_e164 AS "phone",
              make, model, registration_number AS "registrationNumber", lock_version AS "lockVersion"
         FROM v_admin_calendar
        WHERE starts_at < ${RANGE_END_SQL} AND ends_at > ${RANGE_SQL}
          AND ($4 OR status <> 'cancelled')
        ORDER BY starts_at, station_id`, [...range, includeCancelled]),
    pool.query(
      `SELECT id, station_id AS "stationId", lower(during) AS "startsAt", upper(during) AS "endsAt", reason
         FROM station_blocks
        WHERE during && tstzrange(${RANGE_SQL}, ${RANGE_END_SQL}, '[)')
        ORDER BY lower(during)`, range),
  ]);

  return { timezone: tz, stations: stations.rows, openingHours: hours.rows, appointments: appointments.rows, blocks: blocks.rows };
}

// ======================================================================================
//  Blokady stanowisk (awaria, urlop, święto nieujęte w grafiku)
// ======================================================================================
export async function createBlock(
  input: { stationId: number | null; startsAt: string; endsAt: string; reason?: string }, ctx: AdminCtx,
) {
  const settings = await getSettings();
  const start = new Date(input.startsAt);
  const end = new Date(input.endsAt);
  if (end.getTime() - start.getTime() > 31 * 86_400_000) {
    throw new AppError(422, 'BLOCK_TOO_LONG', 'Blokada może trwać maks. 31 dni (dłuższe przerwy: wyjątki w grafiku)');
  }
  return withTransaction(async (tx) => {
    await tx.query(`SET LOCAL lock_timeout = '5s'`);
    // blokujemy wszystkie dotknięte dni, żeby równoległa rezerwacja online nie „wskoczyła” w blokadę
    const { rows: days } = await tx.query<{ day: string }>(
      `SELECT to_char(d, 'YYYY-MM-DD') AS day FROM generate_series(
         ($1::timestamptz AT TIME ZONE $3)::date, (($2::timestamptz - interval '1 microsecond') AT TIME ZONE $3)::date, '1 day') d`,
      [start, end, settings.timezone]);
    await lockDays(tx, days.map((d) => d.day));

    const { rows: [b] } = await tx.query<{ id: string }>(
      `INSERT INTO station_blocks (station_id, during, reason, created_by)
       VALUES ($1, tstzrange($2, $3, '[)'), $4, $5) RETURNING id`,
      [input.stationId, start, end, input.reason || null, ctx.adminId]);

    // nie odrzucamy blokady — zwracamy kolidujące wizyty, żeby admin mógł je przenieść
    const { rows: conflicts } = await tx.query(
      `SELECT id, reference_code AS "referenceCode", starts_at AS "startsAt", station_id AS "stationId"
         FROM appointments
        WHERE status = 'confirmed' AND ($1::smallint IS NULL OR station_id = $1)
          AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2, $3, '[)')
        ORDER BY starts_at`, [input.stationId, start, end]);

    await audit(tx, { actor: 'admin', adminId: ctx.adminId, action: 'block.create', entityType: 'station_block', entityId: b!.id, ip: ctx.ip,
      changes: { stationId: input.stationId, startsAt: start, endsAt: end, conflicts: conflicts.length } });
    return { id: b!.id, conflicts };
  });
}

export async function deleteBlock(id: string, ctx: AdminCtx) {
  const { rowCount } = await pool.query('DELETE FROM station_blocks WHERE id = $1', [id]);
  if (!rowCount) throw new AppError(404, 'BLOCK_NOT_FOUND', 'Nie znaleziono blokady');
  await audit(pool, { actor: 'admin', adminId: ctx.adminId, action: 'block.delete', entityType: 'station_block', entityId: id, ip: ctx.ip });
}

// ======================================================================================
//  Pomocnicze: powiadomienia i outbox (wykonuje je worker po commicie)
// ======================================================================================
type Kind = 'confirmation' | 'reminder_24h' | 'reschedule' | 'cancellation';

async function insertNotification(tx: pg.PoolClient, appointmentId: string, kind: Kind, phone: string, at: Date | null) {
  await tx.query(
    `INSERT INTO notifications (appointment_id, kind, recipient_e164, scheduled_for)
     VALUES ($1, $2, $3, COALESCE($4, now()))`, [appointmentId, kind, phone, at]);
}

async function insertReminder(tx: pg.PoolClient, appointmentId: string, phone: string, startsAt: Date, offsetHours: number) {
  const at = new Date(startsAt.getTime() - offsetHours * 3_600_000);
  if (at > new Date()) await insertNotification(tx, appointmentId, 'reminder_24h', phone, at);
}

async function cancelPendingNotifications(tx: pg.PoolClient, appointmentId: string, kinds: Kind[]) {
  await tx.query(
    `UPDATE notifications SET status = 'cancelled'
      WHERE appointment_id = $1 AND status = 'pending' AND kind = ANY($2::notification_kind[])`,
    [appointmentId, kinds]);
}

async function outbox(tx: pg.PoolClient, appointmentId: string, type: string) {
  await tx.query(`INSERT INTO outbox_events (aggregate_id, event_type, payload) VALUES ($1, $2, $3)`,
    [appointmentId, type, { appointmentId }]);
}
