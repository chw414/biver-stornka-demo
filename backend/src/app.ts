import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { pool } from './db.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { publicBookingRouter } from './modules/booking/booking.routes.js';
import { adminRouter } from './modules/admin/admin.routes.js';
import { createWhatsAppWebhookRouter } from './notifications/whatsapp.webhook.js';
import type { ChannelRegistry } from './notifications/channels/registry.js';

export function createApp(opts: { channels?: ChannelRegistry } = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY); // poprawne req.ip za Caddy/Cloudflare
  app.set('query parser', 'simple');          // bez zagnieżdżonych obiektów w query (?a[b]=c)

  app.use(helmet());                           // CSP, HSTS, nosniff, frameguard...
  app.use(cors({
    origin: config.allowedOrigins,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Idempotency-Key', 'X-CSRF-Token'],
    credentials: true, // potrzebne dla cookies panelu admina
    maxAge: 600,
  }));
  // Webhook przed express.json(): weryfikacja podpisu wymaga surowego body
  app.use('/api/webhooks/whatsapp', createWhatsAppWebhookRouter(opts.channels));

  // Tylko application/json — formularz HTML z innej domeny nie wyśle takiego żądania bez preflightu CORS
  app.use(express.json({ limit: '10kb', type: 'application/json' }));
  app.use(cookieParser());

  app.get('/health', (_req, res) => { res.json({ status: 'ok' }); });
  // gotowość: czy baza odpowiada (healthcheck kontenera / monitoring)
  app.get('/ready', async (_req, res) => {
    try { await pool.query('SELECT 1'); res.json({ status: 'ready' }); }
    catch { res.status(503).json({ status: 'db_unavailable' }); }
  });
  app.use('/api/public', publicBookingRouter);
  app.use('/api/admin', adminRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
