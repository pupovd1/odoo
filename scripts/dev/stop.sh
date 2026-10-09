#!/usr/bin/env bash
# Stop the Odoo server started by scripts/dev/start.sh (foreground or background).
#
# Usage: scripts/dev/stop.sh

# shellcheck source=scripts/dev/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if dev_server_pid >/dev/null; then
    stop_dev_server
    log "Stopped"
else
    log "No server started by start.sh is running"
    if port_in_use "$HTTP_PORT"; then
        warn "Port $HTTP_PORT is in use by a process start.sh did not start; not touching it."
    fi
fi
