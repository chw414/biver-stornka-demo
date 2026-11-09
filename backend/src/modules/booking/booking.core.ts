import type pg from 'pg';

/**
 * Blokada pesymistyczna dni w strefie serwisu (SELECT ... FOR UPDATE na booking_day_locks).
 * Dni sortujemy i deduplikujemy — przy przesuwaniu wizyty między dniami dwie transakcje
 * blokujące te same dni w różnej kolejności mogłyby się zakleszczyć (deadlock).
 */
export async function lockDays(tx: pg.PoolClient, days: string[]): Promise<void> {
  const unique = [...new Set(days)].sort();
  await tx.query('INSERT INTO booking_day_locks (day) SELECT unnest($1::date[]) ON CONFLICT DO NOTHING', [unique]);
  for (const day of unique) {
    await tx.query('SELECT day FROM booking_day_locks WHERE day = $1 FOR UPDATE', [day]);
  }
}

/** Dzień (RRRR-MM-DD) danego momentu w strefie serwisu. */
export async function localDayOf(tx: pg.PoolClient, instant: Date | string, timezone: string): Promise<string> {
  const { rows } = await tx.query<{ day: string }>(
    `SELECT to_char(($1::timestamptz AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS day`,
    [instant, timezone],
  );
  return rows[0]!.day;
}
