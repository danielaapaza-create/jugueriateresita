#!/usr/bin/env bash
# Ejecuta las migraciones y las pruebas SQL en un PostgreSQL local temporal.
# Uso: ./scripts/test-sql.sh   (requiere PostgreSQL 15+ instalado: initdb, pg_ctl, psql)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-$(dirname "$(command -v pg_ctl 2>/dev/null || ls /usr/lib/postgresql/*/bin/pg_ctl | tail -1)")}"
TMP="$(mktemp -d)"
PORT="${PGPORT_TEST:-54329}"
export PGHOST="$TMP" PGPORT="$PORT" PGUSER=postgres PGDATABASE=postgres

cleanup() { "$PGBIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

if [ "$(id -u)" = "0" ]; then
  echo "No ejecutes como root: PostgreSQL no lo permite." >&2
  echo "Prueba: chown -R nobody \"$TMP\" && su nobody -s /bin/bash -c ..." >&2
  exit 1
fi

"$PGBIN/initdb" -D "$TMP/data" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$TMP/data" -o "-k $TMP -p $PORT -c listen_addresses=''" -l "$TMP/log" start -w >/dev/null

run() { psql -v ON_ERROR_STOP=1 -q -X -o /dev/null -f "$1"; }

run "$ROOT/supabase/tests/00_supabase_stub.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "→ migración $(basename "$f")"
  run "$f"
done
for f in "$ROOT"/supabase/tests/[1-9]*.sql; do
  echo "→ prueba $(basename "$f")"
  run "$f"
done
echo "✅ Pruebas SQL completadas"
