// Migrator: wykonuje pliki z migrations/ w kolejności alfabetycznej, każdy dokładnie raz.
// Uruchamiany jako właściciel bazy (DDL). Jeśli ustawiono APP_DB_USER/APP_DB_PASSWORD, dodatkowo
// zakłada/aktualizuje rolę aplikacji o minimalnych uprawnieniach (bez DDL, audit_log tylko do dopisywania).
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const dir = process.env.MIGRATIONS_DIR
  ? path.resolve(process.env.MIGRATIONS_DIR)
  : path.resolve(import.meta.dirname, import.meta.dirname.endsWith('scripts') && import.meta.dirname.includes('dist')
      ? '../../migrations' : '../migrations');

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

async function ensureAppRole() {
  const user = process.env.APP_DB_USER;
  const password = process.env.APP_DB_PASSWORD;
  if (!user && !password) return;
  if (!user || !password) throw new Error('Ustaw jednocześnie APP_DB_USER i APP_DB_PASSWORD');
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(user)) throw new Error('APP_DB_USER: niedozwolone znaki');
  const { rows: [db] } = await client.query<{ name: string }>('SELECT current_database() AS name');
  // format(%I,%L) — poprawne cytowanie identyfikatora i literału (hasło może zawierać dowolne znaki)
  await client.query(`DO $$
    DECLARE r text := ${lit(user)}; p text := ${lit(password)};
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', r, p);
      ELSE
        EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', r, p);
      END IF;
    END $$`);
  const u = ident(user);
  await client.query(`GRANT CONNECT ON DATABASE ${ident(db!.name)} TO ${u}`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${u}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${u}`);
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${u}`);
  await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${u}`);
  await client.query(`REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM ${u}`);
  await client.query(`REVOKE ALL ON schema_migrations FROM ${u}`);
  console.log(`Rola aplikacji "${user}" zaktualizowana.`);
}
function ident(s: string) { return '"' + s.replaceAll('"', '""') + '"'; }
function lit(s: string) { return "'" + s.replaceAll("'", "''") + "'"; }

try {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  // blokada doradcza: dwie instancje startujące równolegle nie wykonają migracji podwójnie
  await client.query('SELECT pg_advisory_lock(727274)');
  const done = new Set(
    (await client.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename),
  );
  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    console.log(`→ ${file}`);
    await client.query(await readFile(path.join(dir, file), 'utf8')); // pliki mają własne BEGIN/COMMIT
    await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
  }
  await ensureAppRole();
  console.log('Migracje aktualne.');
} finally {
  await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
  await client.end();
}
