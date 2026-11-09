/**
 * Konfiguracja serwisu Biver (Brzesko): cennik wulkanizacji, godziny pracy, informacje o cenach.
 * Bezpieczne do ponownego uruchomienia — aktualizuje usługi po slugu, usuwa nieużywane stare usługi
 * (te, do których są już wizyty, tylko dezaktywuje) i zastępuje godziny pracy.
 *
 *   npm run setup:biver              # produkcja i development
 *   npm run setup:biver -- --dev     # + testowe dokumenty prawne i konto właściciela (NIGDY w produkcji)
 *
 * Cały system opiera się na wizytach 15-minutowych (jedna zmiana opon = jeden slot 15 min).
 * Ceny z cennika wiszącego w serwisie; zmiana ceny = zmiana tutaj i ponowne uruchomienie skryptu.
 */
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { hashPassword } from '../src/modules/auth/password.js';

const { values } = parseArgs({ options: { dev: { type: 'boolean', default: false } } });
if (values.dev && process.env.NODE_ENV === 'production') { console.error('--dev jest zablokowane w produkcji'); process.exit(1); }

const D = 15; // minut — czas jednej wizyty

interface Variant { slug: string; short: string; price: number }
interface Group { category: string; nameBase: string; note: string; variants: Variant[] }

const SIZE = {
  s1314: '13"–14"', s1516: '15"–16"', s15: '15"', s16: '16"',
  s17: '17" oraz 16" SUV', s18: '18" oraz 17" SUV', s1920: '19", 20" i RunFlat', s21: '21" i większe',
  van: 'Samochody dostawcze', twin: 'Koła bliźniacze',
};

const GROUPS: Group[] = [
  {
    category: 'Wymiana opon — felga stalowa', nameBase: 'Wymiana opon, felga stalowa',
    note: 'Zdejmowanie i zakładanie opon na felgach.',
    variants: [
      { slug: 'opony-stal-13-14', short: SIZE.s1314, price: 150 },
      { slug: 'opony-stal-15-16', short: SIZE.s1516, price: 160 },
      { slug: 'opony-stal-17', short: SIZE.s17, price: 170 },
      { slug: 'opony-stal-dostawcze', short: SIZE.van, price: 220 },
      { slug: 'opony-stal-bliznak', short: SIZE.twin, price: 350 },
    ],
  },
  {
    category: 'Wymiana opon — felga aluminiowa', nameBase: 'Wymiana opon, felga aluminiowa',
    note: 'Zdejmowanie i zakładanie opon na felgach.',
    variants: [
      { slug: 'opony-alu-13-14', short: SIZE.s1314, price: 160 },
      { slug: 'opony-alu-15-16', short: SIZE.s1516, price: 180 },
      { slug: 'opony-alu-17', short: SIZE.s17, price: 220 },
      { slug: 'opony-alu-18', short: SIZE.s18, price: 240 },
      { slug: 'opony-alu-19-20', short: SIZE.s1920, price: 320 },
      { slug: 'opony-alu-21', short: SIZE.s21, price: 380 },
      { slug: 'opony-alu-dostawcze', short: SIZE.van, price: 260 },
    ],
  },
  {
    category: 'Wymiana kół — felga stalowa', nameBase: 'Wymiana kół, felga stalowa',
    note: 'Przekładanie całych kół (opony już założone na felgach).',
    variants: [
      { slug: 'kola-stal-13-14', short: SIZE.s1314, price: 110 },
      { slug: 'kola-stal-15', short: SIZE.s15, price: 130 },
      { slug: 'kola-stal-16', short: SIZE.s16, price: 140 },
      { slug: 'kola-stal-17', short: SIZE.s17, price: 150 },
      { slug: 'kola-stal-18', short: SIZE.s18, price: 170 },
      { slug: 'kola-stal-dostawcze', short: SIZE.van, price: 150 },
    ],
  },
  {
    category: 'Wymiana kół — felga aluminiowa', nameBase: 'Wymiana kół, felga aluminiowa',
    note: 'Przekładanie całych kół (opony już założone na felgach).',
    variants: [
      { slug: 'kola-alu-13-14', short: SIZE.s1314, price: 120 },
      { slug: 'kola-alu-15-16', short: SIZE.s1516, price: 150 },
      { slug: 'kola-alu-17', short: SIZE.s17, price: 150 },
      { slug: 'kola-alu-18', short: SIZE.s18, price: 170 },
      { slug: 'kola-alu-19-20', short: SIZE.s1920, price: 180 },
      { slug: 'kola-alu-21', short: SIZE.s21, price: 200 },
      { slug: 'kola-alu-dostawcze', short: SIZE.van, price: 180 },
    ],
  },
];

const PRICE_INFO = {
  note: 'Ceny za komplet, płatność na miejscu.',
  groupNotes: Object.fromEntries(GROUPS.map((g) => [g.category, g.note])),
  items: [
    { label: 'Czujniki w kole', price: '+40 zł/kpl.' },
    { label: 'Test drogowy', price: '+30 zł/koło' },
    { label: 'Zawór', price: '+5 zł/szt.' },
    { label: 'Utylizacja opony', price: '10 zł/szt.' },
    { label: 'Koła „nieprzelotowe” (przy wymianie kół)', price: '+40 zł/kpl.' },
    { label: 'Naprawa opony', price: 'od 80 zł' },
    { label: 'Worek na oponę', price: '2 zł' },
    { label: 'Przechowywanie opon', price: 'do 15": 100 zł, powyżej: 120 zł' },
    { label: 'Przechowywanie kół', price: 'do 15": 150 zł, powyżej: 180 zł' },
  ],
};

// godziny: pn–pt 7:00–17:00 z przerwą 12:00–12:30 (wtedy nie ma rezerwacji), sobota 8:00–12:00, niedziela zamknięte
const HOURS: [number, string, string][] = [
  ...[1, 2, 3, 4, 5].flatMap((d): [number, string, string][] => [[d, '07:00', '12:00'], [d, '12:30', '17:00']]),
  [6, '08:00', '12:00'],
];

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  await db.query('BEGIN');

  // --- usługi ---
  const slugs: string[] = [];
  let order = 0;
  for (const g of GROUPS) {
    for (const v of g.variants) {
      order += 10;
      slugs.push(v.slug);
      await db.query(
        `INSERT INTO services (slug, name, category, short_name, duration_minutes, price_from_pln, is_active, is_public, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,true,true,$7)
         ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name, category=EXCLUDED.category, short_name=EXCLUDED.short_name,
           duration_minutes=EXCLUDED.duration_minutes, price_from_pln=EXCLUDED.price_from_pln,
           is_active=true, is_public=true, sort_order=EXCLUDED.sort_order, updated_at=now()`,
        [v.slug, `${g.nameBase} ${v.short}`, g.category, v.short, D, v.price, order]);
    }
  }
  const { rowCount: removed } = await db.query(
    `DELETE FROM services s WHERE s.slug <> ALL($1) AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.service_id = s.id)`, [slugs]);
  const { rowCount: hidden } = await db.query(
    `UPDATE services SET is_active=false, is_public=false WHERE slug <> ALL($1) AND is_active`, [slugs]);

  // --- godziny pracy ---
  await db.query('DELETE FROM business_hours');
  for (const [d, o, c] of HOURS) await db.query('INSERT INTO business_hours (iso_weekday, opens_at, closes_at) VALUES ($1,$2,$3)', [d, o, c]);

  // --- informacje o cenach, odstęp między terminami ---
  await db.query(
    `INSERT INTO app_settings (key, value) VALUES ('price_info', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(PRICE_INFO)]);

  // --- tylko development: testowe dokumenty prawne i konto właściciela ---
  if (values.dev) {
    const sha = (t: string) => createHash('sha256').update(t).digest();
    await db.query(
      `INSERT INTO legal_documents (kind, version, content_sha256, url, display_text) VALUES
         ('terms','test-1',$1,'/regulamin',NULL), ('privacy','test-1',$2,'/prywatnosc',NULL),
         ('whatsapp','test-1',$3,'/prywatnosc#whatsapp',$4)
       ON CONFLICT (kind, version) DO NOTHING`,
      [sha('TESTOWY regulamin'), sha('TESTOWA polityka'), sha('TESTOWA zgoda'),
       'TESTOWE: Chcę otrzymać potwierdzenie i przypomnienie o wizycie na WhatsApp od Biver Brzesko. Mogę zrezygnować, odpisując STOP.']);
    await db.query(
      `INSERT INTO admins (email, password_hash, full_name, role) VALUES ('wlasciciel@biver.test', $1, 'Właściciel (test)', 'owner')
       ON CONFLICT (email) DO NOTHING`, [await hashPassword('Biver-Test-2026')]);
  }

  await db.query('COMMIT');
  console.log(`Gotowe: ${slugs.length} usług po ${D} min, godziny pracy, informacje o cenach.`);
  if (removed || hidden) console.log(`Stare usługi: usunięto ${removed ?? 0}, ukryto (mają wizyty) ${hidden ?? 0}.`);
  if (values.dev) console.log('DEV: konto wlasciciel@biver.test / Biver-Test-2026 oraz testowe dokumenty prawne.');
} catch (e) {
  await db.query('ROLLBACK').catch(() => undefined);
  throw e;
} finally {
  await db.end();
}
