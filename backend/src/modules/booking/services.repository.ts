import type { Db } from '../../db.js';

export interface ServiceRow {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  duration_minutes: number;
  price_from_pln: string | null;
  category: string | null;
  short_name: string | null;
}

export async function listPublicServices(db: Db): Promise<ServiceRow[]> {
  const { rows } = await db.query<ServiceRow>(
    `SELECT id, slug, name, description, duration_minutes, price_from_pln, category, short_name
       FROM services WHERE is_active AND is_public
      ORDER BY sort_order, name`,
  );
  return rows;
}

export async function getPublicService(db: Db, id: number): Promise<ServiceRow | null> {
  const { rows } = await db.query<ServiceRow>(
    `SELECT id, slug, name, description, duration_minutes, price_from_pln, category, short_name
       FROM services WHERE id = $1 AND is_active AND is_public`,
    [id],
  );
  return rows[0] ?? null;
}
