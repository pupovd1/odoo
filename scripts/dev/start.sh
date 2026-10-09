#!/usr/bin/env bash
# Start Odoo on http://localhost:8069 against the crm_offline database,
# creating it first (crm, mail and demo data) if it is missing.
#
# The server listens on 127.0.0.1 only. Browsers treat http://localhost as a
# secure context, which Odoo's offline features need: on a plain-HTTP URL
# with any other host name they are disabled. Server output goes to the
# terminal and to logs/odoo.log.
#
# Usage: scripts/dev/start.sh [--background] [ODOO-BIN OPTION...]
#   --background  detach once the server answers (stop it with scripts/dev/stop.sh)
#   other options are passed to odoo-bin, e.g. --dev=xml or -u crm

# shellcheck source=scripts/dev/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BACKGROUND=0
EXTRA=()
for arg in "$@"; do
    case "$arg" in
        --background|-b) BACKGROUND=1 ;;
        -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
        *) EXTRA+=("$arg") ;;
    esac
done

require_setup
ensure_postgres

URL="http://localhost:$HTTP_PORT"
if pid="$(dev_server_pid)"; then
    log "Odoo is already running (pid $pid): $URL"
    exit 0
fi
port_in_use "$HTTP_PORT" && die "Port $HTTP_PORT is already in use by a process start.sh did not start."

acquire_lock
ensure_db
release_lock

CMD=("${ODOO[@]}" -c "$ODOO_CONF" -d "$DB_NAME" --http-port="$HTTP_PORT" "${EXTRA[@]}")
printf '\n===== %s: start.sh =====\n' "$(date -Is)" >>"$SERVER_LOG"
show_cmd "${CMD[@]}"

wait_until_up() {  # wait_until_up PID: until /web/health answers (or PID dies)
    local _
    for _ in $(seq 480); do
        pid_alive "$1" || return 1
        curl -fs -o /dev/null --max-time 2 "http://127.0.0.1:$HTTP_PORT/web/health" && return 0
        sleep 0.5
    done
    return 1
}

banner() {
    log "Odoo is up: $URL  (database $DB_NAME, login admin / password admin)"
    log "Server log: logs/odoo.log"
}

if (( BACKGROUND )); then
    rm -f "$PID_FILE"
    # setsid: keep the server out of this terminal's process group.
    # shellcheck disable=SC2016  # $$ and $0 are for the inner bash
    nohup setsid bash -c 'echo $$ >"$0"; exec "$@"' "$PID_FILE" "${CMD[@]}" >>"$SERVER_LOG" 2>&1 </dev/null &
    for _ in $(seq 50); do [[ -s "$PID_FILE" ]] && break; sleep 0.1; done
    pid="$(<"$PID_FILE")"
    if ! wait_until_up "$pid"; then
        tail -n 40 "$SERVER_LOG" >&2
        die "Odoo did not come up (pid $pid); see logs/odoo.log"
    fi
    banner
    log "Running in the background (pid $pid); stop it with scripts/dev/stop.sh"
    exit 0
fi

# Foreground. Ctrl-C reaches odoo-bin directly (same process group), which
# then shuts down gracefully; tee -i keeps logging until it has exited.
exec 4> >(tee -i -a "$SERVER_LOG")
tee_pid=$!
"${CMD[@]}" >&4 2>&1 &
pid=$!
exec 4>&-
echo "$pid" >"$PID_FILE"
trap ':' INT
trap 'kill -TERM "$pid" 2>/dev/null || true' TERM
(wait_until_up "$pid" && banner) &
while true; do
    wait "$pid" && rc=0 || rc=$?
    kill -0 "$pid" 2>/dev/null || break
done
wait "$tee_pid" 2>/dev/null || true
rm -f "$PID_FILE"
exit "$rc"
