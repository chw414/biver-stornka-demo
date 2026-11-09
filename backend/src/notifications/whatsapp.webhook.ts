import { createHmac, timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db.js';
import { AppError } from '../errors.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { buildChannelRegistry, type ChannelRegistry } from './channels/registry.js';
import { createFallback } from './notification.worker.js';

/** Słowa, którymi klient może zrezygnować z wiadomości (instrukcja w stopce szablonów). */
const OPT_OUT_WORDS = new Set(['STOP', 'NIE', 'WYPISZ', 'REZYGNUJE', 'REZYGNUJĘ']);

const StatusSchema = z.object({
  id: z.string(),
  status: z.string(),
  timestamp: z.string().optional(),
  biz_opaque_callback_data: z.string().optional(),
  errors: z.array(z.object({ code: z.number(), title: z.string().optional(), message: z.string().optional() })).optional(),
});
const InboundSchema = z.object({ from: z.string(), type: z.string(), text: z.object({ body: z.string() }).optional() });
const PayloadSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(z.object({
    changes: z.array(z.object({
      field: z.string(),
      value: z.object({
        statuses: z.array(StatusSchema).optional(),
        messages: z.array(InboundSchema).optional(),
      }).passthrough(),
    })),
  })),
});

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function verifySignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(header.slice(7), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Statusy tylko awansują: sent → delivered → read. Meta ponawia webhooki do 7 dni i nie gwarantuje
 * kolejności, więc spóźniony "sent" nie może cofnąć "read". To czyni obsługę idempotentną.
 */
async function applyStatus(s: z.infer<typeof StatusSchema>, registry: ChannelRegistry) {
  const ts = s.timestamp ? new Date(Number(s.timestamp) * 1000) : new Date();
  const byId = s.biz_opaque_callback_data && uuidRe.test(s.biz_opaque_callback_data) ? s.biz_opaque_callback_data : null;
  const where = `(($1::uuid IS NOT NULL AND id = $1::uuid) OR ($1::uuid IS NULL AND provider_message_id = $2))`;

  if (s.status === 'delivered' || s.status === 'read') {
    await pool.query(
      `UPDATE notifications
          SET status = CASE WHEN $3 = 'read' OR status = 'sent' THEN $3::delivery_status ELSE status END,
              delivered_at = COALESCE(delivered_at, $4),
              read_at = CASE WHEN $3 = 'read' THEN COALESCE(read_at, $4) ELSE read_at END
        WHERE ${where} AND status IN ('sent', 'delivered', 'read')`,
      [byId, s.id, s.status, ts]);
    return;
  }

  if (s.status === 'failed') {
    const err = s.errors?.[0];
    // tylko przejście z sent/delivered → failed (powtórzony webhook nic już nie zmieni)
    const { rows: [n] } = await pool.query<{ id: string }>(
      `UPDATE notifications SET status = 'failed', error_code = $3, last_error = $4
        WHERE ${where} AND status IN ('sent', 'delivered')
        RETURNING id`,
      [byId, s.id, err ? String(err.code) : 'UNKNOWN', err?.message ?? err?.title ?? null]);
    if (n) {
      logger.warn({ notificationId: n.id, code: err?.code }, 'WhatsApp: wiadomość niedostarczona');
      await createFallback(n.id, 'whatsapp', registry); // np. 131026 (numer bez WhatsAppa) → SMS, jeśli włączony
    }
  }
  // 'sent' — już zapisany przy wysyłce; 'played' dotyczy wiadomości głosowych
}

/** Klient odpisał "STOP" → wycofanie zgody na WhatsApp (wymóg polityki Meta + RODO art. 7 ust. 3). */
async function applyInbound(m: z.infer<typeof InboundSchema>) {
  const word = m.text?.body.trim().toUpperCase().replace(/[.!]+$/, '');
  if (m.type !== 'text' || !word || !OPT_OUT_WORDS.has(word)) return;
  const phone = `+${m.from.replace(/\D/g, '')}`;
  const { rows } = await pool.query<{ customer_id: string }>(
    `UPDATE customer_consents cc SET withdrawn_at = now()
       FROM legal_documents d, customers c
      WHERE d.id = cc.document_id AND d.kind = 'whatsapp' AND c.id = cc.customer_id
        AND c.phone_e164 = $1 AND cc.withdrawn_at IS NULL
      RETURNING cc.customer_id`,
    [phone]);
  for (const r of new Set(rows.map((x) => x.customer_id))) {
    await audit(pool, { actor: 'customer', action: 'consent.whatsapp_withdrawn', entityType: 'customer', entityId: r, changes: { via: 'whatsapp_reply' } });
  }
}

export function createWhatsAppWebhookRouter(registry: ChannelRegistry = buildChannelRegistry()) {
  const router = Router();
  const secret = config.WHATSAPP_APP_SECRET;
  const verifyToken = config.WHATSAPP_VERIFY_TOKEN;

  // Weryfikacja adresu przy konfiguracji w panelu Meta
  router.get('/', (req, res) => {
    if (!verifyToken) throw new AppError(404, 'NOT_FOUND', 'Nie znaleziono zasobu');
    const token = req.query['hub.verify_token'];
    const given = typeof token === 'string' ? Buffer.from(token) : Buffer.alloc(0);
    const expected = Buffer.from(verifyToken);
    if (req.query['hub.mode'] === 'subscribe' && given.length === expected.length && timingSafeEqual(given, expected)) {
      res.status(200).type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
      return;
    }
    res.sendStatus(403);
  });

  // Surowe body jest potrzebne do weryfikacji HMAC — dlatego ten router jest montowany PRZED express.json()
  router.post('/', express.raw({ type: 'application/json', limit: '5mb' }), async (req, res) => {
    if (!secret) throw new AppError(404, 'NOT_FOUND', 'Nie znaleziono zasobu');
    const raw = req.body as Buffer;
    if (!Buffer.isBuffer(raw) || !verifySignature(raw, req.get('X-Hub-Signature-256'), secret)) {
      logger.warn({ ip: req.ip }, 'Webhook WhatsApp z nieprawidłowym podpisem');
      res.sendStatus(401);
      return;
    }
    const parsed = PayloadSchema.safeParse(JSON.parse(raw.toString('utf8')));
    if (!parsed.success) { res.sendStatus(200); return; } // inne typy zdarzeń — potwierdzamy, ignorujemy

    for (const entry of parsed.data.entry) {
      for (const change of entry.changes) {
        if (change.field !== 'messages') continue;
        for (const s of change.value.statuses ?? []) await applyStatus(s, registry);
        for (const m of change.value.messages ?? []) await applyInbound(m);
      }
    }
    // błąd bazy powyżej → 500 → Meta ponowi webhook (obsługa jest idempotentna)
    res.sendStatus(200);
  });

  return router;
}
