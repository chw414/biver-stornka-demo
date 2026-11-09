import type { Db } from '../db.js';

/** Wpis do audit_log. `changes` NIE może zawierać jawnych danych osobowych — tylko id i pola techniczne. */
export async function audit(
  db: Db,
  e: {
    actor: 'customer' | 'admin' | 'system';
    adminId?: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    changes?: Record<string, unknown> | null;
    ip?: string | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor, admin_id, action, entity_type, entity_id, changes, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [e.actor, e.adminId ?? null, e.action, e.entityType, e.entityId ?? null, e.changes ?? null, e.ip ?? null],
  );
}
