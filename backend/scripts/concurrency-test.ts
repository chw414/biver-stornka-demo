/**
 * Test integracyjny API rezerwacji — TYLKO na bazie developerskiej/testowej (tworzy dane).
 * Uruchomienie: npm run test:concurrency
 * Najważniejszy scenariusz: N klientów w tej samej chwili rezerwuje ten sam termin.
 * Przy 2 stanowiskach dokładnie 2 żądania mają dostać 201, reszta 409.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';

const PARALLEL = Number(process.env.PARALLEL ?? 20);
let failures = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

// dokumenty prawne są wymagane do zapisu zgód (w produkcji publikuje je admin)
await pool.query(`
  INSERT INTO legal_documents (kind, version, content_sha256, url)
  VALUES ('terms', 'test-1', sha256('t'::bytea), 'https://example.com/regulamin'),
         ('privacy', 'test-1', sha256('p'::bytea), 'https://example.com/prywatnosc')
  ON CONFLICT DO NOTHING`);

// najbliższy poniedziałek co najmniej 2 dni od dziś (czas lokalny serwisu)
const { rows: [d] } = await pool.query<{ day: string }>(`
  SELECT to_char(x, 'YYYY-MM-DD') AS day FROM generate_series(
    (now() AT TIME ZONE 'Europe/Warsaw')::date + 2, (now() AT TIME ZONE 'Europe/Warsaw')::date + 9, '1 day') x
  WHERE EXTRACT(ISODOW FROM x) = 1 LIMIT 1`);
const day = d!.day;
const at = async (hhmm: string) =>
  (await pool.query<{ t: Date }>(`SELECT ($1::date + $2::time) AT TIME ZONE 'Europe/Warsaw' AS t`, [day, hhmm])).rows[0]!.t.toISOString();

const server = createApp().listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/public`;

const book = (body: object, key = randomUUID()) =>
  fetch(`${base}/bookings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });

const payload = (i: number, startsAt: string, serviceId = 1) => ({
  serviceId,
  startsAt,
  fullName: `Klient Testowy`,
  phone: `600 100 ${String(200 + i).padStart(3, '0')}`,
  vehicle: { make: 'Skoda', model: 'Octavia', registrationNumber: `wa ${10000 + i}` },
  acceptTerms: true,
});

try {
  const services = (await (await fetch(`${base}/services`)).json()) as { services: { id: number; slug: string; durationMinutes: number }[] };
  const tyres = services.services.find((s) => s.slug === 'wymiana-opon')!;
  const balance = services.services.find((s) => s.slug === 'wywazanie-kol')!;
  check('GET /services', services.services.length > 0, `${services.services.length} usług`);

  const av = (await (await fetch(`${base}/availability?serviceId=${tyres.id}&date=${day}`)).json()) as { slots: { startsAt: string }[] };
  check('Sloty 15-min w poniedziałek 08–17', av.slots.length === 36, `${av.slots.length} slotów, dzień ${day}`);

  // ---------- WYŚCIG: PARALLEL klientów, ten sam termin ----------
  const t10 = await at('10:00');
  const results = await Promise.all(Array.from({ length: PARALLEL }, (_, i) => book(payload(i, t10, tyres.id))));
  const codes = results.map((r) => r.status);
  const created = codes.filter((c) => c === 201).length;
  const conflicts = codes.filter((c) => c === 409).length;
  check(`Wyścig ${PARALLEL} żądań o 10:00 → 2×201, reszta 409`, created === 2 && conflicts === PARALLEL - 2,
    `201: ${created}, 409: ${conflicts}, inne: ${codes.filter((c) => c !== 201 && c !== 409).join(',') || 'brak'}`);

  const { rows: [db] } = await pool.query<{ n: string; stations: string }>(
    `SELECT count(*) n, string_agg(station_id::text, ',' ORDER BY station_id) stations
       FROM appointments WHERE starts_at = $1 AND status = 'confirmed'`, [t10]);
  check('W bazie dokładnie 2 wizyty o 10:00 na różnych stanowiskach', db!.n === '2' && db!.stations === '1,2', `stanowiska: ${db!.stations}`);

  const av2 = (await (await fetch(`${base}/availability?serviceId=${tyres.id}&date=${day}`)).json()) as { slots: { startsAt: string }[] };
  check('10:00 znika z dostępnych terminów', !av2.slots.some((s) => s.startsAt === t10) && av2.slots.length === 35);

  // usługa 30-min o 9:45 zachodzi na 10:00–10:15 → oba stanowiska zajęte
  const t0945 = await at('09:45');
  const r30 = await book(payload(50, t0945, balance.id));
  check('Usługa 30 min 09:45 nachodząca na pełne 10:00 → 409', r30.status === 409);
  const avBal = (await (await fetch(`${base}/availability?serviceId=${balance.id}&date=${day}`)).json()) as { slots: { startsAt: string }[] };
  check('Dla usługi 30 min 09:45 nie jest oferowane', !avBal.slots.some((s) => s.startsAt === t0945));

  // ---------- Idempotencja ----------
  const key = randomUUID();
  const t11 = await at('11:00');
  const first = await book(payload(60, t11, tyres.id), key);
  const again = await book(payload(60, t11, tyres.id), key);
  const [b1, b2] = (await Promise.all([first.json(), again.json()])) as { appointment: { referenceCode: string } }[];
  check('Powtórzone żądanie z tym samym Idempotency-Key → 200, ta sama wizyta',
    first.status === 201 && again.status === 200 && b1!.appointment.referenceCode === b2!.appointment.referenceCode,
    `${first.status}/${again.status}, kod ${b1!.appointment.referenceCode}`);
  const reuse = await book(payload(60, await at('12:00'), tyres.id), key);
  check('Ten sam klucz dla innego terminu → 422', reuse.status === 422);

  // ---------- Walidacja i reguły terminów ----------
  const off = await book(payload(70, await at('10:05'), tyres.id));
  check('Termin poza siatką 15 min → 422', off.status === 422);
  const late = await book(payload(71, await at('17:00'), tyres.id));
  check('Termin o zamknięciu (17:00) → 422', late.status === 422);
  const bad = await book({ ...payload(72, t11), phone: '123', fullName: '<script>', acceptTerms: false, vehicle: { make: 'A', model: 'B', registrationNumber: '!!' } });
  const badBody = (await bad.json()) as { details: { path: string }[] };
  check('Złe dane → 400 z listą pól', bad.status === 400, badBody.details.map((x) => x.path).join(', '));
  const extra = await book({ ...payload(73, t11), isAdmin: true });
  check('Nieznane pola (mass assignment) → 400', extra.status === 400);
  const noKey = await fetch(`${base}/bookings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload(74, t11)) });
  check('Brak Idempotency-Key → 400', noKey.status === 400);

  // ---------- Normalizacja i ochrona danych istniejącego klienta ----------
  const r = await book({ ...payload(0, await at('13:00'), tyres.id), fullName: 'Ktoś Podszywający' });
  const { rows: [c] } = await pool.query<{ full_name: string; booked_full_name: string; registration_number: string }>(
    `SELECT c.full_name, a.booked_full_name, v.registration_number FROM appointments a
       JOIN customers c ON c.id = a.customer_id JOIN vehicles v ON v.id = a.vehicle_id
      WHERE a.starts_at = $1`, [await at('13:00')]);
  check('Istniejący klient: imię NIE nadpisane, wpis zachowany przy wizycie',
    r.status === 201 && c!.full_name === 'Klient Testowy' && c!.booked_full_name === 'Ktoś Podszywający',
    `tablica znormalizowana: ${c!.registration_number}`);

  // ---------- Limit na numer telefonu (domyślnie 3/h) ----------
  const statuses: number[] = [];
  for (const hh of ['14:00', '14:15', '14:30', '14:45']) statuses.push((await book(payload(90, await at(hh), tyres.id))).status);
  check('Limit rezerwacji na numer telefonu → 429', statuses.at(-1) === 429, statuses.join(','));

  // ---------- Skutki uboczne w tej samej transakcji ----------
  const { rows: [side] } = await pool.query<Record<string, string>>(`
    SELECT (SELECT count(*) FROM appointments)                                AS appointments,
           (SELECT count(*) FROM notifications WHERE kind = 'confirmation')  AS confirmations,
           (SELECT count(*) FROM notifications WHERE kind = 'reminder_24h')  AS reminders,
           (SELECT count(*) FROM outbox_events)                              AS outbox,
           (SELECT count(*) FROM customer_consents)                          AS consents`);
  const n = Number(side!.appointments);
  check('Każda wizyta: potwierdzenie + przypomnienie + outbox + 2 zgody',
    Number(side!.confirmations) === n && Number(side!.reminders) === n && Number(side!.outbox) === n && Number(side!.consents) === 2 * n,
    JSON.stringify(side));

  const days = (await (await fetch(`${base}/availability/days?serviceId=${tyres.id}&from=${day}&to=${day}`)).json()) as { days: string[] };
  check('GET /availability/days', days.days.includes(day));
} finally {
  server.close();
  await pool.end();
}

console.log(failures ? `\n${failures} test(ów) nie przeszło` : '\nWszystkie testy przeszły');
process.exit(failures ? 1 : 0);
