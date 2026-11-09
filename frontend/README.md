# Serwis — frontend (React + Vite + Tailwind)

Dwie osobne paczki z jednego projektu: strona rezerwacji dla klientów (`/`) i panel serwisu (`/admin/`).
Klient nie pobiera kodu panelu.

    npm install
    npm run dev            # http://localhost:5173, /api → http://localhost:3000 (backend)
    npm run build          # dist/ — statyczne pliki
    npm run test:e2e       # Playwright na działającym stosie (API + `npm run preview`)

Testy E2E panelu zakładają świeżą bazę z danymi demo (backend: `npm run migrate && npm run seed:demo`)
— zmieniają dane, więc uruchamiaj je na bazie testowej. API musi akceptować origin podglądu
(`CORS_ORIGIN=http://localhost:5173,http://localhost:4173`).

## Panel serwisu (`/admin/`)
Kalendarz dnia (2 stanowiska) i tygodnia, dodawanie wizyty kliknięciem w kratkę, przesuwanie, statusy,
odwołanie z powiadomieniem, blokady stanowisk, baza klientów z historią i pojazdami, zgody WhatsApp,
usuwanie danych (RODO, tylko właściciel), stan powiadomień. Sesja: ciasteczka HttpOnly + token CSRF w pamięci,
automatyczne odświeżanie sesji.

Wymaga w backendzie opublikowanych dokumentów w `legal_documents` (regulamin, prywatność oraz zgoda WhatsApp
z `display_text` — formularz pokazuje dokładnie ten tekst, który zostaje zapisany jako dowód zgody).

Wdrożenie: patrz `../deploy/README.md` (Caddy: HTTPS, nagłówki bezpieczeństwa, CSP, API pod jednym adresem).
