/** Błąd z API w formacie { error, message, details } (patrz backend: errorHandler.ts). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
  /** Błędy walidacji pól: { "vehicle.registrationNumber": "Niepoprawny numer rejestracyjny", ... } */
  fieldErrors(): Record<string, string> {
    if (this.code !== 'VALIDATION_ERROR' || !Array.isArray(this.details)) return {};
    return Object.fromEntries((this.details as { path: string; message: string }[]).map((d) => [d.path, d.message]));
  }
}

export const NETWORK_ERROR = 'NETWORK';

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...rest,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiError(0, NETWORK_ERROR, 'Brak połączenia z internetem. Sprawdź zasięg i spróbuj ponownie.');
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const retryAfter = Number(res.headers.get('Retry-After')) || undefined;
    throw new ApiError(res.status, body?.error ?? `HTTP_${res.status}`, body?.message ?? 'Coś poszło nie tak. Spróbuj ponownie.', body?.details, retryAfter);
  }
  return body as T;
}
