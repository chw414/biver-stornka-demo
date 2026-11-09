/**
 * Dane demonstracyjne (TYLKO development): konta, klienci, wizyty na wczoraj–za 4 dni, blokada.
 *   npm run seed:demo
 * Konta: jan@oponymokotow.pl (owner) / marek@oponymokotow.pl (staff), hasła w zmiennych SEED_*_PASSWORD
 * lub domyślne poniżej.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { hashPassword } from '../src/modules/auth/password.js';

if (process.env.NODE_ENV === 'production') { console.error('seed:demo jest zablokowany w produkcji'); process.exit(1); }
const ownerPass = process.env.SEED_OWNER_PASSWORD ?? 'Haslo-Wlasciciela-2026';
const staffPass = process.env.SEED_STAFF_PASSWORD ?? 'Haslo-Pracownika-2026';

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  const { rows: [n] } = await db.query<{ n: number }>('SELECT count(*)::int n FROM appointments');
  if (n!.n > 0) { console.error('Baza nie jest pusta — seed:demo działa tylko na świeżej bazie.'); process.exit(1); }
  await db.query('BEGIN');
  await db.query(`INSERT INTO admins (email, password_hash, full_name, role) VALUES
    ('jan@oponymokotow.pl', $1, 'Jan Wiśniewski', 'owner'), ('marek@oponymokotow.pl', $2, 'Marek', 'staff')`,
    [await hashPassword(ownerPass), await hashPassword(staffPass)]);
  await db.query(await readFile(path.join(import.meta.dirname, 'seed-demo.sql'), 'utf8'));
  await db.query('COMMIT');
  console.log('Dane demo wczytane. Logowanie: jan@oponymokotow.pl / marek@oponymokotow.pl');
} catch (e) {
  await db.query('ROLLBACK').catch(() => undefined);
  throw e;
} finally {
  await db.end();
}
