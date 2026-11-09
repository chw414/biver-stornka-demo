/**
 * Punkt rozszerzenia pod weryfikację numeru telefonu.
 *
 * Dziś: NoPhoneVerification (każdy numer przechodzi).
 * W przyszłości (gdy fałszywe rezerwacje staną się realnym problemem):
 *   1. tabela phone_verification_challenges (hash kodu, próby, wygaśnięcie),
 *   2. POST /api/public/phone-verification -> wysyła kod SMS,
 *      POST /api/public/phone-verification/confirm -> zwraca krótkotrwały token (np. JWT 15 min, sub = telefon),
 *   3. SmsOtpVerifier sprawdza token, app_settings.phone_verification = "sms_otp",
 *   4. frontend przesyła verificationToken w POST /bookings.
 * Kontrakt API rezerwacji i reszta logiki pozostają bez zmian.
 */
export interface PhoneVerifier {
  /** true = numer zweryfikowany (lub weryfikacja wyłączona) */
  verify(phoneE164: string, token: string | undefined): Promise<{ ok: boolean; verifiedAt: Date | null }>;
}

export class NoPhoneVerification implements PhoneVerifier {
  async verify(): Promise<{ ok: boolean; verifiedAt: Date | null }> {
    return { ok: true, verifiedAt: null };
  }
}

export function createPhoneVerifier(mode: 'none' | 'sms_otp'): PhoneVerifier {
  switch (mode) {
    case 'none':
      return new NoPhoneVerification();
    case 'sms_otp':
      throw new Error('Weryfikacja SMS OTP nie jest jeszcze zaimplementowana');
  }
}
