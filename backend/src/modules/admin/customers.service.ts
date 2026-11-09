import { z } from 'zod';
import { pool, withTransaction } from '../../db.js';
import { AppError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import { FullNameSchema, NotesSchema, PhoneSchema, RegistrationSchema, VehicleText } from '../booking/booking.schemas.js';
import type { AdminCtx } from './appointments.service.js';
import { grantWhatsAppConsent, withdrawWhatsAppConsent } from '../consents/whatsappConsent.js';

export const CustomerSearchSchema = z.object({
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
}).strict();

export const UpdateCustomerSchema = z.object({
  fullName: FullNameSchema.optional(),
  phone: PhoneSchema.optional(),
  adminNotes: NotesSchema(2000).nullable().optional(),
  whatsappOptIn: z.boolean().optional(), // true = zgoda zebrana przez admina, false = wycofanie (np. prośba telefoniczna)
}).strict();

export const UpdateVehicleSchema = z.object({
  make: VehicleText(50, 'markę pojazdu').optional(),
  model: VehicleText(60, 'model pojazdu').optional(),
  registrationNumber: RegistrationSchema.optional(),
  tireSize: z.string().transform((s) => s.trim().toUpperCase()).pipe(
    z.string().regex(/^[0-9A-Z/ .,-]{3,20}$/, 'Np. 205/55 R16')).nullable().optional(),
  notes: NotesSchema(2000).nullable().optional(),
}).strict();

const notFound = () => new AppError(404, 'CUSTOMER_NOT_FOUND', 'Nie znaleziono klienta');
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Wyszukiwanie po fragmencie imienia/nazwiska, numeru telefonu lub tablicy rejestracyjnej.
 * Parametryzowane zapytanie + escapowanie znaków wieloznacznych LIKE (% i _ z inputu traktowane dosłownie).
 */
export async function searchCustomers(p: z.infer<typeof CustomerSearchSchema>) {
  const q = p.q?.trim() || null;
  const digits = q?.replace(/\D/g, '') ?? '';
  const plate = q?.toUpperCase().replace(/[\s-]/g, '') ?? '';
  const { rows } = await pool.query(
    `SELECT o.id, o.full_name AS "fullName", o.phone_e164 AS phone, o.created_at AS "createdAt",
            o.vehicles_count AS "vehiclesCount", o.completed_visits AS "completedVisits", o.no_shows AS "noShows",
            o.last_visit_at AS "lastVisitAt", o.next_visit_at AS "nextVisitAt",
            (SELECT coalesce(array_agg(v.registration_number ORDER BY v.created_at), '{}')
               FROM vehicles v WHERE v.customer_id = o.id AND v.registration_number IS NOT NULL) AS plates,
            count(*) OVER () AS total
       FROM v_customer_overview o
      WHERE $1::text IS NULL
         OR o.full_name ILIKE '%' || $1 || '%'
         OR ($2::text IS NOT NULL AND o.phone_e164 LIKE '%' || $2 || '%')
         OR ($3::text IS NOT NULL AND EXISTS (
               SELECT 1 FROM vehicles v WHERE v.customer_id = o.id AND v.registration_number LIKE '%' || $3 || '%'))
      ORDER BY o.next_visit_at NULLS LAST, o.last_visit_at DESC NULLS LAST, o.created_at DESC
      LIMIT $4 OFFSET $5`,
    [q && escapeLike(q), digits.length >= 3 ? digits : null, plate.length >= 2 ? escapeLike(plate) : null, p.limit, p.offset],
  );
  return {
    total: rows.length ? Number(rows[0].total) : 0,
    customers: rows.map(({ total: _t, ...r }) => ({ ...r, vehiclesCount: Number(r.vehiclesCount), completedVisits: Number(r.completedVisits), noShows: Number(r.noShows) })),
  };
}

/** Karta klienta: dane, pojazdy z historią wizyt. Odczyt danych osobowych jest audytowany (RODO). */
export async function getCustomer(id: string, ctx: AdminCtx) {
  const { rows: [c] } = await pool.query(
    `SELECT id, full_name AS "fullName", phone_e164 AS phone, admin_notes AS "adminNotes",
            created_at AS "createdAt", anonymized_at AS "anonymizedAt",
            EXISTS (SELECT 1 FROM customer_consents cc JOIN legal_documents d ON d.id = cc.document_id
                     WHERE cc.customer_id = customers.id AND d.kind = 'whatsapp' AND cc.withdrawn_at IS NULL) AS "whatsappOptIn"
       FROM customers WHERE id = $1`, [id]);
  if (!c) throw notFound();

  const [vehicles, appointments, consents] = await Promise.all([
    pool.query(
      `SELECT id, make, model, registration_number AS "registrationNumber", tire_size AS "tireSize", notes, created_at AS "createdAt"
         FROM vehicles WHERE customer_id = $1 ORDER BY created_at`, [id]),
    pool.query(
      `SELECT id, reference_code AS "referenceCode", vehicle_id AS "vehicleId", starts_at AS "startsAt", ends_at AS "endsAt",
              status, source, service_name_snapshot AS "serviceName", admin_notes AS "adminNotes", station_id AS "stationId"
         FROM appointments WHERE customer_id = $1 ORDER BY starts_at DESC LIMIT 200`, [id]),
    pool.query(
      `SELECT d.kind, d.version, cc.granted_at AS "grantedAt", cc.withdrawn_at AS "withdrawnAt"
         FROM customer_consents cc JOIN legal_documents d ON d.id = cc.document_id
        WHERE cc.customer_id = $1 ORDER BY cc.granted_at DESC LIMIT 20`, [id]),
  ]);

  await audit(pool, { actor: 'admin', adminId: ctx.adminId, action: 'customer.view', entityType: 'customer', entityId: id, ip: ctx.ip });
  return { ...c, vehicles: vehicles.rows, appointments: appointments.rows, consents: consents.rows };
}

export async function updateCustomer(id: string, input: z.infer<typeof UpdateCustomerSchema>, ctx: AdminCtx) {
  return withTransaction(async (tx) => {
    const { rows: [c] } = await tx.query(
      `UPDATE customers
          SET full_name   = COALESCE($2, full_name),
              phone_e164  = COALESCE($3, phone_e164),
              admin_notes = CASE WHEN $4 THEN $5 ELSE admin_notes END
        WHERE id = $1 AND anonymized_at IS NULL
        RETURNING id, full_name AS "fullName", phone_e164 AS phone, admin_notes AS "adminNotes"`,
      [id, input.fullName ?? null, input.phone ?? null, input.adminNotes !== undefined, input.adminNotes ?? null]);
    if (!c) throw notFound();
    if (input.phone) {
      // nowy numer także w oczekujących SMS-ach
      await tx.query(
        `UPDATE notifications n SET recipient_e164 = $2
           FROM appointments a WHERE a.id = n.appointment_id AND a.customer_id = $1 AND n.status = 'pending'`,
        [id, input.phone]);
    }
    if (input.whatsappOptIn === true) await grantWhatsAppConsent(tx, { customerId: id, adminId: ctx.adminId });
    if (input.whatsappOptIn === false) await withdrawWhatsAppConsent(tx, id);
    await audit(tx, { actor: 'admin', adminId: ctx.adminId, action: 'customer.update', entityType: 'customer', entityId: id, ip: ctx.ip,
      changes: { fields: Object.keys(input) } });
    return c;
  });
}

export async function updateVehicle(id: string, input: z.infer<typeof UpdateVehicleSchema>, ctx: AdminCtx) {
  const set = (k: keyof typeof input) => input[k] !== undefined;
  const { rows: [v] } = await pool.query(
    `UPDATE vehicles v
        SET make = COALESCE($2, v.make),
            model = COALESCE($3, v.model),
            registration_number = COALESCE($4, v.registration_number),
            tire_size = CASE WHEN $5 THEN $6 ELSE v.tire_size END,
            notes = CASE WHEN $7 THEN $8 ELSE v.notes END
       FROM customers c
      WHERE v.id = $1 AND c.id = v.customer_id AND c.anonymized_at IS NULL
      RETURNING v.id, v.customer_id AS "customerId", v.make, v.model,
                v.registration_number AS "registrationNumber", v.tire_size AS "tireSize", v.notes`,
    [id, input.make ?? null, input.model ?? null, input.registrationNumber ?? null,
     set('tireSize'), input.tireSize ?? null, set('notes'), input.notes ?? null]);
  if (!v) throw new AppError(404, 'VEHICLE_NOT_FOUND', 'Nie znaleziono pojazdu');
  await audit(pool, { actor: 'admin', adminId: ctx.adminId, action: 'vehicle.update', entityType: 'vehicle', entityId: id, ip: ctx.ip,
    changes: { fields: Object.keys(input) } });
  return v;
}

/** Prawo do usunięcia danych (art. 17 RODO). Tylko właściciel. Wymaga wcześniejszego anulowania przyszłych wizyt. */
export async function anonymizeCustomer(id: string, ctx: AdminCtx) {
  await withTransaction(async (tx) => {
    const { rows: [c] } = await tx.query<{ anonymized_at: Date | null }>(
      'SELECT anonymized_at FROM customers WHERE id = $1 FOR UPDATE', [id]);
    if (!c) throw notFound();
    if (c.anonymized_at) throw new AppError(409, 'ALREADY_ANONYMIZED', 'Dane klienta zostały już zanonimizowane');
    await tx.query('SELECT anonymize_customer($1)', [id]);
    await audit(tx, { actor: 'admin', adminId: ctx.adminId, action: 'customer.anonymize', entityType: 'customer', entityId: id, ip: ctx.ip });
  });
}
