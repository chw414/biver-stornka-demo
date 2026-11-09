import type { NextFunction, Request, Response } from 'express';
import { config } from '../../config.js';
import { pool } from '../../db.js';
import { AppError } from '../../errors.js';
import { COOKIE, verifyAccessToken, verifyCsrfToken } from './tokens.js';

export interface AdminPrincipal {
  id: string;
  sessionId: string;
  role: 'owner' | 'staff';
  email: string;
  fullName: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { admin?: AdminPrincipal }
  }
}

const unauthorized = () => new AppError(401, 'UNAUTHORIZED', 'Zaloguj się, aby kontynuować');

/**
 * Weryfikuje access token z ciasteczka HttpOnly, a następnie stan w bazie:
 * konto aktywne, token_version zgodny (unieważnianie „wyloguj wszędzie”), sesja niewylogowana.
 * Zapytanie po PK przy każdym żądaniu to ułamek milisekundy, a daje natychmiastowe odcięcie dostępu.
 */
export async function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const token: unknown = req.cookies?.[COOKIE.access];
  const claims = typeof token === 'string' ? await verifyAccessToken(token) : null;
  if (!claims) throw unauthorized();

  const { rows: [a] } = await pool.query<{ email: string; full_name: string; role: 'owner' | 'staff' }>(
    `SELECT a.email, a.full_name, a.role
       FROM admins a JOIN admin_sessions s ON s.admin_id = a.id AND s.id = $2
      WHERE a.id = $1 AND a.is_active AND a.token_version = $3
        AND (s.revoked_at IS NULL OR s.replaced_by IS NOT NULL)  -- wylogowana sesja = martwy token; zrotowana żyje do wygaśnięcia`,
    [claims.sub, claims.sid, claims.tv],
  );
  if (!a) throw unauthorized();

  req.admin = { id: claims.sub, sessionId: claims.sid, role: a.role, email: a.email, fullName: a.full_name };
  next();
}

export function getAdmin(req: Request): AdminPrincipal {
  if (!req.admin) throw unauthorized();
  return req.admin;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Sprawdzenie nagłówka Origin dla żądań zmieniających stan (także logowania — chroni przed „login CSRF”). */
export function requireTrustedOrigin(req: Request, _res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.get('Origin');
  if (!origin || !config.allowedOrigins.includes(origin)) {
    throw new AppError(403, 'FORBIDDEN_ORIGIN', 'Żądanie z niedozwolonego źródła');
  }
  next();
}

/**
 * CSRF — trzy warstwy:
 *  1. SameSite=Strict na ciasteczkach (przeglądarka nie dołączy ich do żądań z obcych stron),
 *  2. weryfikacja Origin,
 *  3. token X-CSRF-Token = HMAC(sekret, id sesji), którego obca strona nie zna.
 */
export function requireCsrf(req: Request, res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();
  requireTrustedOrigin(req, res, () => undefined);
  if (!verifyCsrfToken(getAdmin(req).sessionId, req.get('X-CSRF-Token'))) {
    throw new AppError(403, 'CSRF_TOKEN_INVALID', 'Nieprawidłowy token CSRF — odśwież stronę');
  }
  next();
}

export const requireRole = (role: 'owner') => (req: Request, _res: Response, next: NextFunction) => {
  if (getAdmin(req).role !== role) throw new AppError(403, 'FORBIDDEN', 'Brak uprawnień do tej operacji');
  next();
};

export function noStore(_req: Request, res: Response, next: NextFunction) {
  res.set('Cache-Control', 'no-store'); // dane osobowe nie mogą trafić do cache przeglądarki/proxy
  next();
}
