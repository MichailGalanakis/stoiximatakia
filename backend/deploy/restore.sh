#!/bin/sh
set -eu
umask 077
task_archive=$(mktemp /tmp/restore.XXXXXX)
task_database="skillbetting_restore_$(date -u +%Y%m%d%H%M%S)_$$"
task_created=no
task_mode=${1:-check}
cleanup() {
  rm -f "$task_archive"
  if [ "$task_created" = yes ]; then dropdb --maintenance-db=postgres --if-exists "$task_database"; fi
}
trap cleanup EXIT HUP INT TERM
cat >"$task_archive"
pg_restore --list "$task_archive" >/dev/null

case "$task_mode" in
  check) ;;
  replace)
    [ "${RESTORE_ALLOW_REPLACE:-}" = replace-current-database ] || {
      echo 'Destructive restore requires the explicit replacement flag.' >&2; exit 1;
    }
    ;;
  *) echo 'Unknown restore mode.' >&2; exit 1 ;;
esac

# Always reconstruct and reconcile in a new database. Current data stays intact
# even if an otherwise readable archive has a truncated/corrupt data section.
createdb --maintenance-db=postgres "$task_database"
task_created=yes

pg_restore --exit-on-error --no-owner --no-acl --dbname="$task_database" "$task_archive"
task_mismatch=$(psql -v ON_ERROR_STOP=1 --dbname="$task_database" -Atc \
  "SELECT count(*) FROM credit_accounts a WHERE balance_minor <> (SELECT coalesce(sum(amount_minor),0) FROM credit_postings p WHERE p.account_key=a.key)")
task_unbalanced=$(psql -v ON_ERROR_STOP=1 --dbname="$task_database" -Atc \
  "SELECT count(*) FROM (SELECT journal_id FROM credit_postings GROUP BY journal_id HAVING sum(amount_minor)<>0) q")
[ "$task_mismatch" = 0 ] && [ "$task_unbalanced" = 0 ] || {
  echo 'Restored ledger does not reconcile.' >&2; exit 1;
}
# Older eight-migration archives have no chess proof storage. New archives must
# reconcile immutable transport/bindings too; this SQL audit is not a rules proof.
task_has_proof_audit=$(psql -v ON_ERROR_STOP=1 --dbname="$task_database" -Atc \
  "SELECT to_regprocedure('chess_proof_integrity_errors()') IS NOT NULL")
if [ "$task_has_proof_audit" = t ]; then
  task_proof_errors=$(psql -v ON_ERROR_STOP=1 --dbname="$task_database" -Atc \
    'SELECT count(*) FROM chess_proof_integrity_errors()')
  [ "$task_proof_errors" = 0 ] || {
    echo 'Restored chess proof storage does not reconcile.' >&2; exit 1;
  }
fi
if [ "$task_mode" = replace ]; then
  POSTGRES_USER=postgres POSTGRES_DB="$task_database" /bin/sh /ops/postgres-init.sh
  task_previous="skillbetting_before_restore_$(date -u +%Y%m%d%H%M%S)_$$"
  psql -v ON_ERROR_STOP=1 --dbname=postgres \
    --set=previous="$task_previous" --set=restored="$task_database" <<'SQL'
BEGIN;
ALTER DATABASE skillbetting ALLOW_CONNECTIONS false;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='skillbetting' AND pid<>pg_backend_pid();
ALTER DATABASE skillbetting RENAME TO :"previous";
ALTER DATABASE :"restored" RENAME TO skillbetting;
COMMIT;
SQL
  task_created=no
  printf 'Previous database retained without connections as %s; remove it only after recovery is accepted.\n' "$task_previous"
fi
echo 'Backup restored; ledger and available proof-storage integrity checks reconcile.'
