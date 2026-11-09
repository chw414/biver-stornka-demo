# Serwis — API rezerwacji (krok 4: + powiadomienia WhatsApp i Google Calendar)

Node.js 22 · Express 5 · TypeScript · PostgreSQL 15+ · Zod 4 · Redis (rate limiting)

## Start
    cp .env.example .env      # uzupełnij DATABASE_URL, CORS_ORIGIN, REDIS_URL
    npm install
    npm run migrate           # migrations/*.sql, każdy plik raz
    npm run admin:create -- --email jan@serwis.pl --name "Jan Kowalski" --role owner
    npm run dev               # API
    npm run worker            # osobny proces: powiadomienia + Google Calendar
    npm run test:concurrency  # TYLKO na pustej bazie dev/test — tworzy dane
    npm run test:admin        # j.w.
    npm run test:workers      # j.w. (fałszywe serwery Meta i Google)

Przed pierwszą rezerwacją opublikuj regulamin i politykę prywatności w `legal_documents`
(bez nich API zwraca 500 MISCONFIGURED — zgody muszą wskazywać konkretną wersję dokumentu).

## Endpointy publiczne (`/api/public`)
| Metoda | Ścieżka | Opis |
|---|---|---|
| GET | `/services` | aktywne usługi publiczne |
| GET | `/availability?serviceId=&date=RRRR-MM-DD` | wolne godziny w dniu |
| GET | `/availability/days?serviceId=&from=&to=` | dni z wolnymi terminami (maks. 62 dni) |
| POST | `/bookings` + nagłówek `Idempotency-Key: <uuid>` | rezerwacja |

Kody POST /bookings: 201 utworzono · 200 powtórzone żądanie · 400 walidacja · 409 termin zajęty ·
422 termin niepoprawny / klucz użyty ponownie · 429 limit · 503 przeciążenie (Retry-After).

## Przyszła weryfikacja numeru (OTP)
Hook: `src/modules/booking/phoneVerifier.ts`, kolumna `customers.phone_verified_at`,
ustawienie `app_settings.phone_verification` (`none` → `sms_otp`), pole `verificationToken` w żądaniu.

## Panel admina (`/api/admin`)
Uwierzytelnianie: access JWT (15 min, HttpOnly, SameSite=Strict) + refresh token (14 dni, rotowany,
wysyłany tylko do `/api/admin/auth`, w bazie wyłącznie hash). Ponowne użycie zrotowanego refresh tokenu
po 30 s = kradzież → unieważnienie wszystkich sesji. Blokada konta po 5 nieudanych logowaniach.

CSRF: SameSite=Strict + weryfikacja `Origin` + nagłówek `X-CSRF-Token` (HMAC id sesji). Token przychodzi
w JSON z `/auth/login`, `/auth/refresh`, `/auth/me` — frontend trzyma go w pamięci.

**Wdrożenie:** frontend i API pod tym samym originem (reverse proxy: `serwis.pl/api → Node`),
inaczej ciasteczka SameSite=Strict nie będą wysyłane.

| Metoda | Ścieżka | Opis |
|---|---|---|
| POST | `/auth/login` · `/auth/refresh` · `/auth/logout` · `/auth/logout-all` | sesja |
| GET | `/auth/me` | dane admina + token CSRF (po przeładowaniu strony) |
| GET | `/calendar?from=&to=&includeCancelled=` | stanowiska, godziny, wizyty, blokady (maks. 6 tyg.) |
| POST | `/appointments` | ręczna wizyta (telefon / z ulicy), opcj. `stationId`, `allowOutsideHours` |
| GET/PATCH | `/appointments/:id` | szczegóły / przesunięcie, status, notatki (wymaga `lockVersion`) |
| POST | `/appointments/:id/cancel` | anulowanie (+ opcjonalny SMS) |
| POST/DELETE | `/blocks`, `/blocks/:id` | blokady stanowisk; zwraca kolidujące wizyty |
| GET | `/customers?q=` | wyszukiwanie po nazwisku, telefonie, tablicy |
| GET/PATCH | `/customers/:id` | karta klienta (odczyt audytowany) / edycja |
| PATCH | `/vehicles/:id` | edycja pojazdu (m.in. rozmiar opon) |
| POST | `/customers/:id/anonymize` | RODO art. 17 — tylko rola `owner` |

## Powiadomienia i kalendarz
WhatsApp (Cloud API, szablony utility) z miejscem na SMS, webhook statusów `POST /api/webhooks/whatsapp`,
synchronizacja Google Calendar przez konto serwisowe. Konfiguracja, szablony do zgłoszenia w Meta i tekst
zgody: **docs/integracje.md**. Stan: `GET /api/admin/system/health`.

## Produkcja
- `npm run build` → `dist/`; `Dockerfile` w tym katalogu buduje obraz (używany przez `../deploy/docker-compose.yml`).
- `node dist/scripts/migrate.js` — migracje jako właściciel bazy; przy `APP_DB_USER`/`APP_DB_PASSWORD` zakłada rolę
  aplikacji z minimalnymi uprawnieniami (bez DDL; `audit_log` tylko do dopisywania).
- `GET /ready` — sprawdza połączenie z bazą (healthcheck). `GET /health` — sam proces.
- `npm run legal:publish -- --kind terms|privacy|marketing|whatsapp --version 1.0 --url … --file …` — publikacja dokumentów prawnych
  (dla `whatsapp` treść = tekst zgody pokazywany przy checkboxie).
- Puste zmienne środowiskowe (`ZMIENNA=`) są traktowane jak nieustawione.
- `npm run setup:biver` — cennik wulkanizacji, godziny pracy i informacje o cenach (bezpieczne do ponownego uruchomienia). `-- --dev` dodaje testowe dokumenty prawne i konto `wlasciciel@biver.test` (nigdy w produkcji).
