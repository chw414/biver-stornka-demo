/**
 * Test workerów: WhatsApp (fałszywy serwer Graph API), fallback na SMS, webhooki, Google Calendar
 * (fałszywy serwer Calendar API). TYLKO na pustej bazie dev/test.
 *   npm run test:workers
 */
import { createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

let failures = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readBody = (req: http.IncomingMessage) => new Promise<string>((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });

// ======================= Fałszywy WhatsApp Cloud API =======================
interface MetaCall { auth: string | undefined; path: string; body: any }
const metaCalls: MetaCall[] = [];
const failOnce = new Set(['48600000002']);
const meta = http.createServer(async (req, res) => {
  const body = JSON.parse(await readBody(req));
  metaCalls.push({ auth: req.headers.authorization, path: req.url!, body });
  res.setHeader('Content-Type', 'application/json');
  if (failOnce.delete(body.to)) { res.statusCode = 500; res.end('upstream error'); return; }
  if (body.to === '48600000003') {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: { message: '(#132001) Template name does not exist in the translation', code: 132001 } }));
    return;
  }
  res.end(JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: `wamid.${randomUUID()}` }] }));
}).listen(0);

// ======================= Fałszywy Google Calendar API =======================
const events = new Map<string, any>();
const gCalls: { method: string; id: string }[] = [];
const inFlight = new Map<string, number>(); let maxInFlight = 0;
let fail503 = 0;
const google = http.createServer(async (req, res) => {
  const m = req.url!.match(/\/calendar\/v3\/calendars\/([^/]+)\/events\/?([a-v0-9]*)/);
  const body = req.method === 'DELETE' ? null : await readBody(req).then((b) => (b ? JSON.parse(b) : null));
  const id = m?.[2] || body?.id || '';
  gCalls.push({ method: req.method!, id });
  inFlight.set(id, (inFlight.get(id) ?? 0) + 1); maxInFlight = Math.max(maxInFlight, inFlight.get(id)!);
  await sleep(30);
  inFlight.set(id, inFlight.get(id)! - 1);
  const reply = (code: number, obj?: unknown) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(obj ? JSON.stringify(obj) : ''); };
  if (req.headers.authorization !== 'Bearer test-google-token') return reply(401, { error: 'auth' });
  if (fail503 > 0) { fail503--; return reply(503, { error: { message: 'backendError' } }); }
  const ev = events.get(id);
  if (req.method === 'PATCH') { if (!ev) return reply(404, { error: { code: 404 } }); events.set(id, { ...ev, ...body }); return reply(200, events.get(id)); }
  if (req.method === 'POST') { if (ev) return reply(409, { error: { code: 409 } }); events.set(id, body); return reply(200, body); }
  if (req.method === 'DELETE') { if (!ev || ev.status === 'cancelled') return reply(410, {}); events.set(id, { ...ev, status: 'cancelled' }); return reply(204); }
  reply(400);
}).listen(0);
await sleep(50);

// konfiguracja MUSI być ustawiona przed importem modułów aplikacji (config czyta env przy imporcie)
const APP_SECRET = 'test-app-secret-0123456789';
const VERIFY = 'test-verify-token-0123456789';
Object.assign(process.env, {
  WHATSAPP_MODE: 'cloud',
  WHATSAPP_API_BASE_URL: `http://127.0.0.1:${(meta.address() as AddressInfo).port}`,
  WHATSAPP_PHONE_NUMBER_ID: '1234567890',
  WHATSAPP_ACCESS_TOKEN: 'test-access-token-abcdefghij',
  WHATSAPP_APP_SECRET: APP_SECRET,
  WHATSAPP_VERIFY_TOKEN: VERIFY,
  BUSINESS_NAME: 'Opony Test',
});

const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/db.js');
const { invalidateSettingsCache } = await import('../src/lib/settings.js');
const { buildChannelRegistry } = await import('../src/notifications/channels/registry.js');
const { runNotificationTick } = await import('../src/notifications/notification.worker.js');
const { GoogleCalendarClient } = await import('../src/calendar/googleCalendar.client.js');
const { runOutboxTick } = await import('../src/calendar/outbox.worker.js');
const { hashPassword } = await import('../src/modules/auth/password.js');
type MessageChannel = import('../src/notifications/channels/types.js').MessageChannel;

// fałszywy kanał SMS — pokazuje, że "miejsce na SMS" działa bez zmian w workerze
const smsSent: { to: string; text: string }[] = [];
const fakeSms: MessageChannel = {
  name: 'sms', provider: 'test-sms', requiresOptIn: false,
  async send({ to, message }) { smsSent.push({ to, text: message.text }); return { status: 'accepted', providerMessageId: `sms-${randomUUID()}` }; },
};

const registry = buildChannelRegistry();
const calendar = new GoogleCalendarClient('serwis@group.calendar.google.com', async () => 'test-google-token', `http://127.0.0.1:${(google.address() as AddressInfo).port}`);

await pool.query(`INSERT INTO legal_documents (kind, version, content_sha256, url) VALUES
  ('terms','t1',sha256('t'::bytea),'https://x/r'), ('privacy','t1',sha256('p'::bytea),'https://x/p'),
  ('whatsapp','w1',sha256('Chcę otrzymywać potwierdzenia i przypomnienia o wizytach na WhatsApp od Opony Test'::bytea),'https://x/w')`);

const { rows: [d] } = await pool.query<{ day: string }>(`SELECT to_char(x,'YYYY-MM-DD') AS day FROM generate_series(
  (now() AT TIME ZONE 'Europe/Warsaw')::date + 2, (now() AT TIME ZONE 'Europe/Warsaw')::date + 9, '1 day') x
  WHERE EXTRACT(ISODOW FROM x) = 1 LIMIT 1`);
const at = async (hhmm: string) => (await pool.query<{ t: Date }>(`SELECT ($1::date + $2::time) AT TIME ZONE 'Europe/Warsaw' t`, [d!.day, hhmm])).rows[0]!.t.toISOString();

const server = createApp({ channels: registry }).listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function book(hhmm: string, phone: string, whatsappOptIn: boolean) {
  const res = await fetch(`${base}/api/public/bookings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ serviceId: 1, startsAt: await at(hhmm), fullName: 'Jan Test', phone, acceptTerms: true, whatsappOptIn,
      vehicle: { make: 'Opel', model: 'Astra', registrationNumber: `WX${phone.slice(-5)}` } }),
  });
  const body = await res.json() as { appointment: { referenceCode: string } };
  const { rows: [a] } = await pool.query<{ id: string }>('SELECT id FROM appointments WHERE reference_code = $1', [body.appointment.referenceCode]);
  return { id: a!.id, ref: body.appointment.referenceCode };
}
const notif = async (apptId: string, kind = 'confirmation') =>
  (await pool.query(`SELECT * FROM notifications WHERE appointment_id = $1 AND kind = $2 ORDER BY created_at`, [apptId, kind])).rows;
async function webhook(payload: unknown, sign = true) {
  const raw = JSON.stringify(payload);
  return fetch(`${base}/api/webhooks/whatsapp`, {
    method: 'POST', body: raw,
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${createHmac('sha256', sign ? APP_SECRET : 'wrong').update(raw).digest('hex')}` },
  });
}
const statusPayload = (statuses: object[]) => ({ object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', statuses } }] }] });
const now = () => String(Math.floor(Date.now() / 1000));

try {
  // ======================= WYSYŁKA WHATSAPP =======================
  const A = await book('09:00', '600 000 001', true);
  const B = await book('09:15', '600 000 004', false);
  const C = await book('09:30', '600 000 002', true);
  const D = await book('09:45', '600 000 003', true);
  await runNotificationTick(registry);

  const [nA] = await notif(A.id);
  const call = metaCalls.find((c) => c.body.to === '48600000001')!;
  check('Potwierdzenie WhatsApp wysłane (klient ze zgodą)', nA.status === 'sent' && nA.channel === 'whatsapp' && /^wamid\./.test(nA.provider_message_id));
  check('Payload: szablon, język pl, 4 parametry, numer bez "+", token',
    call.body.template.name === 'potwierdzenie_wizyty' && call.body.template.language.code === 'pl'
    && call.body.template.components[0].parameters.length === 4 && call.body.template.components[0].parameters[3].text === A.ref
    && call.auth === 'Bearer test-access-token-abcdefghij' && call.path === '/v24.0/1234567890/messages',
    call.body.template.components[0].parameters.map((p: { text: string }) => p.text).join(' | '));
  check('biz_opaque_callback_data = id powiadomienia', call.body.biz_opaque_callback_data === nA.id);
  const [nB] = await notif(B.id);
  check('Brak zgody na WhatsApp i brak SMS → NIE wysyłamy (NO_CHANNEL)', nB.status === 'cancelled' && nB.error_code === 'NO_CHANNEL' && !metaCalls.some((c) => c.body.to === '48600000004'));
  const [nC] = await notif(C.id);
  check('Błąd 500 → do ponowienia z opóźnieniem', nC.status === 'pending' && nC.attempts === 1 && nC.locked_until > new Date() && nC.error_code === 'HTTP_500');
  const [nD] = await notif(D.id);
  check('Błąd 132001 (brak szablonu) → trwały, bez ponawiania', nD.status === 'failed' && nD.error_code === '132001');

  await pool.query(`UPDATE notifications SET locked_until = now() - interval '1 second' WHERE id = $1`, [nC.id]);
  await runNotificationTick(registry);
  check('Ponowienie po opóźnieniu → wysłane', (await notif(C.id))[0].status === 'sent');

  const [rA] = await notif(A.id, 'reminder_24h');
  check('Przypomnienie czeka na swój czas', rA.status === 'pending' && rA.scheduled_for > new Date());
  await pool.query(`UPDATE notifications SET scheduled_for = now() - interval '1 second' WHERE id = $1`, [rA.id]);
  await runNotificationTick(registry);
  check('Przypomnienie wysłane szablonem przypomnienie_wizyty',
    (await notif(A.id, 'reminder_24h'))[0].status === 'sent' && metaCalls.at(-1)!.body.template.name === 'przypomnienie_wizyty');

  // ======================= WEBHOOKI =======================
  const v = await fetch(`${base}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=42424242`);
  const vBad = await fetch(`${base}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=zly&hub.challenge=1`);
  check('Weryfikacja webhooka (GET): poprawny token → challenge, zły → 403', v.status === 200 && (await v.text()) === '42424242' && vBad.status === 403);
  check('Webhook z błędnym podpisem → 401', (await webhook(statusPayload([{ id: nA.provider_message_id, status: 'read', timestamp: now() }]), false)).status === 401);

  const s = (status: string, extra: object = {}) => ({ id: nA.provider_message_id, status, timestamp: now(), recipient_id: '48600000001', biz_opaque_callback_data: nA.id, ...extra });
  await webhook(statusPayload([s('delivered')]));
  check('Status delivered', (await notif(A.id))[0].status === 'delivered');
  await webhook(statusPayload([s('sent')]));
  check('Spóźniony "sent" nie cofa statusu', (await notif(A.id))[0].status === 'delivered');
  await webhook(statusPayload([s('read')])); await webhook(statusPayload([s('read')]));
  const readRow = (await notif(A.id))[0];
  check('Status read (powtórzony webhook bez efektu)', readRow.status === 'read' && readRow.read_at !== null && readRow.delivered_at !== null);
  const sentC = (await notif(C.id))[0];
  await webhook(statusPayload([{ id: sentC.provider_message_id, status: 'delivered', timestamp: now() }]));
  check('Dopasowanie po id wiadomości Meta (bez callback data)', (await notif(C.id))[0].status === 'delivered');

  // ======================= MIEJSCE NA SMS: fallback =======================
  await pool.query(`UPDATE app_settings SET value = '["whatsapp","sms"]' WHERE key = 'notification_channels'`);
  invalidateSettingsCache();
  registry.set('sms', fakeSms);

  const failC = { id: sentC.provider_message_id, status: 'failed', timestamp: now(), errors: [{ code: 131026, title: 'Message undeliverable' }] };
  await webhook(statusPayload([failC])); await webhook(statusPayload([failC])); // Meta potrafi powtórzyć webhook
  const cRows = await notif(C.id);
  check('Asynchroniczny błąd 131026 → WhatsApp failed + JEDNO zastępcze SMS',
    cRows.length === 2 && cRows[0].status === 'failed' && cRows[0].error_code === '131026' && cRows[1].channel === 'sms' && cRows[1].fallback_of === cRows[0].id);
  await runNotificationTick(registry);
  check('…SMS wysłany z czytelną treścią', (await notif(C.id))[1].status === 'sent' && smsSent.some((m) => m.to === '+48600000002' && m.text.includes(C.ref) && m.text.startsWith('Opony Test:')), smsSent.at(-1)?.text);

  const E = await book('10:00', '600 000 003', true);
  await runNotificationTick(registry); await runNotificationTick(registry);
  const eRows = await notif(E.id);
  check('Synchroniczny trwały błąd WhatsApp → od razu SMS', eRows[0].status === 'failed' && eRows[1]?.channel === 'sms' && eRows[1]?.status === 'sent');
  const F = await book('10:15', '600 000 005', false);
  await runNotificationTick(registry);
  check('Klient bez zgody na WhatsApp → bezpośrednio SMS', (await notif(F.id))[0].channel === 'sms' && !metaCalls.some((c) => c.body.to === '48600000005'));

  // ======================= Rezygnacja "STOP" =======================
  await webhook({ object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages',
    value: { messaging_product: 'whatsapp', messages: [{ from: '48600000001', id: 'wamid.in1', timestamp: now(), type: 'text', text: { body: 'Stop.' } }] } }] }] });
  const { rows: [cons] } = await pool.query(`SELECT count(*) FILTER (WHERE withdrawn_at IS NULL)::int active FROM customer_consents cc
    JOIN legal_documents d ON d.id = cc.document_id JOIN customers c ON c.id = cc.customer_id WHERE d.kind='whatsapp' AND c.phone_e164 = '+48600000001'`);
  check('Odpowiedź "Stop." → zgoda na WhatsApp wycofana', cons.active === 0);
  const before = metaCalls.length;
  const G = await book('10:30', '600 000 001', false);
  await runNotificationTick(registry);
  check('…kolejne wiadomości idą SMS-em, nie WhatsAppem', (await notif(G.id))[0].channel === 'sms' && metaCalls.length === before);

  // ======================= Sens wysyłki sprawdzany w chwili wysyłki =======================
  const H = await book('10:45', '600 000 006', true);
  await pool.query(`UPDATE appointments SET status='cancelled', cancelled_at=now(), cancelled_by='admin' WHERE id=$1`, [H.id]);
  await runNotificationTick(registry);
  check('Wizyta anulowana przed wysyłką → potwierdzenie nie wychodzi', (await notif(H.id))[0].error_code === 'APPOINTMENT_NOT_ACTIVE' && !metaCalls.some((c) => c.body.to === '48600000006'));

  // ======================= GOOGLE CALENDAR =======================
  await runOutboxTick(calendar);
  const evA = events.get(A.id.replace(/-/g, ''));
  const { rows: synced } = await pool.query(`SELECT count(*)::int n FROM appointments WHERE google_event_id IS NOT NULL`);
  check('Eventy utworzone z deterministycznym id (UUID wizyty)', events.size === 7 && !!evA && synced[0].n === 7, `eventów: ${events.size}`);
  check('Treść eventu bez danych osobowych (domyślnie)', /Astra WX0001/.test(evA.summary) && !/Jan Test|\+48/.test(evA.summary + evA.description) && evA.start.timeZone === 'Europe/Warsaw', evA.summary);
  check('Anulowana wizyta nie trafia do kalendarza', !events.has(H.id.replace(/-/g, '')));

  // przesunięcie + 3 zaległe zdarzenia tej samej wizyty → 1 wywołanie API (koalescencja)
  await pool.query(`UPDATE appointments SET starts_at = $2, ends_at = $3 WHERE id = $1`, [A.id, await at('11:00'), await at('11:15')]);
  for (let i = 0; i < 3; i++) await pool.query(`INSERT INTO outbox_events (aggregate_id, event_type, payload) VALUES ($1,'appointment.updated','{}')`, [A.id]);
  const callsBefore = gCalls.length;
  await runOutboxTick(calendar);
  const { rows: [pend] } = await pool.query(`SELECT count(*)::int n FROM outbox_events WHERE aggregate_id = $1 AND status <> 'done'`, [A.id]);
  check('3 zaległe aktualizacje → 1 wywołanie API, wszystkie zamknięte', gCalls.length - callsBefore === 1 && pend.n === 0 && events.get(A.id.replace(/-/g, '')).start.dateTime === await at('11:00'));

  // 5 zdarzeń jednej wizyty, 3 workery równolegle → nigdy dwa naraz dla tej samej wizyty
  for (let i = 0; i < 5; i++) await pool.query(`INSERT INTO outbox_events (aggregate_id, event_type, payload) VALUES ($1,'appointment.updated','{}')`, [B.id]);
  maxInFlight = 0;
  const c0 = gCalls.length;
  await Promise.all([runOutboxTick(calendar), runOutboxTick(calendar), runOutboxTick(calendar)]);
  check('Równoległe workery: maks. 1 operacja naraz na wizytę', maxInFlight === 1 && gCalls.length - c0 === 1, `wywołań: ${gCalls.length - c0}`);

  // chwilowy błąd Google → ponowienie
  fail503 = 1;
  await pool.query(`INSERT INTO outbox_events (aggregate_id, event_type, payload) VALUES ($1,'appointment.updated','{}')`, [C.id]);
  await runOutboxTick(calendar);
  const { rows: [r503] } = await pool.query(`SELECT * FROM outbox_events WHERE aggregate_id = $1 ORDER BY id DESC LIMIT 1`, [C.id]);
  check('Google 503 → zdarzenie wraca do kolejki z opóźnieniem', r503.status === 'pending' && r503.next_attempt_at > new Date() && /503/.test(r503.last_error));
  await pool.query(`UPDATE outbox_events SET next_attempt_at = now() WHERE id = $1`, [r503.id]);
  await runOutboxTick(calendar);
  check('…po opóźnieniu zsynchronizowane', (await pool.query(`SELECT status FROM outbox_events WHERE id = $1`, [r503.id])).rows[0].status === 'done');

  // anulowanie → usunięcie eventu (dwukrotnie — idempotentnie)
  await pool.query(`UPDATE appointments SET status='cancelled', cancelled_at=now(), cancelled_by='admin' WHERE id=$1`, [A.id]);
  await pool.query(`INSERT INTO outbox_events (aggregate_id, event_type, payload) VALUES ($1,'appointment.cancelled','{}'), ($1,'appointment.cancelled','{}')`, [A.id]);
  await runOutboxTick(calendar);
  await pool.query(`INSERT INTO outbox_events (aggregate_id, event_type, payload) VALUES ($1,'appointment.cancelled','{}')`, [A.id]);
  await runOutboxTick(calendar);
  const { rows: [aRow] } = await pool.query(`SELECT google_event_id FROM appointments WHERE id = $1`, [A.id]);
  check('Anulowanie usuwa event; ponowne usunięcie (410) też OK', events.get(A.id.replace(/-/g, '')).status === 'cancelled' && aRow.google_event_id === null
    && (await pool.query(`SELECT count(*)::int n FROM outbox_events WHERE status <> 'done'`)).rows[0].n === 0);

  // ======================= Stan integracji w panelu =======================
  await pool.query(`INSERT INTO admins (email, password_hash, full_name, role) VALUES ('o@x.pl', $1, 'O', 'owner')`, [await hashPassword('Haslo-testowe-123')]);
  const login = await fetch(`${base}/api/admin/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' }, body: JSON.stringify({ email: 'o@x.pl', password: 'Haslo-testowe-123' }) });
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const health = await (await fetch(`${base}/api/admin/system/health`, { headers: { Cookie: cookie } })).json() as any;
  check('GET /admin/system/health: błędy wysyłki pogrupowane', health.notifications.failed7d === 3 && health.notifications.topErrors.some((e: { code: string }) => e.code === '132001') && health.calendarSync.failed === 0,
    JSON.stringify(health.notifications.topErrors.map((e: { code: string; count: number }) => `${e.code}×${e.count}`)));
} finally {
  server.close(); meta.close(); google.close();
  await pool.end();
}
console.log(failures ? `\n${failures} test(ów) nie przeszło` : '\nWszystkie testy przeszły');
process.exit(failures ? 1 : 0);
