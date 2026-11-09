import type { Db } from '../../db.js';
import { Errors } from '../../errors.js';

/**
 * Zgoda na powiadomienia WhatsApp. Wymogi Meta: aktywne działanie użytkownika, jasna informacja,
 * że zgadza się na wiadomości, i nazwa firmy. Treść zgody to wersjonowany dokument w legal_documents
 * (kind = 'whatsapp') — mamy dowód, na co dokładnie klient się zgodził.
 */
export async function grantWhatsAppConsent(
  db: Db,
  p: { customerId: string; appointmentId?: string | null; ip?: string | null; userAgent?: string | null; adminId?: string | null },
): Promise<void> {
  const { rows: [doc] } = await db.query<{ id: number }>(
    `SELECT id FROM legal_documents WHERE kind = 'whatsapp' AND published_at <= now() ORDER BY published_at DESC LIMIT 1`);
  if (!doc) throw Errors.misconfigured('brak opublikowanej treści zgody na powiadomienia WhatsApp');
  await db.query(
    `INSERT INTO customer_consents (customer_id, document_id, appointment_id, ip_address, user_agent, recorded_by_admin_id)
     SELECT $1, $2, $3, $4, $5, $6
      WHERE NOT EXISTS (SELECT 1 FROM customer_consents WHERE customer_id = $1 AND document_id = $2 AND withdrawn_at IS NULL)`,
    [p.customerId, doc.id, p.appointmentId ?? null, p.ip ?? null, p.userAgent?.slice(0, 255) ?? null, p.adminId ?? null]);
}

export async function withdrawWhatsAppConsent(db: Db, customerId: string): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE customer_consents cc SET withdrawn_at = now()
       FROM legal_documents d
      WHERE d.id = cc.document_id AND d.kind = 'whatsapp' AND cc.customer_id = $1 AND cc.withdrawn_at IS NULL`,
    [customerId]);
  return rowCount ?? 0;
}
