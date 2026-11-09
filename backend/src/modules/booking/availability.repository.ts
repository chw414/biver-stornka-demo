import type { Db } from '../../db.js';

export interface SlotRow {
  day: string;            // RRRR-MM-DD (czas lokalny serwisu)
  starts_at: Date;
  ends_at: Date;
  free_station_ids: number[];
}

/**
 * Wylicza sloty w zakresie dni [from, to] dla usługi trwającej durationMin.
 *
 * Godziny pracy są w czasie lokalnym (time), sloty powstają jako
 *   (dzień + godzina_otwarcia + n·15 min) AT TIME ZONE tz
 * czyli arytmetyka odbywa się w czasie lokalnym — poprawnie przy zmianie czasu (DST).
 *
 * Dla każdego kandydata zwracamy listę wolnych stanowisk: aktywnych, bez nakładającej się
 * aktywnej wizyty i bez blokady (stanowiska lub całego serwisu). Zapytanie o kolizje wizyt
 * trafia w indeks GiST z constraintu appt_no_overlap_per_station.
 *
 * exactStart != null → tylko jeden konkretny start (używane w transakcji rezerwacji).
 * leadMin = null → bez minimalnego wyprzedzenia (panel admina, np. wpis wizyty „z ulicy”).
 */
export async function findSlots(
  db: Db,
  p: { from: string; to: string; durationMin: number; timezone: string; leadMin: number | null; exactStart?: string | null },
): Promise<SlotRow[]> {
  const { rows } = await db.query<SlotRow>(
    `
    WITH days AS (
      SELECT d::date AS day FROM generate_series($1::date, $2::date, interval '1 day') AS d
    ),
    windows AS (
      SELECT d.day, e.opens_at, e.closes_at
        FROM days d JOIN schedule_exceptions e ON e.day = d.day
       WHERE e.opens_at IS NOT NULL
      UNION ALL
      SELECT d.day, bh.opens_at, bh.closes_at
        FROM days d JOIN business_hours bh ON bh.iso_weekday = EXTRACT(ISODOW FROM d.day)::int
       WHERE NOT EXISTS (SELECT 1 FROM schedule_exceptions e WHERE e.day = d.day)
    ),
    candidates AS (
      SELECT w.day,
             ((w.day + w.opens_at) + n * interval '15 minutes') AT TIME ZONE $4 AS starts_at
        FROM windows w
       CROSS JOIN LATERAL generate_series(
               0,
               ((EXTRACT(EPOCH FROM (w.closes_at - w.opens_at)) / 60)::int - $3::int) / 15
             ) AS n
    ),
    slots AS (
      SELECT c.day, c.starts_at,
             c.starts_at + make_interval(mins => $3::int) AS ends_at
        FROM candidates c
       WHERE ($5::int IS NULL OR c.starts_at >= now() + make_interval(mins => $5::int))
         AND ($6::timestamptz IS NULL OR c.starts_at = $6::timestamptz)
    )
    SELECT to_char(sl.day, 'YYYY-MM-DD') AS day,
           sl.starts_at,
           sl.ends_at,
           COALESCE(
             array_agg(s.id ORDER BY s.sort_order, s.id) FILTER (WHERE s.id IS NOT NULL),
             '{}'
           )::int[] AS free_station_ids
      FROM slots sl
      LEFT JOIN stations s
        ON s.is_active
       AND NOT EXISTS (
             SELECT 1 FROM appointments a
              WHERE a.station_id = s.id
                AND a.status IN ('confirmed', 'completed')
                AND tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(sl.starts_at, sl.ends_at, '[)')
           )
       AND NOT EXISTS (
             SELECT 1 FROM station_blocks b
              WHERE (b.station_id IS NULL OR b.station_id = s.id)
                AND b.during && tstzrange(sl.starts_at, sl.ends_at, '[)')
           )
     GROUP BY sl.day, sl.starts_at, sl.ends_at
     ORDER BY sl.starts_at
    `,
    [p.from, p.to, p.durationMin, p.timezone, p.leadMin, p.exactStart ?? null],
  );
  return rows;
}

/** Dzisiejsza data i dzień danego momentu — liczone w strefie serwisu po stronie bazy. */
export async function localDates(db: Db, timezone: string, instant?: string) {
  const { rows } = await db.query<{ today: string; day: string | null }>(
    `SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS today,
            to_char(($2::timestamptz AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS day`,
    [timezone, instant ?? null],
  );
  return rows[0]!;
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Wolne stanowiska dla dowolnego przedziału (bez sprawdzania godzin pracy).
 * excludeAppointmentId — przy przesuwaniu wizyty nie koliduje ona sama ze sobą.
 */
export async function findFreeStations(
  db: Db,
  p: { startsAt: Date | string; endsAt: Date | string; excludeAppointmentId?: string | null },
): Promise<number[]> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT s.id FROM stations s
      WHERE s.is_active
        AND NOT EXISTS (
              SELECT 1 FROM appointments a
               WHERE a.station_id = s.id
                 AND a.status IN ('confirmed', 'completed')
                 AND a.id IS DISTINCT FROM $3::uuid
                 AND tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange($1::timestamptz, $2::timestamptz, '[)'))
        AND NOT EXISTS (
              SELECT 1 FROM station_blocks b
               WHERE (b.station_id IS NULL OR b.station_id = s.id)
                 AND b.during && tstzrange($1::timestamptz, $2::timestamptz, '[)'))
      ORDER BY s.sort_order, s.id`,
    [p.startsAt, p.endsAt, p.excludeAppointmentId ?? null],
  );
  return rows.map((r) => r.id);
}
