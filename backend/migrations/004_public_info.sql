-- =====================================================================
--  004: treść zgód wyświetlana w formularzu = treść zapisana jako dowód
-- =====================================================================
BEGIN;
-- Krótki tekst pokazywany przy checkboxie (np. zgoda WhatsApp). content_sha256 powinien być hashem
-- pełnej treści dokumentu; dla zgody WhatsApp pełną treścią jest właśnie display_text.
ALTER TABLE legal_documents ADD COLUMN display_text text;
COMMIT;
