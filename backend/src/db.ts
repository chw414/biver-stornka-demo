import pg from 'pg';
import { config } from './config.js';
import { logger } from './lib/logger.js';

// bigint/numeric jako string domyślnie — numeric (ceny) parsujemy świadomie tam, gdzie trzeba
export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
  application_name: 'serwis-booking-api',
  // JIT nie pomaga w krótkich zapytaniach OLTP, a planer (zawyżona estymacja generate_series)
  // włączał go dla zapytania o dostępność: ~370 ms zamiast ~3 ms — pod blokadą dnia to krytyczne.
  options: '-c jit=off',
});

pool.on('error', (err) => logger.error({ err }, 'Nieoczekiwany błąd puli PostgreSQL'));

export type Db = pg.Pool | pg.PoolClient;

/**
 * Wykonuje fn w transakcji (READ COMMITTED). Każde zapytanie w fn MUSI używać przekazanego klienta.
 * W READ COMMITTED każde kolejne zapytanie widzi dane zatwierdzone przed jego startem — dzięki temu
 * po zdobyciu blokady (SELECT ... FOR UPDATE) widzimy wizyty zapisane przez poprzednika w kolejce.
 */
export async function withTransaction<T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
