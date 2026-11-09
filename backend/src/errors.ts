export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const Errors = {
  slotTaken: () =>
    new AppError(409, 'SLOT_TAKEN', 'Ten termin został właśnie zajęty. Wybierz inną godzinę.'),
  invalidSlot: () =>
    new AppError(422, 'SLOT_UNAVAILABLE', 'Wybrany termin jest niedostępny (poza godzinami pracy lub zbyt blisko).'),
  serviceNotFound: () => new AppError(404, 'SERVICE_NOT_FOUND', 'Wybrana usługa nie istnieje lub jest nieaktywna.'),
  idempotencyMismatch: () =>
    new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'Ten klucz idempotencji został użyty dla innej rezerwacji.'),
  phoneNotVerified: () => new AppError(403, 'PHONE_NOT_VERIFIED', 'Numer telefonu nie został zweryfikowany.'),
  busy: () => new AppError(503, 'BUSY', 'System jest chwilowo przeciążony. Spróbuj ponownie za chwilę.'),
  misconfigured: (what: string) => new AppError(500, 'MISCONFIGURED', `Błąd konfiguracji serwisu: ${what}`),
};

/** Mapowanie kodów SQLSTATE PostgreSQL na błędy domenowe. */
export function mapPgError(err: unknown): AppError | null {
  if (typeof err !== 'object' || err === null || !('code' in err)) return null;
  const e = err as { code?: string; constraint?: string };
  switch (e.code) {
    case '23P01': // exclusion_violation — ostatnia linia obrony przed podwójną rezerwacją
      if (e.constraint === 'appt_no_overlap_per_station') return Errors.slotTaken();
      return null;
    case '23505': // unique_violation
      if (e.constraint === 'appointments_idempotency_key_key') return Errors.idempotencyMismatch();
      if (e.constraint === 'customers_phone_e164_key')
        return new AppError(409, 'PHONE_IN_USE', 'Ten numer telefonu jest już przypisany do innego klienta');
      if (e.constraint === 'vehicles_unique_per_customer')
        return new AppError(409, 'VEHICLE_EXISTS', 'Klient ma już pojazd o tym numerze rejestracyjnym');
      return null;
    case 'P0001': // RAISE EXCEPTION z funkcji w bazie (np. anonymize_customer) — komunikat jest nasz
      return new AppError(409, 'BUSINESS_RULE', (err as { message?: string }).message ?? 'Operacja niedozwolona');
    case '55P03': // lock_not_available (lock_timeout)
    case '40P01': // deadlock_detected
    case '57014': // query_canceled (statement_timeout)
      return Errors.busy();
    default:
      return null;
  }
}
