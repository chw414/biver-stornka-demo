import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CookieOptions, Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { config } from '../../config.js';

const jwtKey = new TextEncoder().encode(config.JWT_SECRET);
const ISSUER = 'serwis-api';
const AUDIENCE = 'serwis-admin';

export interface AccessClaims {
  sub: string;  // admin id
  sid: string;  // admin_sessions.id
  tv: number;   // admins.token_version
  role: 'owner' | 'staff';
}

export async function signAccessToken(c: AccessClaims): Promise<string> {
  return new SignJWT({ sid: c.sid, tv: c.tv, role: c.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(c.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${config.ACCESS_TOKEN_TTL_MIN}m`)
    .sign(jwtKey);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, jwtKey, { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string' || typeof payload.tv !== 'number') return null;
    if (payload.role !== 'owner' && payload.role !== 'staff') return null;
    return { sub: payload.sub, sid: payload.sid, tv: payload.tv, role: payload.role };
  } catch {
    return null;
  }
}

/** Refresh token: 256 bitów losowości; w bazie tylko SHA-256 (wyciek bazy ≠ przejęcie sesji). */
export function newRefreshToken(): { raw: string; hash: Buffer } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: sha256(raw) };
}
export const sha256 = (s: string) => createHash('sha256').update(s).digest();

/**
 * Token CSRF powiązany z sesją: HMAC(CSRF_SECRET, sessionId).
 * Frontend dostaje go w JSON (login/refresh/me), trzyma w pamięci i wysyła w X-CSRF-Token.
 * Atakujący z innej domeny nie zna sessionId ani sekretu, więc nie podrobi nagłówka.
 */
export const csrfTokenFor = (sid: string) => createHmac('sha256', config.CSRF_SECRET).update(sid).digest('base64url');

export function verifyCsrfToken(sid: string, token: string | undefined): boolean {
  if (!token) return false;
  const expected = Buffer.from(csrfTokenFor(sid));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// ---------- Ciasteczka ----------
// __Host-  : tylko Secure, Path=/, bez Domain — nie da się go nadpisać z subdomeny
// __Secure-: tylko Secure; refresh token wysyłany WYŁĄCZNIE do /api/admin/auth
export const COOKIE = {
  access: config.cookieSecure ? '__Host-sa_at' : 'sa_at',
  refresh: config.cookieSecure ? '__Secure-sa_rt' : 'sa_rt',
};
const REFRESH_PATH = '/api/admin/auth';

const base = (): CookieOptions => ({ httpOnly: true, secure: config.cookieSecure, sameSite: 'strict' });

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
  res.cookie(COOKIE.access, accessToken, { ...base(), path: '/', maxAge: config.ACCESS_TOKEN_TTL_MIN * 60_000 });
  res.cookie(COOKIE.refresh, refreshToken, { ...base(), path: REFRESH_PATH, maxAge: config.REFRESH_TOKEN_TTL_DAYS * 86_400_000 });
}

export function clearAuthCookies(res: Response) {
  res.clearCookie(COOKIE.access, { ...base(), path: '/' });
  res.clearCookie(COOKIE.refresh, { ...base(), path: REFRESH_PATH });
}
