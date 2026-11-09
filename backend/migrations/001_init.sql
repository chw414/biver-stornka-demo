-- =====================================================================
--  Serwis mechaniczno-wulkanizacyjny — system rezerwacji wizyt
--  Schemat bazy danych: PostgreSQL 15+
--
--  Konwencje:
--   * wszystkie znaczniki czasu jako timestamptz (UTC w bazie),
--     strefa biznesowa Europe/Warsaw (app_settings.timezone),
--   * godziny otwarcia jako "time" w czasie lokalnym (odporne na DST),
--   * siatka czasowa 15 min wymuszona constraintami,
--   * każda wizyta zajmuje KONKRETNE stanowisko -> pojemność = liczba stanowisk.
-- =====================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;  -- operator "=" w EXCLUDE dla kolumn skalarnych
CREATE EXTENSION IF NOT EXISTS citext;      -- e-maile bez rozróżniania wielkości liter
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- wyszukiwanie klientów / tablic w panelu admina

-- ---------------------------------------------------------------------
--  Typy wyliczeniowe
-- ---------------------------------------------------------------------
CREATE TYPE appointment_status   AS ENUM ('confirmed', 'completed', 'cancelled', 'no_show');
CREATE TYPE appointment_source   AS ENUM ('online', 'phone', 'walk_in');
CREATE TYPE actor_type           AS ENUM ('customer', 'admin', 'system');
CREATE TYPE consent_type         AS ENUM ('terms', 'privacy', 'marketing');
CREATE TYPE notification_channel AS ENUM ('sms', 'whatsapp');
CREATE TYPE notification_kind    AS ENUM ('confirmation', 'reminder_24h', 'reschedule', 'cancellation');
CREATE TYPE delivery_status      AS ENUM ('pending', 'sent', 'failed', 'cancelled');
CREATE TYPE outbox_status        AS ENUM ('pending', 'processing', 'done', 'failed');
CREATE TYPE admin_role           AS ENUM ('owner', 'staff');

-- ---------------------------------------------------------------------
--  Funkcja pomocnicza: automatyczne updated_at
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- =====================================================================
--  KONFIGURACJA
-- =====================================================================
CREATE TABLE app_settings (
  key         varchar(60) PRIMARY KEY,
  value       jsonb       NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
--  ADMINISTRATORZY I SESJE
-- =====================================================================
CREATE TABLE admins (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                  citext       NOT NULL UNIQUE,
  password_hash          text         NOT NULL,           -- argon2id
  full_name              varchar(120) NOT NULL,
  role                   admin_role   NOT NULL DEFAULT 'staff',
  is_active              boolean      NOT NULL DEFAULT true,
  token_version          integer      NOT NULL DEFAULT 0, -- ++ = unieważnienie wszystkich JWT
  failed_login_attempts  smallint     NOT NULL DEFAULT 0,
  locked_until           timestamptz,                     -- blokada po serii nieudanych logowań
  last_login_at          timestamptz,
  created_at             timestamptz  NOT NULL DEFAULT now(),
  updated_at             timestamptz  NOT NULL DEFAULT now()
);

-- Refresh tokeny (surowy token tylko w HttpOnly cookie, w bazie wyłącznie hash SHA-256)
CREATE TABLE admin_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id            uuid        NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  refresh_token_hash  bytea       NOT NULL UNIQUE,
  user_agent          varchar(255),
  ip_address          inet,
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  replaced_by         uuid REFERENCES admin_sessions(id), -- rotacja; użycie starego tokenu = alarm
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_sessions_active_idx ON admin_sessions (admin_id) WHERE revoked_at IS NULL;

-- =====================================================================
--  ZASOBY: STANOWISKA, USŁUGI, GODZINY PRACY
-- =====================================================================
CREATE TABLE stations (
  id          smallint    PRIMARY KEY,
  name        varchar(50) NOT NULL UNIQUE,
  is_active   boolean     NOT NULL DEFAULT true,
  sort_order  smallint    NOT NULL DEFAULT 0
);

CREATE TABLE services (
  id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug              varchar(60)  NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name              varchar(100) NOT NULL,
  description       text,                                   -- renderowane jako czysty tekst (XSS)
  duration_minutes  smallint     NOT NULL
                    CHECK (duration_minutes BETWEEN 15 AND 480 AND duration_minutes % 15 = 0),
  price_from_pln    numeric(8,2) CHECK (price_from_pln >= 0), -- informacyjnie, płatność na miejscu
  is_active         boolean      NOT NULL DEFAULT true,
  is_public         boolean      NOT NULL DEFAULT true,       -- false = tylko ręcznie przez admina
  sort_order        smallint     NOT NULL DEFAULT 0,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now()
);

-- Tygodniowy grafik (możliwe kilka przedziałów na dzień, np. przerwa obiadowa)
CREATE TABLE business_hours (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  iso_weekday  smallint NOT NULL CHECK (iso_weekday BETWEEN 1 AND 7), -- 1 = poniedziałek
  opens_at     time     NOT NULL,
  closes_at    time     NOT NULL,
  CONSTRAINT bh_order   CHECK (closes_at > opens_at),
  CONSTRAINT bh_aligned CHECK (EXTRACT(EPOCH FROM opens_at)::int  % 900 = 0
                           AND EXTRACT(EPOCH FROM closes_at)::int % 900 = 0),
  CONSTRAINT bh_no_overlap EXCLUDE USING gist (
    iso_weekday WITH =,
    tsrange(DATE '2000-01-01' + opens_at, DATE '2000-01-01' + closes_at) WITH &&
  )
);

-- Wyjątki: święta, skrócone dni, dni z innymi godzinami
CREATE TABLE schedule_exceptions (
  day        date PRIMARY KEY,
  opens_at   time,          -- NULL + NULL = zamknięte cały dzień
  closes_at  time,
  reason     varchar(200),
  CONSTRAINT se_shape CHECK (
       (opens_at IS NULL AND closes_at IS NULL)
    OR (opens_at IS NOT NULL AND closes_at IS NOT NULL AND closes_at > opens_at
        AND EXTRACT(EPOCH FROM opens_at)::int  % 900 = 0
        AND EXTRACT(EPOCH FROM closes_at)::int % 900 = 0)
  )
);

-- Blokady stanowisk (awaria podnośnika, urlop pracownika); station_id NULL = cały serwis
CREATE TABLE station_blocks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id  smallint REFERENCES stations(id) ON DELETE CASCADE,
  during      tstzrange   NOT NULL CHECK (NOT isempty(during)),
  reason      varchar(200),
  created_by  uuid REFERENCES admins(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX station_blocks_during_idx ON station_blocks USING gist (during);

-- =====================================================================
--  KLIENCI I POJAZDY (tożsamość "gościa" = numer telefonu)
-- =====================================================================
CREATE TABLE customers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164     varchar(16) UNIQUE,             -- np. +48600100200; NULL po anonimizacji
  full_name      varchar(120),
  admin_notes    text,
  anonymized_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customers_phone_format CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT customers_anonymization CHECK (
       (anonymized_at IS NULL     AND phone_e164 IS NOT NULL AND full_name IS NOT NULL)
    OR (anonymized_at IS NOT NULL AND phone_e164 IS NULL     AND full_name IS NULL)
  )
);
CREATE INDEX customers_name_trgm_idx ON customers USING gin (full_name gin_trgm_ops);

CREATE TABLE vehicles (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id          uuid        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  make                 varchar(50) NOT NULL,
  model                varchar(60) NOT NULL,
  registration_number  varchar(10),           -- znormalizowany: A-Z0-9, bez spacji; NULL po anonimizacji
  tire_size            varchar(20),           -- np. 205/55 R16 (uzupełnia admin)
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vehicles_reg_format CHECK (registration_number ~ '^[A-Z0-9]{2,10}$'),
  CONSTRAINT vehicles_unique_per_customer UNIQUE (customer_id, registration_number)
);
CREATE INDEX vehicles_customer_idx ON vehicles (customer_id);
CREATE INDEX vehicles_reg_trgm_idx ON vehicles USING gin (registration_number gin_trgm_ops);

-- =====================================================================
--  WIZYTY
-- =====================================================================

-- Wiersze-zamki dla blokady pesymistycznej (1 wiersz = 1 dzień w strefie Europe/Warsaw).
-- Transakcja rezerwacji:
--   INSERT INTO booking_day_locks(day) VALUES ($1) ON CONFLICT DO NOTHING;
--   SELECT day FROM booking_day_locks WHERE day = $1 FOR UPDATE;
--   -> sprawdzenie wolnych stanowisk -> INSERT INTO appointments ...
CREATE TABLE booking_day_locks (
  day date PRIMARY KEY
);

CREATE TABLE appointments (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_code         varchar(8)   NOT NULL UNIQUE CHECK (reference_code ~ '^[A-Z0-9]{6,8}$'),
  customer_id            uuid         NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  vehicle_id             uuid         NOT NULL REFERENCES vehicles(id)  ON DELETE RESTRICT,
  service_id             integer      NOT NULL REFERENCES services(id)  ON DELETE RESTRICT,
  station_id             smallint     NOT NULL REFERENCES stations(id)  ON DELETE RESTRICT,
  starts_at              timestamptz  NOT NULL,
  ends_at                timestamptz  NOT NULL,
  status                 appointment_status NOT NULL DEFAULT 'confirmed',
  source                 appointment_source NOT NULL,
  -- migawki: historia nie zmienia się po edycji cennika/nazw usług
  service_name_snapshot  varchar(100) NOT NULL,
  price_from_snapshot    numeric(8,2),
  customer_notes         varchar(500),
  admin_notes            text,
  idempotency_key        uuid UNIQUE,              -- chroni przed podwójnym kliknięciem / retry
  created_by_admin_id    uuid REFERENCES admins(id) ON DELETE SET NULL,
  cancelled_at           timestamptz,
  cancelled_by           actor_type,
  cancellation_reason    varchar(300),
  google_event_id        varchar(1024),
  created_ip             inet,
  lock_version           integer      NOT NULL DEFAULT 1, -- optymistyczna kontrola edycji w panelu
  created_at             timestamptz  NOT NULL DEFAULT now(),
  updated_at             timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT appt_time_order CHECK (ends_at > starts_at),
  CONSTRAINT appt_slot_aligned CHECK (
        EXTRACT(EPOCH FROM starts_at)::bigint % 900 = 0
    AND EXTRACT(EPOCH FROM ends_at)::bigint   % 900 = 0
  ),
  CONSTRAINT appt_cancel_consistency CHECK (
    (status = 'cancelled') = (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)
  ),
  CONSTRAINT appt_manual_needs_admin CHECK (source = 'online' OR created_by_admin_id IS NOT NULL),

  -- OSTATNIA LINIA OBRONY: dwie aktywne wizyty nie mogą zachodzić na siebie na tym samym stanowisku.
  -- Naruszenie -> SQLSTATE 23P01 -> backend zwraca 409 Conflict.
  CONSTRAINT appt_no_overlap_per_station EXCLUDE USING gist (
    station_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status IN ('confirmed', 'completed'))
);
CREATE INDEX appt_active_starts_idx ON appointments (starts_at)
  WHERE status IN ('confirmed', 'completed');
CREATE INDEX appt_customer_idx ON appointments (customer_id, starts_at DESC);
CREATE INDEX appt_vehicle_idx  ON appointments (vehicle_id,  starts_at DESC);

-- =====================================================================
--  RODO: DOKUMENTY PRAWNE I ZGODY (rozliczalność, art. 7 ust. 1)
-- =====================================================================
CREATE TABLE legal_documents (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind            consent_type NOT NULL,
  version         varchar(20)  NOT NULL,
  content_sha256  bytea        NOT NULL,   -- dowód, jaką treść zaakceptowano
  url             text         NOT NULL,
  published_at    timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (kind, version)
);

CREATE TABLE customer_consents (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id     uuid    NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  document_id     integer NOT NULL REFERENCES legal_documents(id) ON DELETE RESTRICT,
  appointment_id  uuid    REFERENCES appointments(id) ON DELETE SET NULL, -- kontekst udzielenia
  granted_at      timestamptz NOT NULL DEFAULT now(),
  withdrawn_at    timestamptz,
  ip_address      inet,
  user_agent      varchar(255),
  CHECK (withdrawn_at IS NULL OR withdrawn_at >= granted_at)
);
CREATE INDEX customer_consents_customer_idx ON customer_consents (customer_id);

-- =====================================================================
--  POWIADOMIENIA (SMS / WhatsApp) — źródło prawdy dla kolejki BullMQ
--  jobId w BullMQ = notifications.id  ->  idempotencja wysyłki
-- =====================================================================
CREATE TABLE notifications (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id       uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  kind                 notification_kind    NOT NULL,
  channel              notification_channel NOT NULL DEFAULT 'sms',
  recipient_e164       varchar(16),          -- migawka; NULL po anonimizacji
  body                 text,
  scheduled_for        timestamptz NOT NULL,
  status               delivery_status NOT NULL DEFAULT 'pending',
  attempts             smallint    NOT NULL DEFAULT 0,
  provider             varchar(30),          -- 'smsapi' | 'twilio'
  provider_message_id  varchar(100),
  last_error           text,
  sent_at              timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
-- maks. 1 aktywne potwierdzenie i 1 aktywne przypomnienie na wizytę
CREATE UNIQUE INDEX notifications_one_active_per_kind ON notifications (appointment_id, kind)
  WHERE kind IN ('confirmation', 'reminder_24h') AND status <> 'cancelled';
CREATE INDEX notifications_due_idx ON notifications (scheduled_for) WHERE status = 'pending';

-- =====================================================================
--  TRANSACTIONAL OUTBOX — integracje zewnętrzne (Google Calendar)
--  zapisywane w TEJ SAMEJ transakcji co wizyta, wykonywane przez worker
-- =====================================================================
CREATE TABLE outbox_events (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  aggregate_id     uuid          NOT NULL,     -- appointments.id
  event_type       varchar(50)   NOT NULL,     -- appointment.created | .updated | .cancelled
  payload          jsonb         NOT NULL,
  status           outbox_status NOT NULL DEFAULT 'pending',
  attempts         smallint      NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz   NOT NULL DEFAULT now(),
  last_error       text,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  processed_at     timestamptz
);
CREATE INDEX outbox_pending_idx ON outbox_events (next_attempt_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX outbox_aggregate_idx ON outbox_events (aggregate_id, id);

-- =====================================================================
--  AUDYT (RODO: rozliczalność, kto i kiedy przeglądał / zmieniał dane)
-- =====================================================================
CREATE TABLE audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  actor        actor_type  NOT NULL,
  admin_id     uuid REFERENCES admins(id) ON DELETE SET NULL,
  action       varchar(60) NOT NULL,   -- np. appointment.cancel, customer.view, customer.anonymize
  entity_type  varchar(40) NOT NULL,
  entity_id    text,
  changes      jsonb,                  -- bez jawnych danych osobowych
  ip_address   inet
);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id, occurred_at DESC);

-- =====================================================================
--  TRIGGERY updated_at
-- =====================================================================
CREATE TRIGGER trg_admins_updated        BEFORE UPDATE ON admins        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_services_updated      BEFORE UPDATE ON services      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_customers_updated     BEFORE UPDATE ON customers     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_vehicles_updated      BEFORE UPDATE ON vehicles      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_appointments_updated  BEFORE UPDATE ON appointments  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_notifications_updated BEFORE UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
--  RODO: ANONIMIZACJA (prawo do usunięcia danych, art. 17)
--  Zachowuje statystyki wizyt, usuwa dane identyfikujące.
--  Przyszłe wizyty należy anulować w aplikacji PRZED wywołaniem
--  (i wygenerować outbox na aktualizację eventu w Google Calendar).
-- =====================================================================
CREATE OR REPLACE FUNCTION anonymize_customer(p_customer_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM appointments
             WHERE customer_id = p_customer_id AND status = 'confirmed' AND starts_at > now()) THEN
    RAISE EXCEPTION 'Klient ma nadchodzące wizyty — anuluj je przed anonimizacją'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE customers
     SET full_name = NULL, phone_e164 = NULL, admin_notes = NULL, anonymized_at = now()
   WHERE id = p_customer_id AND anonymized_at IS NULL;

  UPDATE vehicles     SET registration_number = NULL, notes = NULL     WHERE customer_id = p_customer_id;
  UPDATE appointments SET customer_notes = NULL, admin_notes = NULL, created_ip = NULL
                                                                         WHERE customer_id = p_customer_id;
  UPDATE notifications n SET recipient_e164 = NULL, body = NULL
    FROM appointments a WHERE a.id = n.appointment_id AND a.customer_id = p_customer_id;
  UPDATE customer_consents SET ip_address = NULL, user_agent = NULL   WHERE customer_id = p_customer_id;
END $$;

-- =====================================================================
--  WIDOKI DLA PANELU ADMINA
-- =====================================================================
CREATE VIEW v_admin_calendar AS
SELECT a.id, a.reference_code, a.starts_at, a.ends_at, a.status, a.source,
       a.station_id, s.name AS station_name,
       a.service_id, a.service_name_snapshot AS service_name,
       a.customer_id, c.full_name, c.phone_e164,
       a.vehicle_id, v.make, v.model, v.registration_number,
       a.customer_notes, a.admin_notes, a.lock_version
FROM appointments a
JOIN stations  s ON s.id = a.station_id
JOIN customers c ON c.id = a.customer_id
JOIN vehicles  v ON v.id = a.vehicle_id;

CREATE VIEW v_customer_overview AS
SELECT c.id, c.full_name, c.phone_e164, c.created_at,
       count(DISTINCT v.id)                                    AS vehicles_count,
       count(DISTINCT a.id) FILTER (WHERE a.status = 'completed') AS completed_visits,
       count(DISTINCT a.id) FILTER (WHERE a.status = 'no_show')   AS no_shows,
       max(a.starts_at) FILTER (WHERE a.status = 'completed')     AS last_visit_at,
       min(a.starts_at) FILTER (WHERE a.status = 'confirmed' AND a.starts_at > now()) AS next_visit_at
FROM customers c
LEFT JOIN vehicles     v ON v.customer_id = c.id
LEFT JOIN appointments a ON a.customer_id = c.id
WHERE c.anonymized_at IS NULL
GROUP BY c.id;

-- =====================================================================
--  DANE STARTOWE (do dostosowania przez właściciela)
-- =====================================================================
INSERT INTO app_settings (key, value) VALUES
  ('timezone',               '"Europe/Warsaw"'),
  ('slot_minutes',           '15'),
  ('booking_horizon_days',   '60'),   -- jak daleko w przód można rezerwować
  ('min_lead_time_minutes',  '60'),   -- najwcześniej X min od teraz
  ('reminder_offset_hours',  '24');

INSERT INTO stations (id, name, sort_order) VALUES
  (1, 'Stanowisko 1', 1),
  (2, 'Stanowisko 2', 2);

INSERT INTO services (slug, name, duration_minutes, sort_order) VALUES
  ('wymiana-opon',    'Wymiana opon (komplet)',     15, 1),
  ('wywazanie-kol',   'Wyważanie kół',              30, 2),
  ('naprawa-opony',   'Naprawa opony',              30, 3),
  ('wymiana-oleju',   'Wymiana oleju i filtrów',    30, 4),
  ('przeglad-ogolny', 'Przegląd ogólny / diagnoza', 60, 5);

INSERT INTO business_hours (iso_weekday, opens_at, closes_at) VALUES
  (1, '08:00', '17:00'), (2, '08:00', '17:00'), (3, '08:00', '17:00'),
  (4, '08:00', '17:00'), (5, '08:00', '17:00'), (6, '08:00', '13:00');

COMMIT;

-- =====================================================================
--  ZASADA NAJMNIEJSZYCH UPRAWNIEŃ (uruchomić osobno jako superuser)
-- =====================================================================
-- CREATE ROLE booking_app LOGIN PASSWORD '***';
-- GRANT USAGE ON SCHEMA public TO booking_app;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO booking_app;
-- GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO booking_app;
-- REVOKE UPDATE, DELETE ON audit_log FROM booking_app;   -- log tylko do dopisywania
-- GRANT EXECUTE ON FUNCTION anonymize_customer(uuid) TO booking_app;
