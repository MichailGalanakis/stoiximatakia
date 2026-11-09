#!/bin/sh
set -eu
umask 077
task_deploy=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
task_temp=$(mktemp -d "${TMPDIR:-/tmp}/skillbetting-container-smoke.XXXXXX")
task_project="skillbetting-smoke-$$"
RELEASE_ID=$task_project; export RELEASE_ID
task_node='node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c'
compose() { docker compose --env-file "$task_temp/.env" -p "$task_project" -f "$task_deploy/compose.yml" -f "$task_deploy/compose.smoke.yml" "$@"; }
cleanup() {
  task_status=$?
  if [ "${KEEP_SMOKE:-0}" = 1 ]; then
    echo "Retained disposable project $task_project and private settings at $task_temp."
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || :
    docker image rm "skillbetting-backend:$task_project" "skillbetting-frontend:$task_project" >/dev/null 2>&1 || :
    rm -rf "$task_temp"
  fi
  exit "$task_status"
}
trap cleanup EXIT HUP INT TERM
docker info >/dev/null
docker run --rm --network none --user "$(id -u):$(id -g)" \
  -v "$task_temp:/settings" -v "$task_deploy:/deployment:ro" "$task_node" \
  node /deployment/generate-env.mjs /settings/.env skillbetting.test
compose config --quiet
compose build backend
compose build frontend
compose up -d --wait postgres
compose up --no-deps --force-recreate --abort-on-container-exit --exit-code-from migrate migrate
compose up -d --wait backend frontend edge backup
task_role_ok=$(compose exec -T postgres psql -U postgres -d skillbetting -Atc "SELECT has_table_privilege('skillbetting_app','schema_migrations','SELECT') AND NOT has_table_privilege('skillbetting_app','schema_migrations','INSERT') AND NOT has_table_privilege('skillbetting_app','schema_migrations','UPDATE') AND NOT has_table_privilege('skillbetting_app','schema_migrations','DELETE')")
[ "$task_role_ok" = t ]
compose cp edge:/data/caddy/pki/authorities/local/root.crt "$task_temp/root.crt"
cp "$task_deploy/smoke-api.mjs" "$task_temp/smoke-api.mjs"
compose run --rm --no-deps -T --entrypoint node \
  -e NODE_EXTRA_CA_CERTS=/verification/root.crt -e SMOKE_TEST_ALLOWED=isolated-compose \
  -v "$task_temp:/verification:ro" backend /verification/smoke-api.mjs
task_backup=$(compose run --rm --no-deps backup once | tail -n 1)
compose exec -T backup cat "/backups/$task_backup" >"$task_temp/backup.dump"
compose run --rm --no-deps -T restore-check check <"$task_temp/backup.dump"
compose stop edge backup frontend backend
compose run --rm --no-deps -T -e RESTORE_ALLOW_REPLACE=replace-current-database restore-check replace <"$task_temp/backup.dump"
compose up --no-deps --force-recreate --abort-on-container-exit --exit-code-from migrate migrate
compose up -d --no-deps --force-recreate --wait backend
compose up -d --no-deps --force-recreate --wait frontend
compose up -d --no-deps --force-recreate --wait edge backup
task_restored_users=$(compose exec -T postgres psql -U postgres -d skillbetting -Atc 'SELECT count(*) FROM users')
[ "$task_restored_users" = 2 ]
compose run --rm --no-deps -T --entrypoint node \
  -e NODE_EXTRA_CA_CERTS=/verification/root.crt -e SMOKE_TEST_ALLOWED=isolated-compose \
  -v "$task_temp:/verification:ro" backend /verification/smoke-api.mjs
echo 'Disposable container verification passed, including TLS/API/websocket, private views, invalid-game funds guard, exact retries, card settlement, strict chess artifacts, backup/full restore, cold proof verification and resumed chess checkmate/settlement.'
