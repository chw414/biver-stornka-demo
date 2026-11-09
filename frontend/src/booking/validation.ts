/** Walidacja po stronie przeglądarki — dla wygody. Rozstrzyga zawsze backend (Zod). */
export interface DetailsForm {
  fullName: string;
  phone: string;
  make: string;
  model: string;
  registrationNumber: string;
  notes: string;
  acceptTerms: boolean;
  whatsappOptIn: boolean;
}
export type DetailsErrors = Partial<Record<keyof DetailsForm, string>>;

export const normalizePlate = (s: string) => s.toUpperCase().replace(/[\s-]/g, '');

export function validateDetails(f: DetailsForm): DetailsErrors {
  const e: DetailsErrors = {};
  const name = f.fullName.trim().replace(/\s+/g, ' ');
  if (name.length < 3) e.fullName = 'Podaj imię i nazwisko.';
  else if (!/^\p{L}[\p{L}\p{M} .'’-]*\p{L}$/u.test(name)) e.fullName = 'Użyj tylko liter, spacji, myślnika lub apostrofu.';

  // Lekka kontrola formatu (pełna walidacja numeru, w tym "czy komórkowy", jest w backendzie —
  // biblioteka libphonenumber w przeglądarce kosztowałaby ~40 kB na każdym telefonie)
  const raw = f.phone.trim();
  const digits = raw.replace(/[\s()-]/g, '');
  if (!raw) e.phone = 'Podaj numer telefonu komórkowego.';
  else if (!(/^\+[1-9]\d{7,14}$/.test(digits) || /^(0048|48)?\d{9}$/.test(digits))) e.phone = 'Ten numer wygląda na niepełny. Sprawdź cyfry.';

  if (!f.make.trim()) e.make = 'Podaj markę, np. Toyota.';
  if (!f.model.trim()) e.model = 'Podaj model, np. Corolla.';
  const plate = normalizePlate(f.registrationNumber);
  if (!plate) e.registrationNumber = 'Podaj numer rejestracyjny.';
  else if (!/^(?=.*[A-Z])[A-Z0-9]{2,10}$/.test(plate)) e.registrationNumber = 'Użyj tylko liter i cyfr, np. WX 12345.';
  if (f.notes.length > 500) e.notes = 'Maksymalnie 500 znaków.';
  if (!f.acceptTerms) e.acceptTerms = 'Zaakceptuj regulamin, aby zarezerwować wizytę.';
  return e;
}

/** Ścieżki błędów z backendu → pola formularza. */
export const SERVER_FIELD_MAP: Record<string, keyof DetailsForm> = {
  fullName: 'fullName',
  phone: 'phone',
  'vehicle.make': 'make',
  'vehicle.model': 'model',
  'vehicle.registrationNumber': 'registrationNumber',
  notes: 'notes',
  acceptTerms: 'acceptTerms',
};
