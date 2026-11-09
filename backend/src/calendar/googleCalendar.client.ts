import { readFile } from 'node:fs/promises';
import { JWT } from 'google-auth-library';

export interface CalendarEventInput {
  summary: string;
  description: string;
  start: Date;
  end: Date;
  timeZone: string;
  appointmentId: string;
}

export class CalendarApiError extends Error {
  constructor(readonly httpStatus: number, message: string, readonly retryable: boolean) { super(message); }
}

/**
 * Klient REST Google Calendar v3 (bez ciężkiej biblioteki googleapis).
 * Konfiguracja: konto serwisowe w Google Cloud + kalendarz firmy udostępniony temu kontu
 * z uprawnieniem "Wprowadzanie zmian w wydarzeniach". Delegacja domenowa NIE jest potrzebna.
 */
export class GoogleCalendarClient {
  constructor(
    private readonly calendarId: string,
    private readonly getToken: () => Promise<string>,
    private readonly baseUrl = 'https://www.googleapis.com',
  ) {}

  static async fromServiceAccount(keyFile: string, calendarId: string, baseUrl?: string) {
    const key = JSON.parse(await readFile(keyFile, 'utf8')) as { client_email: string; private_key: string };
    const jwt = new JWT({ email: key.client_email, key: key.private_key, scopes: ['https://www.googleapis.com/auth/calendar.events'] });
    return new GoogleCalendarClient(calendarId, async () => {
      const { token } = await jwt.getAccessToken(); // biblioteka cache'uje i odświeża token
      if (!token) throw new CalendarApiError(401, 'Brak tokenu Google', true);
      return token;
    }, baseUrl);
  }

  /** Deterministyczne id eventu: UUID wizyty bez myślników (dozwolone znaki base32hex: 0-9, a-v). */
  static eventIdFor(appointmentId: string) {
    return appointmentId.replace(/-/g, '').toLowerCase();
  }

  private url(eventId?: string) {
    const base = `${this.baseUrl}/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events`;
    return eventId ? `${base}/${eventId}` : base;
  }

  private async call(method: string, url: string, body?: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${await this.getToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new CalendarApiError(0, `Sieć: ${err instanceof Error ? err.message : String(err)}`, true);
    }
    return res;
  }

  private async fail(res: Response): Promise<never> {
    const text = await res.text().catch(() => '');
    // 403 rateLimitExceeded/userRateLimitExceeded, 429 i 5xx są chwilowe
    const retryable = res.status >= 500 || res.status === 429 || (res.status === 403 && /rate ?limit/i.test(text)) || res.status === 401;
    throw new CalendarApiError(res.status, `Google Calendar ${res.status}: ${text.slice(0, 300)}`, retryable);
  }

  /**
   * Utwórz lub zaktualizuj. PATCH przywraca też event usunięty wcześniej (status "confirmed").
   * 404 → event nie istnieje → INSERT z naszym id; 409 przy INSERT → ktoś (my, przy poprzedniej próbie) zdążył go utworzyć → PATCH.
   */
  async upsert(e: CalendarEventInput): Promise<string> {
    const id = GoogleCalendarClient.eventIdFor(e.appointmentId);
    const resource = {
      summary: e.summary,
      description: e.description,
      start: { dateTime: e.start.toISOString(), timeZone: e.timeZone },
      end: { dateTime: e.end.toISOString(), timeZone: e.timeZone },
      status: 'confirmed',
      extendedProperties: { private: { appointmentId: e.appointmentId } },
      reminders: { useDefault: false, overrides: [] }, // bez powiadomień Google dla każdej wizyty
    };
    let res = await this.call('PATCH', this.url(id), resource);
    if (res.status === 404) {
      res = await this.call('POST', this.url(), { id, ...resource });
      if (res.status === 409) res = await this.call('PATCH', this.url(id), resource);
    }
    if (!res.ok) await this.fail(res);
    return id;
  }

  /** Usuń; 404/410 (już usunięty) traktujemy jako sukces — operacja idempotentna. */
  async remove(appointmentId: string): Promise<void> {
    const res = await this.call('DELETE', this.url(GoogleCalendarClient.eventIdFor(appointmentId)));
    if (res.ok || res.status === 404 || res.status === 410) return;
    await this.fail(res);
  }
}
