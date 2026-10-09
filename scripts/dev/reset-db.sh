#!/usr/bin/env bash
# Drop crm_offline (database and filestore) and recreate it clean, with crm,
# mail and demo data installed. Stops the dev server first if it is running.
#
# Usage: scripts/dev/reset-db.sh
#
# Runs:
#   odoo-bin db drop crm_offline
#   odoo-bin -d crm_offline -i crm,mail --with-demo --stop-after-init
# Output: terminal and logs/odoo.log.

# shellcheck source=scripts/dev/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

case "${1:-}" in -h|--help) sed -n '2,10p' "$0"; exit 0 ;; esac
(( $# == 0 )) || die "Usage: scripts/dev/reset-db.sh"

require_setup
ensure_postgres
acquire_lock
stop_dev_server_for "resetting the database"

started=$EPOCHREALTIME
drop_db
create_db
ensure_db
log "$DB_NAME recreated in $(duration "$(awk -v a="$started" -v b="$EPOCHREALTIME" 'BEGIN { print b - a }')"):" \
    "$(psql_q "$DB_NAME" "SELECT count(*) FROM ir_module_module WHERE state = 'installed'") modules installed," \
    "$(psql_q "$DB_NAME" "SELECT count(*) FROM crm_lead") leads (demo data)."
