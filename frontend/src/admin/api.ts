import { ApiError, api } from '../shared/api';

/**
 * Klient API panelu admina.
 * - Token CSRF tylko w pamięci (nie w localStorage — XSS nie wykradnie go z magazynu).
 * - 401 → jedna próba odświeżenia sesji (refresh token w ciasteczku HttpOnly) i powtórzenie żądania.
 * - Odświeżanie "single-flight": równoległe żądania czekają na to samo odświeżenie.
 */
let csrfToken: string | null = null;
let onSessionLost: () => void = () => undefined;

export const setCsrfToken = (t: string | null) => { csrfToken = t; };
export const setSessionLostHandler = (fn: () => void) => { onSessionLost = fn; };

let refreshing: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const r = await api<{ csrfToken: string }>('/admin/auth/refresh', { method: 'POST' });
      setCsrfToken(r.csrfToken);
      return true;
    } catch (e) {
      // druga karta właśnie odświeżyła sesję — ciasteczka są już nowe, brakuje tylko tokenu CSRF
      if (e instanceof ApiError && e.code === 'REFRESH_RACE') {
        const me = await api<{ csrfToken: string }>('/admin/auth/me').catch(() => null);
        if (me) { setCsrfToken(me.csrfToken); return true; }
      }
      return false;
    } finally {
      setTimeout(() => { refreshing = null; }, 0);
    }
  })();
  return refreshing;
}

const SAFE = new Set(['GET', 'HEAD']);

export async function adminApi<T>(path: string, init: RequestInit & { json?: unknown } = {}, retried = false): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (!SAFE.has(method) && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  try {
    return await api<T>(`/admin${path}`, { ...init, headers });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && !retried) {
      if (await refreshSession()) return adminApi<T>(path, init, true);
      onSessionLost();
    }
    // token CSRF nieaktualny (np. po rotacji sesji w innej karcie) — pobierz bieżący i spróbuj raz jeszcze
    if (e instanceof ApiError && e.code === 'CSRF_TOKEN_INVALID' && !retried) {
      const me = await api<{ csrfToken: string }>('/admin/auth/me').catch(() => null);
      if (me) { setCsrfToken(me.csrfToken); return adminApi<T>(path, init, true); }
    }
    throw e;
  }
}
