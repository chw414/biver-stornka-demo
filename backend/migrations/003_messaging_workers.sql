-- =====================================================================
--  003: WhatsApp jako kanał powiadomień (+ miejsce na SMS), workery
-- =====================================================================

-- Nowe wartości enumów muszą zostać zatwierdzone, zanim użyje ich indeks / zapytanie
BEGIN;
ALTER TYPE delivery_status ADD VALUE IF NOT EXISTS 'delivered' AFTER 'sent';
ALTER TYPE delivery_status ADD VALUE IF NOT EXISTS 'read' AFTER 'delivered';
ALTER TYPE consent_type ADD VALUE IF NOT EXISTS 'whatsapp';
COMMIT;

BEGIN;

-- Kanał wybiera worker W MOMENCIE WYSYŁKI (wg app_settings.notification_channels i zgód klienta).
-- Dzięki temu zmiana WhatsApp → SMS dotyczy też już zaplanowanych przypomnień.
ALTER TABLE notifications ALTER COLUMN channel DROP DEFAULT;
ALTER TABLE notifications ALTER COLUMN channel DROP NOT NULL;

ALTER TABLE notifications
  ADD COLUMN locked_until  timestamptz,  -- dzierżawa workera + "nie wcześniej niż" przy ponawianiu
  ADD COLUMN fallback_of   uuid REFERENCES notifications(id) ON DELETE SET NULL, -- np. SMS po nieudanym WhatsAppie
  ADD COLUMN error_code    varchar(30),
  ADD COLUMN delivered_at  timestamptz,
  ADD COLUMN read_at       timestamptz;

-- nieudane powiadomienie nie blokuje utworzenia zastępczego (fallback)
DROP INDEX notifications_one_active_per_kind;
CREATE UNIQUE INDEX notifications_one_active_per_kind ON notifications (appointment_id, kind)
  WHERE kind IN ('confirmation', 'reminder_24h') AND status IN ('pending', 'sent', 'delivered', 'read');
CREATE INDEX notifications_provider_msg_idx ON notifications (provider_message_id) WHERE provider_message_id IS NOT NULL;

ALTER TABLE outbox_events ADD COLUMN locked_until timestamptz;

-- zgoda zapisana przez admina (np. klient zgodził się przez telefon)
ALTER TABLE customer_consents ADD COLUMN recorded_by_admin_id uuid REFERENCES admins(id) ON DELETE SET NULL;
CREATE INDEX customer_consents_active_idx ON customer_consents (customer_id, document_id) WHERE withdrawn_at IS NULL;

-- Kolejność kanałów: pierwszy dostępny wygrywa, kolejne to zapasowe.
-- Dziś: tylko WhatsApp. Docelowo np. ["whatsapp","sms"] (SMS gdy brak zgody/WhatsAppa) albo ["sms"].
INSERT INTO app_settings (key, value) VALUES ('notification_channels', '["whatsapp"]');

COMMIT;
