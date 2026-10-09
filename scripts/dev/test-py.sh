#!/usr/bin/env bash
# Run crm's Python tests against the crm_offline database.
#
# Usage: scripts/dev/test-py.sh                  all crm tests
#        scripts/dev/test-py.sh TestCrmOffline   one test class (or Class.test_method)
#
# All tests:
#   odoo-bin -d crm_offline -i crm --test-enable --test-tags /crm --stop-after-init --log-level=test
#   "-i crm" only installs crm, and only then runs its tests, when crm is not
#   installed yet: on an existing crm_offline it exits 0 having run zero tests.
#   So this mode first drops crm_offline and lets the command recreate it
#   (with demo data). Afterwards crm_offline is a fresh database again.
#   Note: /crm also selects the cross-module browser suites WebSuite and
#   MobileWebSuite for crm, i.e. crm's JS unit tests (see test-js.sh).
# One class:
#   odoo-bin -d crm_offline -u crm --test-enable --test-tags /crm:<class> --stop-after-init --log-level=test
#
# Both fail if odoo-bin fails, if zero tests run, if a test is skipped, or if
# anything is logged at ERROR level. Output: terminal and logs/test-py.log.

# shellcheck source=scripts/dev/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

case "${1:-}" in -h|--help) sed -n '2,21p' "$0"; exit 0 ;; esac
(( $# <= 1 )) || die "Usage: scripts/dev/test-py.sh [TestClass[.test_method]]"
TARGET="${1:-}"
[[ -z "$TARGET" || "$TARGET" =~ ^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$ ]] \
    || die "Not a test class name: $TARGET"

require_setup
ensure_postgres
acquire_lock
stop_dev_server_for "running the tests"

LOG="$LOG_DIR/test-py.log"
: >"$LOG"
ENV_ARGS=(--http-port="$TEST_HTTP_PORT")

rc=0
if [[ -z "$TARGET" ]]; then
    log "All crm tests: recreating $DB_NAME so that '-i crm' really installs (and tests) crm"
    drop_db "$LOG"
    run_measured "$LOG" "${ODOO[@]}" -c "$ODOO_CONF" -d "$DB_NAME" -i crm --test-enable --test-tags /crm \
        --stop-after-init --log-level=test --with-demo "${ENV_ARGS[@]}" || rc=$?
    check_test_log "$LOG" "$rc" || true
else
    ensure_db
    run_measured "$LOG" "${ODOO[@]}" -c "$ODOO_CONF" -d "$DB_NAME" -u crm --test-enable --test-tags "/crm:$TARGET" \
        --stop-after-init --log-level=test "${ENV_ARGS[@]}" || rc=$?
    check_test_log "$LOG" "$rc" "$TARGET" || true
fi
print_verdict "test-py.sh${TARGET:+ $TARGET}" "$LOG"
