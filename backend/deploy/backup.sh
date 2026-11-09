#!/bin/sh
set -eu
umask 077
task_keep=${BACKUP_KEEP:-14}
task_interval=${BACKUP_INTERVAL_SECONDS:-86400}
case "$task_keep" in ''|*[!0-9]*) echo 'BACKUP_KEEP must be a positive integer.' >&2; exit 1;; esac
case "$task_interval" in ''|*[!0-9]*) echo 'BACKUP_INTERVAL_SECONDS must be a positive integer.' >&2; exit 1;; esac
[ "$task_keep" -ge 1 ] && [ "$task_interval" -ge 60 ] || exit 1

backup_once() {
  task_partial=$(mktemp /backups/.partial.XXXXXX)
  trap 'rm -f "$task_partial"' EXIT HUP INT TERM
  pg_dump --format=custom --no-owner --no-acl --file="$task_partial"
  pg_restore --list "$task_partial" >/dev/null
  task_suffix=${task_partial##*.partial.}
  task_name="/backups/skillbetting-$(date -u +%Y%m%dT%H%M%SZ)-$task_suffix.dump"
  mv "$task_partial" "$task_name"
  trap - EXIT HUP INT TERM
  # Prune only this worker's names, only after a verified new dump succeeds.
  ls -1t /backups/skillbetting-*.dump | sed -n "$((task_keep + 1)),\$p" |
    while IFS= read -r task_old; do rm -f -- "$task_old"; done
  printf '%s\n' "${task_name##*/}"
}

case "${1:-once}" in
  once) backup_once ;;
  loop) while :; do backup_once; sleep "$task_interval"; done ;;
  *) echo 'Use once or loop.' >&2; exit 1 ;;
esac
