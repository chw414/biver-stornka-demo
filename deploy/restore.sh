#!/bin/sh
# Odtwarza bazę z zrzutu do NOWEJ bazy testowej (nie rusza produkcyjnej) — próba odtworzenia.
#   ./restore.sh backups/serwis-XXXX.dump            (w kontenerze: docker compose exec -T db ... lub z hosta z psql)
# Aby podmienić produkcję: zatrzymaj api i worker, odtwórz do bazy `serwis` (pg_restore --clean --if-exists), uruchom ponownie.
set -eu
FILE="${1:?podaj plik .dump}"
TARGET="${RESTORE_DB:-serwis_restore_test}"
dropdb --if-exists "$TARGET"
createdb "$TARGET"
pg_restore --no-owner -d "$TARGET" "$FILE"
echo "Odtworzono do bazy $TARGET. Kontrola:"
psql -d "$TARGET" -Atc "SELECT 'appointments', count(*) FROM appointments UNION ALL SELECT 'customers', count(*) FROM customers"
echo "Usuń po sprawdzeniu: dropdb $TARGET"
