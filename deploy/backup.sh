#!/bin/sh
# Codzienny zrzut bazy (pg_dump -Fc) z weryfikacją i rotacją. Użycie: backup.sh [--once]
set -eu
DIR="${BACKUP_DIR:-/backups}"
KEEP="${BACKUP_RETENTION_DAYS:-14}"
HOUR="${BACKUP_HOUR_UTC:-2}"
mkdir -p "$DIR"

do_backup() {
  f="$DIR/serwis-$(date -u +%Y%m%dT%H%M%SZ).dump"
  if pg_dump -Fc --no-owner -f "$f.tmp" && pg_restore --list "$f.tmp" >/dev/null; then
    mv "$f.tmp" "$f"; chmod 600 "$f"
    echo "backup OK: $f ($(wc -c <"$f") B)"
  else
    rm -f "$f.tmp"; echo "backup FAILED" >&2; return 1
  fi
  find "$DIR" -name 'serwis-*.dump' -mtime +"$KEEP" -delete
}

if [ "${1:-}" = "--once" ]; then do_backup; exit $?; fi

while true; do
  now=$(date -u +%s)
  next=$(date -u -d "today ${HOUR}:00" +%s 2>/dev/null || date -u -d "$(date -u +%Y-%m-%d) ${HOUR}:00:00" +%s)
  [ "$next" -le "$now" ] && next=$((next + 86400))
  echo "następny backup za $((next - now)) s"
  sleep $((next - now))
  do_backup || true
done
