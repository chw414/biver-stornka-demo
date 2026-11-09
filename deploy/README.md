# Wdrożenie (Docker Compose + Caddy)

Jedna maszyna (VPS, ok. 1 vCPU / 2 GB RAM wystarczy), Docker + Docker Compose v2. Caddy sam pobiera i odnawia certyfikat HTTPS.
Frontend i API są pod jednym adresem — ciasteczka panelu (SameSite=Strict) działają, CORS nie jest potrzebny.

## 1. Przygotowanie
1. Domena z rekordem A/AAAA na adres serwera; porty 80, 443 (TCP i UDP) otwarte.
2. `cd deploy && cp .env.example .env` i uzupełnij. Sekrety:
   `openssl rand -hex 24` (hasła DB) oraz `openssl rand -base64 48` (JWT_SECRET, CSRF_SECRET — dwa różne).
3. `docker compose up -d --build` — startuje: db, redis, migrate (jednorazowo, zakłada rolę `serwis_app`), api, worker, web (Caddy), backup.
4. `docker compose ps` — wszystkie usługi `running`/`healthy`, `migrate` zakończone (`exited 0`).

## 2. Pierwsze uruchomienie
    # konto właściciela (hasło wpisywane bez echa)
    docker compose run --rm -it migrate node dist/scripts/create-admin.js --email ty@firma.pl --name "Imię Nazwisko" --role owner

    # cennik Biver (25 usług po 15 min), godziny pracy, informacje o cenach — można uruchamiać ponownie po zmianie cennika
    docker compose run --rm migrate node dist/scripts/setup-biver.js

    # dokumenty prawne — BEZ nich rezerwacje nie zapiszą zgód. Adresy mają prowadzić do realnych stron!
    docker compose run --rm migrate node dist/scripts/publish-legal.js --kind terms   --version 1.0 --url https://TWOJA-DOMENA/regulamin  --text "treść lub streszczenie"
    docker compose run --rm migrate node dist/scripts/publish-legal.js --kind privacy --version 1.0 --url https://TWOJA-DOMENA/prywatnosc --text "…"
    docker compose run --rm migrate node dist/scripts/publish-legal.js --kind whatsapp --version 1.0 --url https://TWOJA-DOMENA/prywatnosc#whatsapp \
      --text "Chcę otrzymać potwierdzenie i przypomnienie o wizycie na WhatsApp od <Nazwa>. Mogę zrezygnować w każdej chwili, odpisując STOP."

(`migrate` ma w środowisku dane właściciela bazy, więc nadaje się do jednorazowych poleceń administracyjnych.)
Treść `--text` jest hashowana (SHA-256) jako dowód, jaką wersję zaakceptował klient. Zmiana regulaminu = nowa `--version`.

    ./smoke.sh https://TWOJA-DOMENA        # test dymny (strona, panel, API, nagłówki)

## 3. Zmiana cennika, godzin i świąt
Cennik i godziny pracy są w pliku `backend/scripts/setup-biver.ts` (stała `GROUPS`, `PRICE_INFO`, `HOURS`). Po zmianie: zbuduj ponownie (`docker compose up -d --build`) i uruchom `setup-biver.js` jak wyżej. Drobne poprawki i święta można też zrobić SQL-em:
    docker compose exec db psql -U serwis_owner serwis
    -- usługi (czas w wielokrotnościach 15 min)
    UPDATE services SET name='Wymiana opon', duration_minutes=60, price_from_pln=120 WHERE slug='…';
    INSERT INTO services (slug,name,duration_minutes,price_from_pln,sort_order) VALUES ('rownowazenie','Wyważanie kół',30,60,50);
    -- godziny pracy (iso_weekday: 1 = poniedziałek); najpierw usuń domyślne
    DELETE FROM business_hours WHERE iso_weekday=6;
    INSERT INTO business_hours (iso_weekday,opens_at,closes_at) VALUES (6,'09:00','14:00');
    -- święto / skrócony dzień (NULL,NULL = zamknięte)
    INSERT INTO schedule_exceptions (day,opens_at,closes_at,reason) VALUES ('2026-12-24',NULL,NULL,'Wigilia');
Zmiany widać w formularzu po kilku minutach (cache usług 5 min).

## 4. WhatsApp i Google Calendar
Zmień w `.env` `WHATSAPP_MODE=cloud` + 4 zmienne Meta, `GOOGLE_CALENDAR_MODE=api` + klucz/ID — szczegóły w `backend/docs/integracje.md`.
Klucz konta usługi Google: dopisz wolumen z plikiem do usług `api` i `worker` (np. `./secrets/google.json:/run/secrets/google.json:ro`)
i ustaw `GOOGLE_SERVICE_ACCOUNT_KEY_FILE=/run/secrets/google.json`. Webhook Meta: `https://TWOJA-DOMENA/api/webhooks/whatsapp`.
Potem `docker compose up -d`.

## 5. Aktualizacje
    git pull   # lub podmień pliki
    docker compose up -d --build     # migracje wykonają się automatycznie przed startem API

## 6. Kopie zapasowe i odtwarzanie
- Kontener `backup` robi codziennie (domyślnie 02:00 UTC) `pg_dump -Fc` do `deploy/backups/`, sprawdza go (`pg_restore --list`) i usuwa kopie starsze niż `BACKUP_RETENTION_DAYS`.
- Kopia ręczna: `docker compose exec backup sh /backup.sh --once`.
- **Kopie leżą na tym samym serwerze — to nie chroni przed utratą maszyny.** Dodaj synchronizację poza serwer (np. `rclone`/`rsync` z cron-a na inny host albo bucket).
- Próba odtworzenia (rób raz na jakiś czas!), bez ruszania produkcji:
      docker compose cp ./backups/serwis-XXXX.dump db:/tmp/b.dump
      docker compose exec -e PGUSER=serwis_owner db sh -c 'createdb serwis_restore_test && pg_restore --no-owner -d serwis_restore_test /tmp/b.dump && psql -d serwis_restore_test -Atc "select count(*) from appointments"; dropdb serwis_restore_test'
- Odtworzenie produkcji: `docker compose stop api worker`, `pg_restore --clean --if-exists --no-owner -d serwis`, `docker compose run --rm migrate` (przywraca uprawnienia roli aplikacji), `docker compose start api worker`.

## 7. Bezpieczeństwo — co jest zrobione
- Aplikacja łączy się jako `serwis_app`: bez DDL, `audit_log` tylko do dopisywania, brak dostępu do `schema_migrations`.
- Kontenery api/worker: system plików tylko do odczytu, bez uprawnień (`cap_drop: ALL`), bez `new-privileges`.
- Baza i Redis nie publikują portów; na zewnątrz wystawiony jest tylko Caddy (80/443).
- Caddy nie zapisuje logów dostępu (adresy żądań zawierają numery telefonów). Logi aplikacji redagują dane osobowe.
- HSTS, CSP bez `unsafe-inline`, `frame-ancestors 'none'`, limit body 1 MB, `/admin/` oznaczone `noindex`.

## 8. Czego tu nie ma (świadomie)
- Panelu do edycji usług, godzin i świąt (SQL powyżej).
- Kopii poza serwerem, monitoringu dostępności (np. UptimeRobot na `/api/public/info`), alertów o błędach.
- Stron z regulaminem i polityką prywatności — musisz je opublikować pod adresami podanymi w `publish-legal`.
- Weryfikacji numeru SMS/OTP (miejsce zostawione w kodzie).
- Przed uruchomieniem produkcyjnym: przegląd prawny regulaminu/RODO oraz zatwierdzenie szablonów WhatsApp w Meta.
