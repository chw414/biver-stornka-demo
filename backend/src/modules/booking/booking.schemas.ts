import { z } from 'zod';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

// Usuwa znaki sterujące i normalizuje Unicode (np. "é" złożone vs rozłożone)
const clean = (s: string) => s.normalize('NFC').replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E]/g, '').trim();
const collapseSpaces = (s: string) => s.replace(/\s+/g, ' ');

export const FullNameSchema = z
  .string()
  .transform((s) => collapseSpaces(clean(s)))
  .pipe(
    z.string()
      .min(3, 'Podaj imię i nazwisko')
      .max(120)
      .regex(/^\p{L}[\p{L}\p{M} .'’-]*\p{L}$/u, 'Imię i nazwisko może zawierać tylko litery, spacje, myślnik i apostrof'),
  );

/** Telefon → E.164. Domyślnie numer polski; wymagamy komórki, bo wysyłamy SMS-y. */
export const PhoneSchema = z.string().max(32).transform((raw, ctx) => {
  const phone = parsePhoneNumberFromString(clean(raw), 'PL');
  if (!phone || !phone.isValid()) {
    ctx.addIssue({ code: 'custom', message: 'Niepoprawny numer telefonu' });
    return z.NEVER;
  }
  const type = phone.getType();
  if (type !== 'MOBILE' && type !== 'FIXED_LINE_OR_MOBILE') {
    ctx.addIssue({ code: 'custom', message: 'Podaj numer telefonu komórkowego (potrzebny do SMS)' });
    return z.NEVER;
  }
  return phone.number; // E.164, np. +48600100200
});

/** Tablica: wielkie litery, bez spacji i myślników. PL: 4–8 znaków; dopuszczamy też zagraniczne (2–10). */
export const RegistrationSchema = z
  .string()
  .max(20)
  .transform((s) => clean(s).toUpperCase().replace(/[\s-]/g, ''))
  .pipe(
    z.string().regex(/^(?=.*[A-Z])[A-Z0-9]{2,10}$/, 'Niepoprawny numer rejestracyjny'),
  );

export const VehicleText = (max: number, label: string) =>
  z.string()
    .transform((s) => collapseSpaces(clean(s)))
    .pipe(
      z.string()
        .min(1, `Podaj ${label}`)
        .max(max)
        .regex(/^[\p{L}\p{N}][\p{L}\p{N}\p{M} .+/-]*$/u, `Niepoprawna wartość pola: ${label}`),
    );

export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format daty: RRRR-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Niepoprawna data');

export const VehicleInputSchema = z.object({
  make: VehicleText(50, 'markę pojazdu'),
  model: VehicleText(60, 'model pojazdu'),
  registrationNumber: RegistrationSchema,
}).strict();

export const NotesSchema = (max: number) => z.string().transform(clean).pipe(z.string().max(max));

// ---------- Żądania ----------

export const AvailabilityQuerySchema = z.object({
  serviceId: z.coerce.number().int().positive(),
  date: IsoDateSchema,
}).strict();

export const AvailableDaysQuerySchema = z.object({
  serviceId: z.coerce.number().int().positive(),
  from: IsoDateSchema,
  to: IsoDateSchema,
}).strict().refine((q) => q.from <= q.to, { message: '"from" musi być ≤ "to"', path: ['to'] });

export const CreateBookingSchema = z.object({
  serviceId: z.number().int().positive(),
  startsAt: z.iso.datetime({ offset: true }),
  fullName: FullNameSchema,
  phone: PhoneSchema,
  vehicle: VehicleInputSchema,
  notes: z.string().transform(clean).pipe(z.string().max(500)).optional(),
  acceptTerms: z.literal(true, { error: 'Akceptacja regulaminu i polityki prywatności jest wymagana' }),
  // osobny, NIEzaznaczony domyślnie checkbox: "Chcę otrzymać potwierdzenie i przypomnienie na WhatsApp od <firma>"
  whatsappOptIn: z.boolean().default(false),
  // Miejsce na przyszłe OTP: token wydany po weryfikacji kodu SMS. Dziś ignorowany.
  verificationToken: z.string().max(512).optional(),
}).strict();

export type CreateBookingInput = z.infer<typeof CreateBookingSchema>;

export const IdempotencyKeySchema = z.uuid({ error: 'Nagłówek Idempotency-Key musi być UUID' });
