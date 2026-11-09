-- =====================================================================
--  002: przygotowanie pod API rezerwacji + miejsce na przyszłe OTP
-- =====================================================================
BEGIN;

-- Hook pod przyszłą weryfikację numeru (OTP). Dziś zawsze NULL.
ALTER TABLE customers ADD COLUMN phone_verified_at timestamptz;

-- Dane z formularza zapisujemy przy wizycie. Publiczny formularz NIGDY nie nadpisuje
-- danych istniejącego klienta (ktoś mógłby wpisać cudzy numer), więc admin widzi
-- zarówno dane z bazy, jak i to, co faktycznie wpisano przy tej rezerwacji.
ALTER TABLE appointments ADD COLUMN booked_full_name varchar(120);

-- 'none' | 'sms_otp' — przełącznik trybu weryfikacji (dziś: brak)
INSERT INTO app_settings (key, value) VALUES ('phone_verification', '"none"');

-- Anonimizacja musi czyścić także nowe kolumny
CREATE OR REPLACE FUNCTION anonymize_customer(p_customer_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM appointments
             WHERE customer_id = p_customer_id AND status = 'confirmed' AND starts_at > now()) THEN
    RAISE EXCEPTION 'Klient ma nadchodzące wizyty — anuluj je przed anonimizacją'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE customers
     SET full_name = NULL, phone_e164 = NULL, admin_notes = NULL,
         phone_verified_at = NULL, anonymized_at = now()
   WHERE id = p_customer_id AND anonymized_at IS NULL;

  UPDATE vehicles     SET registration_number = NULL, notes = NULL WHERE customer_id = p_customer_id;
  UPDATE appointments SET customer_notes = NULL, admin_notes = NULL, created_ip = NULL,
                          booked_full_name = NULL
                    WHERE customer_id = p_customer_id;
  UPDATE notifications n SET recipient_e164 = NULL, body = NULL
    FROM appointments a WHERE a.id = n.appointment_id AND a.customer_id = p_customer_id;
  UPDATE customer_consents SET ip_address = NULL, user_agent = NULL WHERE customer_id = p_customer_id;
END $$;

COMMIT;
