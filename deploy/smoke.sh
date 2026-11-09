#!/bin/sh
# Test dymny po wdrożeniu: ./smoke.sh https://rezerwacje.twojadomena.pl
set -eu
BASE="${1:?podaj adres, np. https://rezerwacje.twojadomena.pl}"
ok() { echo "OK   $1"; }; fail() { echo "FAIL $1" >&2; FAILED=1; }
FAILED=0
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
[ "$(code "$BASE/")" = 200 ] && ok "strona główna" || fail "strona główna"
[ "$(code "$BASE/admin/")" = 200 ] && ok "panel admina (HTML)" || fail "panel admina"
[ "$(code "$BASE/health")" = 200 ] || true
[ "$(code "$BASE/api/public/info")" = 200 ] && ok "API /api/public/info" || fail "API /api/public/info"
[ "$(code "$BASE/api/admin/calendar")" = 401 ] && ok "admin API wymaga logowania (401)" || fail "admin API bez sesji powinno dać 401"
curl -sI "$BASE/" | grep -qi '^content-security-policy:' && ok "nagłówek CSP" || fail "brak CSP"
curl -sI "$BASE/" | grep -qi '^strict-transport-security:' && ok "nagłówek HSTS" || fail "brak HSTS"
[ "$(code "$BASE/api/nie-ma-takiego")" = 404 ] && ok "404 dla nieznanej ścieżki API" || fail "404 API"
exit $FAILED
