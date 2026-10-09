#!/usr/bin/env bash
# Run crm's JavaScript unit tests (hoot) in headless Chromium.
#
# Usage: scripts/dev/test-js.sh desktop|mobile
#   desktop  WebSuite.test_unit_desktop
#   mobile   MobileWebSuite.test_unit_mobile (375x667 viewport, touch enabled)
#
# Runs, against crm_offline:
#   odoo-bin -d crm_offline -u crm --stop-after-init
#   odoo-bin -d crm_offline --test-enable --test-tags /crm:WebSuite.test_unit_desktop --stop-after-init --log-level=test
# The one-command form "-u crm --test-tags /web:WebSuite.test_unit_desktop"
# exits 0 having run zero tests: with -u, odoo-bin only collects the tests of
# the modules it updated, and WebSuite is defined in web. Hence crm is updated
# first, then the suite runs without -u. WebSuite and MobileWebSuite are
# cross-module tests: the module in the tag selects whose JS tests they run,
# so /crm: runs crm's tests (/web: would run web's own, much larger, suite).
#
# Fails if odoo-bin fails, if the suite is skipped (e.g. no Chrome), if hoot
# runs zero tests, or if a test fails. Run scripts/dev/rebuild-assets.sh after
# front-end changes. Output: terminal and logs/test-js-<preset>.log.

# shellcheck source=scripts/dev/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

case "${1:-}" in
    desktop) TEST=WebSuite.test_unit_desktop ;;
    mobile) TEST=MobileWebSuite.test_unit_mobile ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) die "Usage: scripts/dev/test-js.sh desktop|mobile" ;;
esac
(( $# == 1 )) || die "Usage: scripts/dev/test-js.sh desktop|mobile"
PRESET="$1"
TAG="/crm:$TEST"

require_setup
ensure_postgres
acquire_lock
stop_dev_server_for "running the tests"
ensure_db

LOG="$LOG_DIR/test-js-$PRESET.log"
: >"$LOG"
rc=0
run_measured "$LOG" "${ODOO[@]}" -c "$ODOO_CONF" -d "$DB_NAME" -u crm --stop-after-init \
    --http-port="$TEST_HTTP_PORT" || rc=$?
if (( rc == 0 )); then
    run_measured "$LOG" "${ODOO[@]}" -c "$ODOO_CONF" -d "$DB_NAME" --test-enable --test-tags "$TAG" \
        --stop-after-init --log-level=test --http-port="$TEST_HTTP_PORT" || rc=$?
fi
check_test_log "$LOG" "$rc" "$TEST" || true

# Python only sees one test; the JS test count comes from hoot's summary line.
hoot="$(grep -oE '(Passed|Failed) [0-9]+ tests \([^)]*\)' "$LOG" | tail -n1 || true)"
printf '  hoot:         %s\n' "${hoot:-no result reported}"
if [[ -z "$hoot" ]]; then
    CHECK_PROBLEMS+=("hoot reported no result: no JS test ran")
elif [[ "$hoot" =~ ^Passed\ ([0-9]+) ]]; then
    (( BASH_REMATCH[1] > 0 )) || CHECK_PROBLEMS+=("hoot ran zero JS tests")
else
    CHECK_PROBLEMS+=("hoot: $hoot")
fi
if grep -q 'no tests to run' "$LOG"; then CHECK_PROBLEMS+=("hoot: no tests to run"); fi
print_verdict "test-js.sh $PRESET" "$LOG"
