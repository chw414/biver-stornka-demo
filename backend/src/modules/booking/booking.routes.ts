import { Router } from 'express';
import { pool } from '../../db.js';
import { consume, limiters, rateLimitByIp } from '../../middleware/rateLimit.js';
import {
  AvailabilityQuerySchema,
  AvailableDaysQuerySchema,
  CreateBookingSchema,
  IdempotencyKeySchema,
} from './booking.schemas.js';
import { getAvailableDays, getSlotsForDay } from './availability.service.js';
import { createOnlineBooking } from './booking.service.js';
import { listPublicServices } from './services.repository.js';
import { config } from '../../config.js';
import { getSettings } from '../../lib/settings.js';

export const publicBookingRouter = Router();

// Express 5: odrzucone Promise z handlerów trafiają automatycznie do errorHandlera

/** Dane serwisu i aktualne dokumenty prawne — formularz pokazuje dokładnie tę wersję, która zostanie zapisana jako zgoda. */
publicBookingRouter.get('/info', rateLimitByIp(limiters.publicRead), async (_req, res) => {
  const settings = await getSettings();
  const { rows } = await pool.query<{ kind: string; version: string; url: string; display_text: string | null }>(
    `SELECT DISTINCT ON (kind) kind, version, url, display_text
       FROM legal_documents WHERE published_at <= now() ORDER BY kind, published_at DESC`);
  const doc = (k: string) => {
    const d = rows.find((r) => r.kind === k);
    return d ? { version: d.version, url: d.url, text: d.display_text } : null;
  };
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    businessName: config.BUSINESS_NAME,
    phone: config.BUSINESS_PHONE ?? null,
    address: config.BUSINESS_ADDRESS ?? null,
    timezone: settings.timezone,
    bookingHorizonDays: settings.booking_horizon_days,
    legal: { terms: doc('terms'), privacy: doc('privacy') },
    // null = WhatsApp niedostępny (brak treści zgody) → formularz nie pokazuje checkboxa
    priceInfo: settings.price_info ?? null,
    whatsappConsent: settings.notification_channels.includes('whatsapp') ? doc('whatsapp') : null,
  });
});

publicBookingRouter.get('/services', rateLimitByIp(limiters.publicRead), async (_req, res) => {
  const services = await listPublicServices(pool);
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    services: services.map((s) => ({
      id: s.id,
      slug: s.slug,
      name: s.name,
      description: s.description,
      durationMinutes: s.duration_minutes,
      priceFromPln: s.price_from_pln === null ? null : Number(s.price_from_pln),
      category: s.category,
      shortName: s.short_name,
    })),
  });
});

/** GET /availability?serviceId=1&date=2026-10-12 → wolne godziny w danym dniu */
publicBookingRouter.get('/availability', rateLimitByIp(limiters.publicRead), async (req, res) => {
  const q = AvailabilityQuerySchema.parse(req.query);
  res.set('Cache-Control', 'no-store');
  res.json(await getSlotsForDay(q.serviceId, q.date));
});

/** GET /availability/days?serviceId=1&from=2026-10-01&to=2026-10-31 → dni z wolnymi terminami */
publicBookingRouter.get('/availability/days', rateLimitByIp(limiters.publicRead), async (req, res) => {
  const q = AvailableDaysQuerySchema.parse(req.query);
  res.set('Cache-Control', 'no-store');
  res.json(await getAvailableDays(q.serviceId, q.from, q.to));
});

/**
 * POST /bookings
 * Nagłówek Idempotency-Key: UUID generowany przez frontend raz na próbę rezerwacji.
 * 201 utworzono | 200 powtórzone żądanie (ten sam klucz) | 400 walidacja | 409 termin zajęty
 * 422 termin niepoprawny | 429 limit | 503 przeciążenie
 */
publicBookingRouter.post('/bookings', rateLimitByIp(limiters.bookingByIp), async (req, res) => {
  const idempotencyKey = IdempotencyKeySchema.parse(req.get('Idempotency-Key'));
  const input = CreateBookingSchema.parse(req.body);
  // drugi limit: na znormalizowany numer (chroni przed rotacją IP przez boty)
  await consume(limiters.bookingByPhone, input.phone, res);

  const result = await createOnlineBooking(input, {
    idempotencyKey,
    ip: req.ip ?? null,
    userAgent: req.get('User-Agent') ?? null,
  });
  res.status(result.replayed ? 200 : 201).json({ appointment: result.appointment });
});
