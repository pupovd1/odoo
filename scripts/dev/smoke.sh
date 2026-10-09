#!/usr/bin/env bash
# Check the running dev server in headless Chromium: log in as admin, open the
# CRM pipeline, and verify it shows demo leads in a secure context
# (window.isSecureContext, required by Odoo's offline features) without
# JavaScript errors. Screenshot: logs/smoke-crm-pipeline.png.
#
# Usage: scripts/dev/smoke.sh   (with the server running: scripts/dev/start.sh --background)

# shellcheck source=scripts/dev/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_setup
curl -fs -o /dev/null --max-time 5 "http://127.0.0.1:$HTTP_PORT/web/health" \
    || die "No Odoo server answers on port $HTTP_PORT; start one with scripts/dev/start.sh --background."
show_cmd "$PY" "$DEV_DIR/smoke.py" --url "http://localhost:$HTTP_PORT" --db "$DB_NAME"
exec "$PY" "$DEV_DIR/smoke.py" --url "http://localhost:$HTTP_PORT" --db "$DB_NAME" \
    --browser "$ODOO_BROWSER_BIN" --screenshot "$LOG_DIR/smoke-crm-pipeline.png"
