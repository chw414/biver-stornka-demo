import { pool, withTransaction, type Db } from '../../db.js';
import { config } from '../../config.js';
import { AppError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import { verifyPassword } from './password.js';
import { csrfTokenFor, newRefreshToken, sha256, signAccessToken } from './tokens.js';

export interface AdminPublic { id: string; email: string; fullName: string; role: 'owner' | 'staff' }
export interface IssuedSession { admin: AdminPublic; accessToken: string; refreshToken: string; csrfToken: string }
interface Ctx { ip: string | null; userAgent: string | null }

const invalidCredentials = () => new AppError(401, 'INVALID_CREDENTIALS', 'Nieprawidłowy e-mail lub hasło');
const sessionExpired = (code = 'SESSION_EXPIRED') => new AppError(401, code, 'Sesja wygasła — zaloguj się ponownie');

/** Okno, w którym ponowne użycie zrotowanego refresh tokenu traktujemy jako wyścig kart, nie kradzież. */
const REFRESH_RACE_GRACE_SEC = 30;

interface AdminRow {
  id: string; email: string; full_name: string; role: 'owner' | 'staff';
  password_hash: string; is_active: boolean; token_version: number; locked_until: Date | null;
}

const toPublic = (a: Pick<AdminRow, 'id' | 'email' | 'full_name' | 'role'>): AdminPublic =>
  ({ id: a.id, email: a.email, fullName: a.full_name, role: a.role });

async function issueSession(db: Db, a: Pick<AdminRow, 'id' | 'email' | 'full_name' | 'role' | 'token_version'>, ctx: Ctx) {
  const refresh = newRefreshToken();
  const { rows: [s] } = await db.query<{ id: string }>(
    `INSERT INTO admin_sessions (admin_id, refresh_token_hash, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(days => $5::int)) RETURNING id`,
    [a.id, refresh.hash, ctx.userAgent?.slice(0, 255) ?? null, ctx.ip, config.REFRESH_TOKEN_TTL_DAYS],
  );
  const accessToken = await signAccessToken({ sub: a.id, sid: s!.id, tv: a.token_version, role: a.role });
  return { sessionId: s!.id, session: { admin: toPublic(a), accessToken, refreshToken: refresh.raw, csrfToken: csrfTokenFor(s!.id) } };
}

export async function login(email: string, password: string, ctx: Ctx): Promise<IssuedSession> {
  const { rows: [a] } = await pool.query<AdminRow>(
    `SELECT id, email, full_name, role, password_hash, is_active, token_version, locked_until
       FROM admins WHERE email = $1`,
    [email],
  );

  // Ta sama odpowiedź i podobny czas dla: brak konta / konto wyłączone / zablokowane / złe hasło
  if (!a || !a.is_active || (a.locked_until && a.locked_until > new Date())) {
    await verifyPassword(null, password);
    if (a) await audit(pool, { actor: 'admin', adminId: a.id, action: 'auth.login_rejected', entityType: 'admin', entityId: a.id, changes: { reason: !a.is_active ? 'inactive' : 'locked' }, ip: ctx.ip });
    throw invalidCredentials();
  }

  if (!(await verifyPassword(a.password_hash, password))) {
    // atomowo: licznik nieudanych prób, po przekroczeniu — czasowa blokada konta
    await pool.query(
      `UPDATE admins
          SET locked_until = CASE WHEN failed_login_attempts + 1 >= $2
                                  THEN now() + make_interval(mins => $3::int) ELSE locked_until END,
              failed_login_attempts = CASE WHEN failed_login_attempts + 1 >= $2 THEN 0
                                           ELSE failed_login_attempts + 1 END
        WHERE id = $1`,
      [a.id, config.LOGIN_MAX_FAILED_ATTEMPTS, config.LOGIN_LOCK_MINUTES],
    );
    await audit(pool, { actor: 'admin', adminId: a.id, action: 'auth.login_failed', entityType: 'admin', entityId: a.id, ip: ctx.ip });
    throw invalidCredentials();
  }

  return withTransaction(async (tx) => {
    await tx.query(
      `UPDATE admins SET failed_login_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`,
      [a.id],
    );
    const { session } = await issueSession(tx, a, ctx);
    await audit(tx, { actor: 'admin', adminId: a.id, action: 'auth.login', entityType: 'admin', entityId: a.id, ip: ctx.ip });
    return session;
  });
}

/**
 * Rotacja refresh tokenu. Każdy token działa raz.
 * Ponowne użycie starego tokenu po oknie REFRESH_RACE_GRACE_SEC = prawdopodobna kradzież:
 * unieważniamy WSZYSTKIE sesje admina i podbijamy token_version (martwe są też access tokeny).
 */
export async function refresh(rawToken: string | undefined, ctx: Ctx): Promise<IssuedSession> {
  if (!rawToken) throw sessionExpired();
  return withTransaction(async (tx) => {
    const { rows: [s] } = await tx.query<{
      id: string; admin_id: string; expires_at: Date; revoked_at: Date | null; replaced_by: string | null;
      recently_revoked: boolean;
    } & Pick<AdminRow, 'email' | 'full_name' | 'role' | 'is_active' | 'token_version'>>(
      `SELECT s.id, s.admin_id, s.expires_at, s.revoked_at, s.replaced_by,
              s.revoked_at > now() - make_interval(secs => $2::int) AS recently_revoked,
              a.email, a.full_name, a.role, a.is_active, a.token_version
         FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
        WHERE s.refresh_token_hash = $1
        FOR UPDATE OF s`,
      [sha256(rawToken), REFRESH_RACE_GRACE_SEC],
    );
    if (!s) throw sessionExpired();

    if (s.revoked_at) {
      if (s.replaced_by && s.recently_revoked) {
        // dwie karty odświeżyły równocześnie — druga ma już nowe ciasteczka, wystarczy ponowić żądanie
        throw new AppError(401, 'REFRESH_RACE', 'Sesja została właśnie odświeżona — ponów żądanie');
      }
      if (s.replaced_by) {
        await tx.query(`UPDATE admin_sessions SET revoked_at = now() WHERE admin_id = $1 AND revoked_at IS NULL`, [s.admin_id]);
        await tx.query(`UPDATE admins SET token_version = token_version + 1 WHERE id = $1`, [s.admin_id]);
        await audit(tx, { actor: 'system', adminId: s.admin_id, action: 'auth.refresh_token_reuse', entityType: 'admin', entityId: s.admin_id, ip: ctx.ip });
        // celowo COMMIT (zwracamy błąd PO transakcji) — unieważnienie musi się utrwalić
        return null;
      }
      throw sessionExpired();
    }
    if (s.expires_at <= new Date() || !s.is_active) throw sessionExpired();

    const { sessionId, session } = await issueSession(tx, { id: s.admin_id, email: s.email, full_name: s.full_name, role: s.role, token_version: s.token_version }, ctx);
    await tx.query(`UPDATE admin_sessions SET revoked_at = now(), replaced_by = $2 WHERE id = $1`, [s.id, sessionId]);
    return session;
  }).then((session) => {
    if (!session) throw sessionExpired('SESSION_REVOKED');
    return session;
  });
}

/** Wylogowanie po refresh tokenie — działa nawet, gdy access token już wygasł. */
export async function logout(rawToken: string | undefined, ip: string | null): Promise<void> {
  if (!rawToken) return;
  const { rows: [s] } = await pool.query<{ admin_id: string }>(
    `UPDATE admin_sessions SET revoked_at = now()
      WHERE refresh_token_hash = $1 AND revoked_at IS NULL RETURNING admin_id`,
    [sha256(rawToken)],
  );
  if (s) await audit(pool, { actor: 'admin', adminId: s.admin_id, action: 'auth.logout', entityType: 'admin', entityId: s.admin_id, ip });
}

/** „Wyloguj wszędzie” (np. zgubiony telefon): wszystkie sesje + wszystkie access tokeny. */
export async function logoutEverywhere(adminId: string, ip: string | null): Promise<void> {
  await withTransaction(async (tx) => {
    await tx.query(`UPDATE admin_sessions SET revoked_at = now() WHERE admin_id = $1 AND revoked_at IS NULL`, [adminId]);
    await tx.query(`UPDATE admins SET token_version = token_version + 1 WHERE id = $1`, [adminId]);
    await audit(tx, { actor: 'admin', adminId, action: 'auth.logout_all', entityType: 'admin', entityId: adminId, ip });
  });
}
