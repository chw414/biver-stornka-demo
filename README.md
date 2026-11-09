# Biver Brzesko: system rezerwacji wizyt

Aplikacja do rezerwacji wizyt w serwisie opon i mechaniki Biver (Brzesko).

- `backend/`: API (Node.js, Express 5, TypeScript), PostgreSQL 16, workery powiadomień
- `frontend/`: strona rezerwacji i panel pracownika (React 19, Vite, Tailwind 4)
- `deploy/`: Docker Compose, Caddy, skrypty kopii zapasowych

Instrukcje uruchomienia: `backend/README.md`, `frontend/README.md`, `deploy/README.md`.
Uwaga: konfiguracja Docker/Caddy nie była uruchamiana w testach.
