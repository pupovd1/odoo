#!/usr/bin/env bash
# The forbidden-statement guard: fails if a .test.js file in the unit-test
# bundle (every installed module, crm included) calls only() or debug().
# The check is HootSuite.test_check_suite; it matches the regex
# test.*\.(only|debug)\( line by line (so test.only(...) but not describe.only(...)).
#
# Usage: scripts/dev/test-guard.sh
#
# Runs, against crm_offline:
#   odoo-bin -d crm_offline -u crm --stop-after-init
#   odoo-bin -d crm_offline --test-enable --test-tags /web:HootSuite.test_check_suite --stop-after-init --log-level=test
# (in one command with -u crm, the /web: test is never collected: see test-js.sh)
# Fails if odoo-bin fails, the check does not run or is skipped, or it fails.
# Output: terminal and logs/test-guard.log.

# shellcheck source=scripts/dev/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

case "${1:-}" in -h|--help) sed -n '2,15p' "$0"; exit 0 ;; esac
(( $# == 0 )) || die "Usage: scripts/dev/test-guard.sh"
TEST=HootSuite.test_check_suite

require_setup
ensure_postgres
acquire_lock
stop_dev_server_for "running the tests"
ensure_db

LOG="$LOG_DIR/test-guard.log"
: >"$LOG"
rc=0
run_measured "$LOG" "${ODOO[@]}" -c "$ODOO_CONF" -d "$DB_NAME" -u crm --stop-after-init \
    --http-port="$TEST_HTTP_PORT" || rc=$?
if (( rc == 0 )); then
    run_measured "$LOG" "${ODOO[@]}" -c "$ODOO_CONF" -d "$DB_NAME" --test-enable --test-tags "/web:$TEST" \
        --stop-after-init --log-level=test --http-port="$TEST_HTTP_PORT" || rc=$?
fi
check_test_log "$LOG" "$rc" "$TEST" || true
print_verdict "test-guard.sh" "$LOG"
