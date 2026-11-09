import { Router, type Request } from 'express';
import { getAdmin, noStore, requireAdmin, requireCsrf, requireRole } from '../auth/auth.middleware.js';
import { authRouter } from '../auth/auth.routes.js';
import { IdempotencyKeySchema } from '../booking/booking.schemas.js';
import {
  CalendarQuerySchema, CancelAppointmentSchema, CreateAdminAppointmentSchema, CreateBlockSchema,
  UpdateAppointmentSchema, UuidParam,
} from './appointments.schemas.js';
import {
  cancelAppointment, createAdminAppointment, createBlock, deleteBlock, getAppointmentDetail, getCalendar,
  updateAppointment, type AdminCtx,
} from './appointments.service.js';
import {
  anonymizeCustomer, CustomerSearchSchema, getCustomer, searchCustomers, updateCustomer, updateVehicle,
  UpdateCustomerSchema, UpdateVehicleSchema,
} from './customers.service.js';
import { pool } from '../../db.js';
import { AppError } from '../../errors.js';
import { config } from '../../config.js';
import { getSettings } from '../../lib/settings.js';

const ctx = (req: Request): AdminCtx => ({ adminId: getAdmin(req).id, ip: req.ip ?? null });

export const adminRouter = Router();
adminRouter.use(noStore);
adminRouter.use('/auth', authRouter);

// wszystko poniżej: zalogowany admin + CSRF dla metod zmieniających stan
adminRouter.use(requireAdmin, requireCsrf);

// ---------- Usługi (także niepubliczne — tylko do ręcznego dodania przez admina) ----------
adminRouter.get('/services', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, duration_minutes AS "durationMinutes", price_from_pln::float AS "priceFromPln", is_public AS "isPublic",
            category, short_name AS "shortName"
       FROM services WHERE is_active ORDER BY sort_order, name`);
  res.json({ services: rows });
});

// ---------- Kalendarz ----------
adminRouter.get('/calendar', async (req, res) => {
  const q = CalendarQuerySchema.parse(req.query);
  const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000;
  if (days > 42) throw new AppError(422, 'RANGE_TOO_LARGE', 'Maksymalny zakres kalendarza to 6 tygodni');
  res.json(await getCalendar(q.from, q.to, q.includeCancelled));
});

// ---------- Wizyty ----------
adminRouter.post('/appointments', async (req, res) => {
  const key = req.get('Idempotency-Key');
  const input = CreateAdminAppointmentSchema.parse(req.body);
  const r = await createAdminAppointment(input, { ...ctx(req), idempotencyKey: key ? IdempotencyKeySchema.parse(key) : null });
  res.status(r.replayed ? 200 : 201).json(r);
});

adminRouter.get('/appointments/:id', async (req, res) => {
  const { id } = UuidParam.parse(req.params);
  res.json({ appointment: await getAppointmentDetail(pool, id) });
});

adminRouter.patch('/appointments/:id', async (req, res) => {
  const { id } = UuidParam.parse(req.params);
  res.json({ appointment: await updateAppointment(id, UpdateAppointmentSchema.parse(req.body), ctx(req)) });
});

adminRouter.post('/appointments/:id/cancel', async (req, res) => {
  const { id } = UuidParam.parse(req.params);
  res.json({ appointment: await cancelAppointment(id, CancelAppointmentSchema.parse(req.body ?? {}), ctx(req)) });
});

// ---------- Blokady stanowisk ----------
adminRouter.post('/blocks', async (req, res) => {
  res.status(201).json(await createBlock(CreateBlockSchema.parse(req.body), ctx(req)));
});
adminRouter.delete('/blocks/:id', async (req, res) => {
  await deleteBlock(UuidParam.parse(req.params).id, ctx(req));
  res.status(204).end();
});

// ---------- Klienci i pojazdy ----------
adminRouter.get('/customers', async (req, res) => {
  res.json(await searchCustomers(CustomerSearchSchema.parse(req.query)));
});
adminRouter.get('/customers/:id', async (req, res) => {
  res.json({ customer: await getCustomer(UuidParam.parse(req.params).id, ctx(req)) });
});
adminRouter.patch('/customers/:id', async (req, res) => {
  res.json({ customer: await updateCustomer(UuidParam.parse(req.params).id, UpdateCustomerSchema.parse(req.body), ctx(req)) });
});
adminRouter.patch('/vehicles/:id', async (req, res) => {
  res.json({ vehicle: await updateVehicle(UuidParam.parse(req.params).id, UpdateVehicleSchema.parse(req.body), ctx(req)) });
});
adminRouter.post('/customers/:id/anonymize', requireRole('owner'), async (req, res) => {
  await anonymizeCustomer(UuidParam.parse(req.params).id, ctx(req));
  res.status(204).end();
});

// ---------- Stan integracji (dla właściciela: czy powiadomienia i kalendarz działają) ----------
adminRouter.get('/system/health', async (_req, res) => {
  const settings = await getSettings();
  const [{ rows: [n] }, { rows: [o] }, { rows: errors }] = await Promise.all([
    pool.query(`SELECT
        count(*) FILTER (WHERE status = 'pending' AND scheduled_for <= now() - interval '10 minutes')::int AS "overdue",
        count(*) FILTER (WHERE status = 'failed' AND created_at > now() - interval '7 days')::int AS "failed7d",
        count(*) FILTER (WHERE status = 'cancelled' AND error_code = 'NO_CHANNEL' AND created_at > now() - interval '7 days')::int AS "noChannel7d",
        count(*) FILTER (WHERE status IN ('sent','delivered','read') AND created_at > now() - interval '7 days')::int AS "sent7d"
      FROM notifications`),
    pool.query(`SELECT
        count(*) FILTER (WHERE status = 'failed')::int AS "failed",
        count(*) FILTER (WHERE status IN ('pending','processing'))::int AS "pending",
        min(created_at) FILTER (WHERE status IN ('pending','processing')) AS "oldestPendingAt"
      FROM outbox_events`),
    pool.query(`SELECT error_code AS "code", channel, count(*)::int AS "count", max(created_at) AS "lastAt"
      FROM notifications WHERE status = 'failed' AND created_at > now() - interval '7 days'
      GROUP BY error_code, channel ORDER BY count(*) DESC LIMIT 10`),
  ]);
  res.json({
    notificationChannels: settings.notification_channels,
    whatsappMode: config.WHATSAPP_MODE,
    calendarMode: config.GOOGLE_CALENDAR_MODE,
    notifications: { ...n, topErrors: errors },
    calendarSync: o,
  });
});
