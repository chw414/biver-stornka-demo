import { z } from 'zod';
import { FullNameSchema, IsoDateSchema, NotesSchema, PhoneSchema, VehicleInputSchema } from '../booking/booking.schemas.js';

const Duration = z.number().int().min(15).max(480).multipleOf(15, 'Czas trwania: wielokrotność 15 min');
const Instant = z.iso.datetime({ offset: true });

/** Istniejący klient (id) albo nowy / wyszukiwany po telefonie. */
const CustomerRef = z.union([
  z.object({ customerId: z.uuid() }).strict(),
  z.object({ fullName: FullNameSchema, phone: PhoneSchema }).strict(),
]);
const VehicleRef = z.union([z.object({ vehicleId: z.uuid() }).strict(), VehicleInputSchema]);

export const CreateAdminAppointmentSchema = z.object({
  serviceId: z.number().int().positive(),
  startsAt: Instant,
  durationMinutes: Duration.optional(),        // nadpisanie domyślnego czasu usługi
  stationId: z.number().int().positive().optional(), // brak = pierwsze wolne
  source: z.enum(['phone', 'walk_in']),
  customer: CustomerRef,
  vehicle: VehicleRef,
  customerNotes: NotesSchema(500).optional(),
  adminNotes: NotesSchema(2000).optional(),
  notifyCustomer: z.boolean().default(true),   // potwierdzenie + przypomnienie
  whatsappOptIn: z.boolean().optional(),       // klient zgodził się przez telefon / na miejscu
  allowOutsideHours: z.boolean().default(false), // świadome dodanie poza godzinami pracy
}).strict();

export const UpdateAppointmentSchema = z.object({
  lockVersion: z.number().int().positive(),    // optymistyczna kontrola: dwie osoby edytujące naraz
  startsAt: Instant.optional(),
  durationMinutes: Duration.optional(),
  serviceId: z.number().int().positive().optional(),
  stationId: z.number().int().positive().optional(),
  status: z.enum(['confirmed', 'completed', 'no_show']).optional(),
  customerNotes: NotesSchema(500).nullable().optional(),
  adminNotes: NotesSchema(2000).nullable().optional(),
  notifyCustomer: z.boolean().default(true),   // wiadomość o zmianie terminu
  allowOutsideHours: z.boolean().default(false),
}).strict();

export const CancelAppointmentSchema = z.object({
  lockVersion: z.number().int().positive().optional(),
  reason: NotesSchema(300).optional(),
  notifyCustomer: z.boolean().default(true),
}).strict();

export const CalendarQuerySchema = z.object({
  from: IsoDateSchema,
  to: IsoDateSchema,
  includeCancelled: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
}).strict().refine((q) => q.from <= q.to, { message: '"from" musi być ≤ "to"', path: ['to'] });

export const CreateBlockSchema = z.object({
  stationId: z.number().int().positive().nullable(), // null = cały serwis
  startsAt: Instant,
  endsAt: Instant,
  reason: NotesSchema(200).optional(),
}).strict().refine((b) => Date.parse(b.endsAt) > Date.parse(b.startsAt), { message: 'Koniec musi być po początku', path: ['endsAt'] });

export const UuidParam = z.object({ id: z.uuid() });

export type CreateAdminAppointmentInput = z.infer<typeof CreateAdminAppointmentSchema>;
export type UpdateAppointmentInput = z.infer<typeof UpdateAppointmentSchema>;
