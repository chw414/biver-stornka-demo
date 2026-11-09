/**
 * Test integracyjny panelu admina — TYLKO na pustej bazie dev/test.
 * Uruchomienie: npm run test:admin
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { config } from '../src/config.js';
import { hashPassword } from '../src/modules/auth/password.js';

let failures = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

// ---------- mini klient HTTP z obsługą ciasteczek (z uwzględnieniem Path, jak przeglądarka) ----------
class Browser {
  jar = new Map<string, { value: string; path: string }>();
  csrf = '';
  constructor(private base: string, private origin = config.allowedOrigins[0]!) {}
  async req(method: string, path: string, body?: unknown, opts: { csrf?: boolean; origin?: string | null; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...opts.headers };
    const cookies = [...this.jar].filter(([, c]) => path.startsWith(c.path)).map(([n, c]) => `${n}=${c.value}`);
    if (cookies.length) headers.Cookie = cookies.join('; ');
    if (opts.origin !== null) headers.Origin = opts.origin ?? this.origin;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.csrf !== false && this.csrf) headers['X-CSRF-Token'] = this.csrf;
    const res = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(';').map((s) => s.trim());
      const [name, value] = [pair!.slice(0, pair!.indexOf('=')), pair!.slice(pair!.indexOf('=') + 1)];
      const p = attrs.find((a) => a.toLowerCase().startsWith('path='))?.slice(5) ?? '/';
      const expired = attrs.some((a) => /^expires=/i.test(a) && Date.parse(a.slice(8)) < Date.now()) || attrs.some((a) => /^max-age=0$/i.test(a));
      if (expired || value === '') this.jar.delete(name); else this.jar.set(name, { value, path: p });
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (json?.csrfToken) this.csrf = json.csrfToken;
    return { status: res.status, body: json, setCookies: res.headers.getSetCookie() };
  }
}

// ---------- dane ----------
await pool.query(`INSERT INTO legal_documents (kind, version, content_sha256, url) VALUES
  ('terms','t1',sha256('t'::bytea),'https://x/r'), ('privacy','t1',sha256('p'::bytea),'https://x/p') ON CONFLICT DO NOTHING`);
const PASS = 'Bardzo-Tajne-Haslo-123';
const pwHash = await hashPassword(PASS);
await pool.query(`INSERT INTO admins (email, password_hash, full_name, role) VALUES
  ('owner@serwis.pl', $1, 'Właściciel', 'owner'), ('staff@serwis.pl', $1, 'Pracownik', 'staff')`, [pwHash]);

const { rows: [d] } = await pool.query<{ day: string }>(`SELECT to_char(x,'YYYY-MM-DD') AS day FROM generate_series(
  (now() AT TIME ZONE 'Europe/Warsaw')::date + 2, (now() AT TIME ZONE 'Europe/Warsaw')::date + 9, '1 day') x
  WHERE EXTRACT(ISODOW FROM x) = 1 LIMIT 1`);
const day = d!.day;
const at = async (hhmm: string, dayStr = day) =>
  (await pool.query<{ t: Date }>(`SELECT ($1::date + $2::time) AT TIME ZONE 'Europe/Warsaw' t`, [dayStr, hhmm])).rows[0]!.t.toISOString();

const server = createApp().listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const owner = new Browser(base);

const newAppt = (startsAt: string, phone: string, extra: Record<string, unknown> = {}) => ({
  serviceId: 1, startsAt, source: 'phone',
  customer: { fullName: 'Anna Nowak', phone },
  vehicle: { make: 'Toyota', model: 'Yaris', registrationNumber: `KR${phone.slice(-5)}` },
  ...extra,
});

try {
  // ================= UWIERZYTELNIANIE =================
  check('Bez logowania → 401', (await owner.req('GET', '/api/admin/calendar?from=' + day + '&to=' + day)).status === 401);
  check('Logowanie bez nagłówka Origin → 403', (await owner.req('POST', '/api/admin/auth/login', { email: 'owner@serwis.pl', password: PASS }, { origin: null })).status === 403);
  const wrong = await owner.req('POST', '/api/admin/auth/login', { email: 'owner@serwis.pl', password: 'zle-haslo-123' });
  const ghost = await owner.req('POST', '/api/admin/auth/login', { email: 'nikt@serwis.pl', password: 'zle-haslo-123' });
  check('Złe hasło i nieistniejący e-mail → identyczna odpowiedź 401', wrong.status === 401 && ghost.status === 401 && wrong.body.error === ghost.body.error);

  const login = await owner.req('POST', '/api/admin/auth/login', { email: 'OWNER@serwis.pl', password: PASS });
  const atCookie = login.setCookies.find((c) => c.startsWith('sa_at=')) ?? '';
  const rtCookie = login.setCookies.find((c) => c.startsWith('sa_rt=')) ?? '';
  check('Logowanie → 200 + token CSRF', login.status === 200 && owner.csrf.length > 20);
  check('Ciasteczka: HttpOnly, SameSite=Strict; refresh tylko dla /api/admin/auth',
    /HttpOnly/i.test(atCookie) && /SameSite=Strict/i.test(atCookie) && /Path=\/api\/admin\/auth/i.test(rtCookie));
  check('GET /auth/me', (await owner.req('GET', '/api/admin/auth/me')).body?.admin?.role === 'owner');

  check('Zmiana stanu bez tokenu CSRF → 403', (await owner.req('POST', '/api/admin/appointments', newAppt(await at('09:00'), '+48601000001'), { csrf: false })).status === 403);
  check('Zmiana stanu z obcego Origin → 403', (await owner.req('POST', '/api/admin/appointments', newAppt(await at('09:00'), '+48601000001'), { origin: 'https://evil.example' })).status === 403);
  check('Zły token CSRF → 403', (await owner.req('POST', '/api/admin/appointments', newAppt(await at('09:00'), '+48601000001'), { headers: { 'X-CSRF-Token': 'x'.repeat(43) }, csrf: false })).status === 403);

  // ================= RĘCZNE WIZYTY =================
  const t10 = await at('10:00');
  const a1 = await owner.req('POST', '/api/admin/appointments', newAppt(t10, '+48601000001'));
  check('Wizyta telefoniczna (nowy klient) → 201, stanowisko 1', a1.status === 201 && a1.body.appointment.stationId === 1 && a1.body.existingCustomer === false);
  check('…z potwierdzeniem i przypomnieniem SMS', a1.body.appointment.notifications.map((n: { kind: string }) => n.kind).sort().join() === 'confirmation,reminder_24h');

  check('Wskazane zajęte stanowisko → 409 STATION_TAKEN',
    (await owner.req('POST', '/api/admin/appointments', newAppt(t10, '+48601000002', { stationId: 1 }))).body.error === 'STATION_TAKEN');
  const a2 = await owner.req('POST', '/api/admin/appointments', newAppt(t10, '+48601000002', { source: 'walk_in', notifyCustomer: false }));
  check('Klient „z ulicy” bez SMS → stanowisko 2, brak powiadomień', a2.status === 201 && a2.body.appointment.stationId === 2 && a2.body.appointment.notifications.length === 0);
  check('Trzecia wizyta o 10:00 → 409 SLOT_TAKEN', (await owner.req('POST', '/api/admin/appointments', newAppt(t10, '+48601000003'))).body.error === 'SLOT_TAKEN');

  const t18 = await at('18:00');
  check('Poza godzinami bez zgody → 422', (await owner.req('POST', '/api/admin/appointments', newAppt(t18, '+48601000003'))).body?.error === 'OUTSIDE_BUSINESS_HOURS');
  check('Poza godzinami z allowOutsideHours → 201', (await owner.req('POST', '/api/admin/appointments', newAppt(t18, '+48601000003', { allowOutsideHours: true }))).status === 201);

  const existing = await owner.req('POST', '/api/admin/appointments', newAppt(await at('08:00'), '+48601000001', { customer: { fullName: 'Inne Nazwisko', phone: '601 000 001' } }));
  check('Istniejący numer → przypięcie do istniejącego klienta, imię bez zmian',
    existing.body.existingCustomer === true && existing.body.appointment.customer.fullName === 'Anna Nowak');

  const idemKey = randomUUID();
  const i1 = await owner.req('POST', '/api/admin/appointments', newAppt(await at('08:15'), '+48601000009'), { headers: { 'Idempotency-Key': idemKey } });
  const i2 = await owner.req('POST', '/api/admin/appointments', newAppt(await at('08:15'), '+48601000009'), { headers: { 'Idempotency-Key': idemKey } });
  check('Idempotency-Key w panelu (podwójne kliknięcie) → ta sama wizyta', i1.status === 201 && i2.status === 200 && i1.body.appointment.id === i2.body.appointment.id);

  // ================= PRZESUWANIE I WERSJONOWANIE =================
  const id1 = a1.body.appointment.id as string;
  const mv = await owner.req('PATCH', `/api/admin/appointments/${id1}`, { lockVersion: 1, startsAt: await at('11:00') });
  const kinds = (mv.body.appointment.notifications as { kind: string; status: string }[]).map((n) => `${n.kind}:${n.status}`).sort().join(' ');
  check('Przesunięcie 10:00 → 11:00', mv.status === 200 && mv.body.appointment.lockVersion === 2 && mv.body.appointment.startsAt === await at('11:00'));
  check('…stare przypomnienie anulowane, nowe zaplanowane, SMS o zmianie', kinds === 'confirmation:pending reminder_24h:cancelled reminder_24h:pending reschedule:pending', kinds);
  check('Edycja nieaktualnej wersji → 409 STALE_VERSION',
    (await owner.req('PATCH', `/api/admin/appointments/${id1}`, { lockVersion: 1, adminNotes: 'x' })).body?.details?.currentLockVersion === 2);
  check('„Zakończona” dla przyszłej wizyty → 422',
    (await owner.req('PATCH', `/api/admin/appointments/${id1}`, { lockVersion: 2, status: 'completed' })).status === 422);

  // wyścig: 5 równoległych przesunięć różnych wizyt na ten sam termin 15:00
  const racers: string[] = [];
  for (const [i, hh] of ['13:00', '13:15', '13:30', '13:45', '14:00'].entries()) {
    racers.push((await owner.req('POST', '/api/admin/appointments', newAppt(await at(hh), `+4860200000${i}`))).body.appointment.id);
  }
  const t15 = await at('15:00');
  const raced = await Promise.all(racers.map((id) => owner.req('PATCH', `/api/admin/appointments/${id}`, { lockVersion: 1, startsAt: t15 })));
  const ok = raced.filter((r) => r.status === 200).length;
  check('5 równoległych przesunięć na 15:00 → 2 udane, 3×409', ok === 2 && raced.filter((r) => r.status === 409).length === 3, raced.map((r) => r.status).join(','));

  // przesunięcie na inny dzień (blokada dwóch dni naraz)
  const nextDay = (await pool.query<{ d: string }>(`SELECT to_char($1::date + 1, 'YYYY-MM-DD') d`, [day])).rows[0]!.d;
  const loser = racers[raced.findIndex((r) => r.status === 409)]!; // wizyta, która przegrała wyścig, ma nadal lockVersion 1
  const crossDay = await owner.req('PATCH', `/api/admin/appointments/${loser}`, { lockVersion: 1, startsAt: await at('09:00', nextDay) });
  check('Przesunięcie na inny dzień (blokada 2 dni w ustalonej kolejności)', crossDay.status === 200, String(crossDay.status));

  // ================= ANULOWANIE =================
  const cancel = await owner.req('POST', `/api/admin/appointments/${id1}/cancel`, { lockVersion: 2, reason: 'Klient zadzwonił', notifyCustomer: true });
  const ck = (cancel.body.appointment.notifications as { kind: string; status: string }[]).filter((n) => n.status === 'pending').map((n) => n.kind).join();
  check('Anulowanie → oczekujące SMS-y anulowane, SMS o anulowaniu', cancel.status === 200 && cancel.body.appointment.status === 'cancelled' && ck === 'cancellation', ck);
  check('Ponowne anulowanie → 409', (await owner.req('POST', `/api/admin/appointments/${id1}/cancel`, {})).status === 409);
  const { rows: [ob] } = await pool.query(`SELECT count(*)::int n FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'appointment.cancelled'`, [id1]);
  check('Outbox: appointment.cancelled (worker zdejmie event z Google Calendar)', ob.n === 1);

  // ================= BLOKADY STANOWISK =================
  await owner.req('POST', '/api/admin/appointments', newAppt(await at('16:00'), '+48603000001', { stationId: 1 }));
  const blk = await owner.req('POST', '/api/admin/blocks', { stationId: 1, startsAt: await at('16:00'), endsAt: await at('17:00'), reason: 'Serwis podnośnika' });
  check('Blokada stanowiska → 201 + lista kolidujących wizyt', blk.status === 201 && blk.body.conflicts.length === 1);
  const pub = async () => ((await (await fetch(`${base}/api/public/availability?serviceId=1&date=${day}`)).json()) as { slots: { startsAt: string }[] }).slots.map((s) => s.startsAt);
  check('Publicznie 16:30 nadal dostępne (stanowisko 2 wolne)', (await pub()).includes(await at('16:30')));
  const blkAll = await owner.req('POST', '/api/admin/blocks', { stationId: null, startsAt: await at('16:30'), endsAt: await at('17:00') });
  check('Blokada całego serwisu → 16:30 znika z rezerwacji online', blkAll.status === 201 && !(await pub()).includes(await at('16:30')));
  check('Usunięcie blokady', (await owner.req('DELETE', `/api/admin/blocks/${blkAll.body.id}`)).status === 204 && (await pub()).includes(await at('16:30')));

  // ================= KALENDARZ =================
  const cal = await owner.req('GET', `/api/admin/calendar?from=${day}&to=${nextDay}`);
  check('Kalendarz: stanowiska, godziny otwarcia, wizyty, blokady',
    cal.status === 200 && cal.body.stations.length === 2 && cal.body.openingHours.length === 2 && cal.body.appointments.length >= 8 && cal.body.blocks.length === 1,
    `wizyt: ${cal.body.appointments.length}, anulowane ukryte: ${!cal.body.appointments.some((a: { status: string }) => a.status === 'cancelled')}`);
  check('Kalendarz: zakres > 6 tygodni → 422', (await owner.req('GET', `/api/admin/calendar?from=2026-01-01&to=2026-12-31`)).status === 422);

  // ================= KLIENCI =================
  const byPlate = await owner.req('GET', '/api/admin/customers?q=kr 00001');
  const byPhone = await owner.req('GET', '/api/admin/customers?q=601 000 001');
  const byName = await owner.req('GET', '/api/admin/customers?q=nowak');
  check('Wyszukiwanie po tablicy / telefonie / nazwisku', byPlate.body.total >= 1 && byPhone.body.total === 1 && byName.body.total >= 5,
    `tablica ${byPlate.body.total}, telefon ${byPhone.body.total}, nazwisko ${byName.body.total}`);
  const inj = await owner.req('GET', `/api/admin/customers?q=${encodeURIComponent("' OR 1=1 --")}`);
  const wild = await owner.req('GET', `/api/admin/customers?q=${encodeURIComponent('%')}`);
  check('SQL injection i znaki wieloznaczne LIKE traktowane dosłownie', inj.status === 200 && inj.body.total === 0 && wild.body.total === 0);

  const custId = byPhone.body.customers[0].id as string;
  const card = await owner.req('GET', `/api/admin/customers/${custId}`);
  const { rows: [aud] } = await pool.query(`SELECT count(*)::int n FROM audit_log WHERE action = 'customer.view' AND entity_id = $1`, [custId]);
  check('Karta klienta: pojazdy i historia wizyt; odczyt zapisany w audycie', card.body.customer.vehicles.length === 1 && card.body.customer.appointments.length >= 2 && aud.n === 1);
  check('Zmiana telefonu na numer innego klienta → 409 PHONE_IN_USE',
    (await owner.req('PATCH', `/api/admin/customers/${custId}`, { phone: '+48601000002' })).body?.error === 'PHONE_IN_USE');
  const veh = await owner.req('PATCH', `/api/admin/vehicles/${card.body.customer.vehicles[0].id}`, { tireSize: '205/55 r16' });
  check('Edycja pojazdu (rozmiar opon)', veh.body.vehicle?.tireSize === '205/55 R16');

  // ================= UPRAWNIENIA I RODO =================
  const staff = new Browser(base);
  await staff.req('POST', '/api/admin/auth/login', { email: 'staff@serwis.pl', password: PASS });
  check('Pracownik nie może anonimizować → 403', (await staff.req('POST', `/api/admin/customers/${custId}/anonymize`)).status === 403);
  check('Anonimizacja klienta z przyszłą wizytą → 409', (await owner.req('POST', `/api/admin/customers/${custId}/anonymize`)).status === 409);
  for (const a of card.body.customer.appointments.filter((x: { status: string }) => x.status === 'confirmed')) {
    await owner.req('POST', `/api/admin/appointments/${a.id}/cancel`, { notifyCustomer: false });
  }
  const anon = await owner.req('POST', `/api/admin/customers/${custId}/anonymize`);
  const { rows: [after] } = await pool.query(`SELECT full_name, phone_e164, (SELECT count(*)::int FROM appointments WHERE customer_id = $1) visits FROM customers WHERE id = $1`, [custId]);
  check('Anonimizacja → dane usunięte, historia wizyt zachowana', anon.status === 204 && after.full_name === null && after.phone_e164 === null && after.visits >= 2);

  // ================= CYKL ŻYCIA SESJI =================
  const oldRefresh = owner.jar.get('sa_rt')!.value;
  const r1 = await owner.req('POST', '/api/admin/auth/refresh');
  check('Refresh → nowe tokeny', r1.status === 200 && owner.jar.get('sa_rt')!.value !== oldRefresh);
  const thief = new Browser(base);
  thief.jar.set('sa_rt', { value: oldRefresh, path: '/api/admin/auth' });
  const race = await thief.req('POST', '/api/admin/auth/refresh');
  check('Stary refresh w ciągu 30 s → REFRESH_RACE, sesja właściciela nietknięta',
    race.body?.error === 'REFRESH_RACE' && (await owner.req('GET', '/api/admin/auth/me')).status === 200);
  await pool.query(`UPDATE admin_sessions SET revoked_at = now() - interval '5 minutes' WHERE refresh_token_hash = sha256($1::bytea)`, [Buffer.from(oldRefresh)]);
  const reuse = await thief.req('POST', '/api/admin/auth/refresh');
  check('Stary refresh po 30 s (kradzież) → wszystkie sesje unieważnione',
    reuse.body?.error === 'SESSION_REVOKED' && (await owner.req('GET', '/api/admin/auth/me')).status === 401);

  await owner.req('POST', '/api/admin/auth/login', { email: 'owner@serwis.pl', password: PASS });
  const rtBefore = owner.jar.get('sa_rt')!.value;
  await owner.req('POST', '/api/admin/auth/logout');
  const ghostBrowser = new Browser(base);
  ghostBrowser.jar.set('sa_rt', { value: rtBefore, path: '/api/admin/auth' });
  check('Wylogowanie → refresh token martwy', (await ghostBrowser.req('POST', '/api/admin/auth/refresh')).status === 401);

  const brute = new Browser(base);
  for (let i = 0; i < config.LOGIN_MAX_FAILED_ATTEMPTS; i++) await brute.req('POST', '/api/admin/auth/login', { email: 'staff@serwis.pl', password: 'zgadywanie-' + i });
  const lockedLogin = await brute.req('POST', '/api/admin/auth/login', { email: 'staff@serwis.pl', password: PASS });
  check(`Po ${config.LOGIN_MAX_FAILED_ATTEMPTS} błędnych próbach konto zablokowane (nawet poprawne hasło → 401)`, lockedLogin.status === 401);
} finally {
  server.close();
  await pool.end();
}
console.log(failures ? `\n${failures} test(ów) nie przeszło` : '\nWszystkie testy przeszły');
process.exit(failures ? 1 : 0);
