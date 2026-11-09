#!/bin/sh
set -eu
umask 077
task_deploy=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
task_env=${SKILLBETTING_ENV_FILE:-$task_deploy/.env}
task_node='node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c'

compose() { docker compose --env-file "$task_env" -f "$task_deploy/compose.yml" "$@"; }
require_settings() {
  [ -f "$task_env" ] || { echo 'Run ./deploy/manage.sh init first.' >&2; exit 1; }
  docker info >/dev/null
}
check_config() {
  require_settings
  compose config --quiet
  compose config --format json | docker run --rm -i --network none \
    -v "$task_deploy:/deployment:ro" "$task_node" node /deployment/verify-compose.mjs
}
run_migrations() {
  compose up --no-deps --force-recreate --abort-on-container-exit --exit-code-from migrate migrate
}
apply_release() {
  check_config
  task_tag=${RELEASE_ID:-$(sed -n 's/^RELEASE_ID=//p' "$task_env")}
  if ! docker image inspect "skillbetting-backend:$task_tag" >/dev/null 2>&1; then compose build backend; fi
  if ! docker image inspect "skillbetting-frontend:$task_tag" >/dev/null 2>&1; then compose build frontend; fi
  compose run --rm --no-deps --entrypoint caddy edge validate --config /etc/caddy/Caddyfile --adapter caddyfile
  compose up -d --no-recreate --wait postgres
  task_has_schema=$(compose exec -T postgres psql -U postgres -d skillbetting -Atc "SELECT to_regclass('schema_migrations') IS NOT NULL")
  if [ "$task_has_schema" = t ]; then compose run --rm --no-deps backup once; fi
  run_migrations
  # Refresh bind-mounted release configuration without recreating PostgreSQL.
  compose up -d --no-deps --force-recreate --wait backend
  compose up -d --no-deps --force-recreate --wait frontend
  compose up -d --no-deps --force-recreate --wait edge backup
  compose ps
  echo 'Release services are healthy. Verify public DNS/TLS and the browser before announcing availability.'
}

case "${1:-help}" in
  init)
    docker info >/dev/null
    task_parent=$(CDPATH= cd -- "$(dirname -- "$task_env")" && pwd)
    task_base=${task_env##*/}
    docker run --rm --network none --user "$(id -u):$(id -g)" \
      -v "$task_parent:/settings" -v "$task_deploy:/deployment:ro" "$task_node" \
      node /deployment/generate-env.mjs "/settings/$task_base" "${2:-dev.stoiximatakia.gr}"
    ;;
  check) check_config ;;
  up) apply_release ;;
  release)
    task_release=${2:?Supply a new immutable release tag}
    case "$task_release" in ''|*[!a-zA-Z0-9_.-]*) echo 'Invalid release tag.' >&2; exit 1;; esac
    if docker image inspect "skillbetting-backend:$task_release" >/dev/null 2>&1 || docker image inspect "skillbetting-frontend:$task_release" >/dev/null 2>&1; then
      echo 'Release tag already exists. Use a new tag; previous images remain immutable for rollback.' >&2; exit 1;
    fi
    task_previous=$(sed -n 's/^RELEASE_ID=//p' "$task_env")
    RELEASE_ID=$task_release; export RELEASE_ID
    echo "Preparing release $task_release; previous tag $task_previous remains available for rollback."
    apply_release
    task_temporary="$task_env.release.$$"
    sed "s/^RELEASE_ID=.*/RELEASE_ID=$task_release/" "$task_env" >"$task_temporary"
    mv "$task_temporary" "$task_env"
    printf '%s %s previous=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$task_release" "$task_previous" >>"$task_deploy/releases.log"
    ;;
  rollback)
    require_settings
    task_release=${2:?Supply the previous compatible application image tag}
    case "$task_release" in ''|*[!a-zA-Z0-9_.-]*) exit 1;; esac
    RELEASE_ID=$task_release; export RELEASE_ID
    docker image inspect "skillbetting-backend:$task_release" >/dev/null
    docker image inspect "skillbetting-frontend:$task_release" >/dev/null
    # Explicitly no migration/schema rollback or database deletion here.
    compose up -d --no-deps --no-build --force-recreate --wait backend
    compose up -d --no-deps --no-build --force-recreate --wait frontend
    compose up -d --no-deps --no-build --force-recreate --wait edge backup
    task_temporary="$task_env.release.$$"
    sed "s/^RELEASE_ID=.*/RELEASE_ID=$task_release/" "$task_env" >"$task_temporary"
    mv "$task_temporary" "$task_env"
    echo 'Application images and edge/backup configuration rolled back. Database/schema retained; inspect readiness and user flows.'
    ;;
  backup)
    require_settings
    compose run --rm --no-deps backup once
    ;;
  export-backup)
    require_settings
    task_name=${2:?Supply the dump filename printed by backup}
    task_destination=${3:?Supply a private destination path}
    case "$task_name" in skillbetting-*.dump) ;; *) exit 1;; esac
    case "$task_name" in *[!a-zA-Z0-9_.-]*) exit 1;; esac
    [ ! -e "$task_destination" ] || { echo 'Destination already exists.' >&2; exit 1; }
    task_temporary=$(mktemp "$task_destination.partial.XXXXXX")
    trap 'rm -f "$task_temporary"' EXIT HUP INT TERM
    compose exec -T backup cat "/backups/$task_name" >"$task_temporary"
    mv "$task_temporary" "$task_destination"
    trap - EXIT HUP INT TERM
    echo 'Private backup exported. Store an encrypted copy outside this server.'
    ;;
  restore-check)
    require_settings
    task_archive=${2:?Supply a trusted custom-format dump file}
    [ -f "$task_archive" ] || exit 1
    compose run --rm --no-deps -T restore-check check <"$task_archive"
    ;;
  restore)
    require_settings
    task_archive=${2:?Supply a trusted custom-format dump file}
    [ "${3:-}" = --replace-current-database ] || {
      echo 'This replaces the current database. First restore-check the dump, retain a backup and explicitly pass --replace-current-database.' >&2; exit 1;
    }
    [ -f "$task_archive" ] || exit 1
    compose run --rm --no-deps -T restore-check check <"$task_archive"
    compose run --rm --no-deps backup once
    compose stop edge backup frontend backend
    compose run --rm --no-deps -T -e RESTORE_ALLOW_REPLACE=replace-current-database restore-check replace <"$task_archive"
    run_migrations
    compose up -d --no-deps --force-recreate --wait backend
    compose up -d --no-deps --force-recreate --wait frontend
    compose up -d --no-deps --force-recreate --wait edge backup
    ;;
  status) require_settings; compose ps ;;
  logs) require_settings; compose logs --tail=100 "${2:-backend}" ;;
  stop) require_settings; compose stop ;;
  help|*)
    echo 'Usage: ./deploy/manage.sh init [hostname] | check | up | release TAG | rollback TAG'
    echo '       backup | export-backup NAME DEST | restore-check FILE | restore FILE --replace-current-database'
    echo '       status | logs [service] | stop'
    echo 'Native development remains npm run start:dev / npm run dev. Docker is optional locally.'
    ;;
esac
