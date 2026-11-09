import { ApiError } from '../shared/api';

/** Komunikaty dla admina — konkretne, z tym, co zrobić dalej. */
export function adminErrorMessage(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Coś poszło nie tak. Spróbuj ponownie.';
  switch (e.code) {
    case 'SLOT_TAKEN': return 'Oba stanowiska są w tym czasie zajęte. Wybierz inną godzinę.';
    case 'STATION_TAKEN': return 'To stanowisko jest w tym czasie zajęte. Wybierz inne lub „Pierwsze wolne”.';
    case 'STALE_VERSION': return 'Ktoś właśnie zmienił tę wizytę. Pokazuję aktualną wersję — wprowadź zmianę ponownie.';
    case 'SLOT_UNAVAILABLE': return 'Termin musi zaczynać się o pełnym kwadransie.';
    case 'APPOINTMENT_NOT_STARTED': return 'Wizyta jeszcze się nie zaczęła — status ustawisz po jej rozpoczęciu.';
    case 'VALIDATION_ERROR': {
      const f = Object.values(e.fieldErrors());
      return f.length ? f.join(' ') : e.message;
    }
    default: return e.message;
  }
}
