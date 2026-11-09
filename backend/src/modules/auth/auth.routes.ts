import { Router, type Request } from 'express';
import { z } from 'zod';
import { csrfTokenFor, clearAuthCookies, COOKIE, setAuthCookies } from './tokens.js';
import { login, logout, logoutEverywhere, refresh } from './auth.service.js';
import { getAdmin, requireAdmin, requireCsrf, requireTrustedOrigin } from './auth.middleware.js';
import { limiters, rateLimitByIp } from '../../middleware/rateLimit.js';

const LoginSchema = z.object({
  email: z.email().max(254).transform((e) => e.toLowerCase()),
  password: z.string().min(1).max(128), // polityka siły hasła obowiązuje przy ustawianiu, nie przy logowaniu
}).strict();

const ctx = (req: Request) => ({ ip: req.ip ?? null, userAgent: req.get('User-Agent') ?? null });

export const authRouter = Router();
authRouter.use(requireTrustedOrigin);

authRouter.post('/login', rateLimitByIp(limiters.loginByIp), async (req, res) => {
  const { email, password } = LoginSchema.parse(req.body);
  const s = await login(email, password, ctx(req));
  setAuthCookies(res, s.accessToken, s.refreshToken);
  res.json({ admin: s.admin, csrfToken: s.csrfToken });
});

authRouter.post('/refresh', rateLimitByIp(limiters.loginByIp), async (req, res) => {
  try {
    const s = await refresh(req.cookies?.[COOKIE.refresh], ctx(req));
    setAuthCookies(res, s.accessToken, s.refreshToken);
    res.json({ admin: s.admin, csrfToken: s.csrfToken });
  } catch (err) {
    // przy wyścigu kart NIE czyścimy ciasteczek — druga karta właśnie ustawiła nowe
    if (!(err instanceof Error && 'code' in err && err.code === 'REFRESH_RACE')) clearAuthCookies(res);
    throw err;
  }
});

authRouter.post('/logout', async (req, res) => {
  await logout(req.cookies?.[COOKIE.refresh], req.ip ?? null);
  clearAuthCookies(res);
  res.status(204).end();
});

authRouter.post('/logout-all', requireAdmin, requireCsrf, async (req, res) => {
  await logoutEverywhere(getAdmin(req).id, req.ip ?? null);
  clearAuthCookies(res);
  res.status(204).end();
});

/** Po przeładowaniu strony SPA pobiera tu dane admina i token CSRF (trzymany tylko w pamięci). */
authRouter.get('/me', requireAdmin, (req, res) => {
  const a = getAdmin(req);
  res.json({
    admin: { id: a.id, email: a.email, fullName: a.fullName, role: a.role },
    csrfToken: csrfTokenFor(a.sessionId),
  });
});
