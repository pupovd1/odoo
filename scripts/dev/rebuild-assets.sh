#!/usr/bin/env bash
# Regenerate crm_offline's compiled front-end assets (JS/CSS bundles).
#
# Run it after any front-end change (JS, SCSS, QWeb templates, manifest
# "assets") and before re-testing: a test that fails only because a bundle
# was stale is not a real result.
#
# Usage: scripts/dev/rebuild-assets.sh
#
# Deletes every compiled bundle (ir.attachment under /web/assets/), clears the
# asset caches (a running dev server is notified through the database and
# reloads its bundle definitions on its next request), then regenerates the
# bundles the web client loads. Reload the browser page afterwards.
# Output: terminal and logs/rebuild-assets.log.

# shellcheck source=scripts/dev/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

case "${1:-}" in -h|--help) sed -n '2,14p' "$0"; exit 0 ;; esac
(( $# == 0 )) || die "Usage: scripts/dev/rebuild-assets.sh"

require_setup
ensure_postgres
acquire_lock
db_exists || die "Database $DB_NAME does not exist: run scripts/dev/start.sh or scripts/dev/reset-db.sh first."

LOG="$LOG_DIR/rebuild-assets.log"
: >"$LOG"
show_cmd "${ODOO[@]}" shell -c "$ODOO_CONF" -d "$DB_NAME" --no-http --log-level=warn
odoo_shell <<'PY' 2>&1 | tee -a "$LOG"
import time

started = time.time()
Attachment = env['ir.attachment'].sudo()
stale = Attachment.search([('url', '=like', '/web/assets/%')])
deleted = len(stale)
stale.unlink()
# Clear the cached bundle definitions; the commit also signals the other
# processes (a running dev server) to clear theirs.
env.transaction.invalidate_ormcache('assets')
env.cr.commit()
env['ir.qweb']._pregenerate_assets_bundles()
env.cr.commit()
fresh = Attachment.search([('url', '=like', '/web/assets/%')])
bundles = sorted({name.split('.min.')[0] for name in fresh.mapped('name')})
print(f"Deleted {deleted} compiled asset files; generated {len(fresh)} for {len(bundles)} bundles"
      f" in {time.time() - started:.1f}s: {', '.join(bundles)}")
PY
log "Assets rebuilt. Reload open browser pages."
