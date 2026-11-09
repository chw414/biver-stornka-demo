-- =====================================================================
--  005: katalog usług z grupami (cennik wulkanizacji)
-- =====================================================================
BEGIN;
-- category: nagłówek grupy w formularzu (np. "Wymiana opon — felga stalowa"); NULL = usługa bez grupy
-- short_name: krótka etykieta w grupie (np. 'Felgi 15"–16"'); pełna nazwa (name) trafia na wizytę i do powiadomień
ALTER TABLE services
  ADD COLUMN category   varchar(100),
  ADD COLUMN short_name varchar(60);
COMMIT;
