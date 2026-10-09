# shellcheck shell=bash
# Shared helpers for the scripts in scripts/dev/. Source this file; don't run it.

set -Eeuo pipefail

DEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DEV_DIR/../.." && pwd)"
cd "$REPO_ROOT"

ODOO_CONF="$DEV_DIR/odoo.conf"
DB_NAME="${ODOO_DB:-crm_offline}"
# shellcheck disable=SC2034  # the ports are used by the scripts that source this file
HTTP_PORT="${ODOO_HTTP_PORT:-8069}"
# Test runs start their own HTTP server (HttpCase needs one). Give them their
# own port so they never collide with a dev server on $HTTP_PORT.
# shellcheck disable=SC2034
TEST_HTTP_PORT="${ODOO_TEST_HTTP_PORT:-8070}"
VENV_DIR="${ODOO_VENV:-$REPO_ROOT/.venv}"
PY="$VENV_DIR/bin/python"
LOG_DIR="$REPO_ROOT/logs"
SERVER_LOG="$LOG_DIR/odoo.log"
PID_FILE="$LOG_DIR/odoo.pid"
mkdir -p "$LOG_DIR"
# Keep logs/ out of git status (and out of check.sh's change set) without
# touching .gitignore: list it in the clone-local exclude file.
if _exclude="$(git rev-parse --git-path info/exclude 2>/dev/null)"; then
    grep -qxF '/logs/' "$_exclude" 2>/dev/null \
        || { mkdir -p "$(dirname "$_exclude")" && echo '/logs/' >>"$_exclude"; }
fi

ODOO=("$PY" "$REPO_ROOT/odoo-bin")

# --- output -----------------------------------------------------------------

if [[ -t 2 ]]; then _c_blue=$'\e[1;34m' _c_yellow=$'\e[1;33m' _c_red=$'\e[1;31m' _c_green=$'\e[1;32m' _c_off=$'\e[0m'
else _c_blue='' _c_yellow='' _c_red='' _c_green='' _c_off=''; fi

log()  { printf '%s==>%s %s\n' "$_c_blue" "$_c_off" "$*" >&2; }
warn() { printf '%sWARNING:%s %s\n' "$_c_yellow" "$_c_off" "$*" >&2; }
die()  { printf '%sERROR:%s %s\n' "$_c_red" "$_c_off" "$*" >&2; exit 1; }

# Print a command the way it can be re-run from the repository root.
show_cmd() {
    local out='' arg
    for arg in "$@"; do
        arg="${arg//"$REPO_ROOT"\//}"
        out+="$(printf '%q' "$arg") "
    done
    printf '%s$%s %s\n' "$_c_green" "$_c_off" "${out% }" >&2
}

as_root() { if [[ $EUID -eq 0 ]]; then "$@"; else sudo "$@"; fi; }

# --- configuration ----------------------------------------------------------

conf_get() {  # conf_get KEY -> value of KEY in odoo.conf
    awk -v key="$1" '
        /^[[:space:]]*[;#]/ { next }
        {
            i = index($0, "=")
            if (!i) next
            k = substr($0, 1, i - 1); v = substr($0, i + 1)
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", k)
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
            if (k == key) { print v; exit }
        }' "$ODOO_CONF"
}

PGHOST="$(conf_get db_host)"; PGPORT="$(conf_get db_port)"
PGUSER="$(conf_get db_user)"; PGPASSWORD="$(conf_get db_password)"
export PGHOST PGPORT PGUSER PGPASSWORD

# Odoo's test browser lookup honours ODOO_BROWSER_BIN; setup.sh links the
# Chrome/Chromium it found or installed to .venv/bin/chromium.
export ODOO_BROWSER_BIN="${ODOO_BROWSER_BIN:-$VENV_DIR/bin/chromium}"
export PATH="$VENV_DIR/bin:$PATH"

require_setup() {
    [[ -x "$PY" ]] || die "No Python environment at ${VENV_DIR#"$REPO_ROOT"/}: run scripts/dev/setup.sh first."
    [[ -x "$ODOO_BROWSER_BIN" ]] || warn "No browser at $ODOO_BROWSER_BIN: browser tests will be skipped (and reported as failures). Run scripts/dev/setup.sh."
}

# --- PostgreSQL -------------------------------------------------------------

pg_ready() { pg_isready -q -h "$PGHOST" -p "$PGPORT" >/dev/null 2>&1; }

ensure_postgres() {
    pg_ready && return 0
    log "PostgreSQL is not accepting connections on $PGHOST:$PGPORT; starting it"
    if command -v pg_lsclusters >/dev/null 2>&1; then
        local ver name port _rest
        while read -r ver name port _rest; do
            [[ "$port" == "$PGPORT" ]] && as_root pg_ctlcluster "$ver" "$name" start || true
        done < <(pg_lsclusters --no-header 2>/dev/null)
    elif command -v systemctl >/dev/null 2>&1; then
        as_root systemctl start postgresql || true
    fi
    local _
    for _ in $(seq 60); do pg_ready && return 0; sleep 0.5; done
    die "PostgreSQL is not reachable on $PGHOST:$PGPORT (run scripts/dev/setup.sh)."
}

psql_q() {  # psql_q DB SQL -> unaligned, tuples-only output
    psql -X -q -At -v ON_ERROR_STOP=1 -d "$1" -c "$2"
}

db_exists() {
    [[ "$(psql_q postgres "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'")" == 1 ]]
}

module_state() {  # module_state NAME -> state in $DB_NAME, empty if unknown
    psql_q "$DB_NAME" "SELECT state FROM ir_module_module WHERE name = '$1'" 2>/dev/null || true
}

db_has_demo() {
    [[ "$(psql_q "$DB_NAME" "SELECT demo FROM ir_module_module WHERE name = 'base'" 2>/dev/null)" == t ]]
}

# Run a command, showing its output and appending it to LOGFILE.
run_logged() {  # run_logged LOGFILE CMD...
    local logfile="$1"; shift
    show_cmd "$@"
    printf '\n===== %s: %s =====\n' "$(date -Is)" "${*//"$REPO_ROOT"\//}" >>"$logfile"
    "$@" 2>&1 | tee -i -a "$logfile"
}

odoo_shell() {  # odoo_shell < python-code   (runs in an odoo-bin shell on $DB_NAME)
    "${ODOO[@]}" shell -c "$ODOO_CONF" -d "$DB_NAME" --no-http --log-level=warn
}

drop_db() {  # drop_db [LOGFILE]
    db_exists || return 0
    log "Dropping database $DB_NAME (and its filestore)"
    run_logged "${1:-$SERVER_LOG}" "${ODOO[@]}" db -c "$ODOO_CONF" drop "$DB_NAME"
    ! db_exists || die "Could not drop $DB_NAME"
}

create_db() {
    log "Creating $DB_NAME with crm, mail and demo data (a few minutes)"
    run_logged "$SERVER_LOG" "${ODOO[@]}" -c "$ODOO_CONF" -d "$DB_NAME" -i crm,mail --with-demo --stop-after-init \
        || die "Creating $DB_NAME failed, see logs/odoo.log"
}

# Make sure $DB_NAME exists with crm, mail and demo data installed.
ensure_db() {
    if ! db_exists; then
        create_db
    fi
    [[ "$(module_state base)" == installed ]] \
        || die "$DB_NAME exists but is not an initialized Odoo database. Run scripts/dev/reset-db.sh."
    if [[ "$(module_state crm)" != installed || "$(module_state mail)" != installed ]]; then
        log "Installing crm and mail in $DB_NAME"
        run_logged "$SERVER_LOG" "${ODOO[@]}" -c "$ODOO_CONF" -d "$DB_NAME" -i crm,mail --stop-after-init \
            || die "Installing crm/mail failed, see logs/odoo.log"
    fi
    if ! db_has_demo; then
        log "Loading demo data into $DB_NAME"
        odoo_shell <<'PY'
import odoo.modules.loading
odoo.modules.loading.force_demo(env)
env.cr.commit()
PY
    fi
    if [[ "$(module_state crm)" != installed || "$(module_state mail)" != installed ]] || ! db_has_demo; then
        die "$DB_NAME is missing crm, mail or demo data. Run scripts/dev/reset-db.sh."
    fi
}

# --- dev server -------------------------------------------------------------

# A background server outlives start.sh and is reaped by init, which may leave
# it a zombie for a while after it exits: don't count zombies as running.
pid_alive() { [[ "$(ps -o stat= -p "$1" 2>/dev/null)" =~ ^[^Z] ]]; }

dev_server_pid() {  # prints the pid of the server started by start.sh, if running
    local pid
    [[ -s "$PID_FILE" ]] || return 1
    pid="$(<"$PID_FILE")"
    [[ "$pid" =~ ^[0-9]+$ ]] && pid_alive "$pid" || return 1
    tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q "odoo-bin" || return 1
    echo "$pid"
}

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

stop_dev_server() {
    local pid _
    if ! pid="$(dev_server_pid)"; then
        rm -f "$PID_FILE"
        return 0
    fi
    log "Stopping the dev server (pid $pid)"
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 60); do pid_alive "$pid" || break; sleep 0.5; done
    if pid_alive "$pid"; then
        warn "Dev server did not stop after 30s; killing it"
        kill_tree "$pid"
    fi
    rm -f "$PID_FILE"
}

# Commands that modify $DB_NAME stop the dev server first: it would hold the
# database open, run crons concurrently with the tests, and keep serving code
# that the update just replaced.
stop_dev_server_for() {  # stop_dev_server_for WHAT
    if dev_server_pid >/dev/null; then
        warn "The dev server uses $DB_NAME; stopping it before $1. Restart it afterwards with scripts/dev/start.sh."
        stop_dev_server
    fi
}

# Serialize the scripts that modify $DB_NAME (two test runs updating the same
# database at once fail in confusing ways).
acquire_lock() {
    exec 9>"$LOG_DIR/.dev.lock"
    if ! flock -n 9; then
        log "Another scripts/dev command is using $DB_NAME; waiting for it to finish"
        flock 9
    fi
}
release_lock() { flock -u 9 2>/dev/null || true; exec 9>&-; }

# --- measured test runs -----------------------------------------------------

descendants() {  # descendants PID -> PID and all its descendants, one per line
    ps -e -o pid=,ppid= | awk -v root="$1" '
        { parent[$1] = $2 }
        END {
            keep[root] = 1; changed = 1
            while (changed) {
                changed = 0
                for (p in parent) if (!(p in keep) && (parent[p] in keep)) { keep[p] = 1; changed = 1 }
            }
            for (p in keep) print p
        }'
}

kill_tree() {
    local pids
    pids="$(descendants "$1" | tr '\n' ' ')"
    # shellcheck disable=SC2086
    kill -KILL $pids 2>/dev/null || true
}

tree_rss_kb() {  # tree_rss_kb PID -> "<rss of the tree> <rss of the largest odoo-bin process>" (KiB)
    local pids
    pids="$(descendants "$1" | paste -sd, -)"
    ps -o rss=,args= -p "$pids" 2>/dev/null | awk '
        { total += $1; if ($0 ~ /odoo-bin/ && $1 > odoo) odoo = $1 }
        END { print total + 0, odoo + 0 }'
}

mem_used_kb() { awk '/^MemTotal:/ {t = $2} /^MemAvailable:/ {a = $2} END {print t - a}' /proc/meminfo; }

mib() { awk -v kb="$1" 'BEGIN { printf "%.0f MiB", kb / 1024 }'; }

duration() { awk -v s="$1" 'BEGIN { printf "%dm%02ds", s / 60, s % 60 }'; }

RUN_SECONDS=0 RUN_PEAK_TREE=0 RUN_PEAK_ODOO=0 RUN_PEAK_SYS=0 RUN_BASE_SYS=0

_abort_run() {  # Ctrl-C during a measured run: stop odoo-bin and the Chrome it started
    local pids
    pids="$(descendants "$1" | tr '\n' ' ')"
    kill -TERM "$1" 2>/dev/null || true
    sleep 2
    # shellcheck disable=SC2086
    kill -KILL $pids 2>/dev/null || true
    exit 130
}

# run_measured LOGFILE CMD...: run CMD, show its output and append it to
# LOGFILE, and accumulate wall time and peak memory (Odoo + its Chrome
# children, and the whole machine) in the RUN_* variables. Returns CMD's status.
run_measured() {
    local logfile="$1"; shift
    show_cmd "$@"
    printf '\n===== %s: %s =====\n' "$(date -Is)" "${*//"$REPO_ROOT"\//}" >>"$logfile"
    local start=$EPOCHREALTIME rc=0 pid tree odoo sys
    (( RUN_BASE_SYS )) || RUN_BASE_SYS="$(mem_used_kb)"
    ( set -o pipefail; "$@" 2>&1 | tee -i -a "$logfile" ) &
    pid=$!
    # shellcheck disable=SC2064
    trap "_abort_run $pid" INT TERM
    while kill -0 "$pid" 2>/dev/null; do
        read -r tree odoo < <(tree_rss_kb "$pid") || true
        sys="$(mem_used_kb)"
        (( tree > RUN_PEAK_TREE )) && RUN_PEAK_TREE=$tree
        (( odoo > RUN_PEAK_ODOO )) && RUN_PEAK_ODOO=$odoo
        (( sys > RUN_PEAK_SYS )) && RUN_PEAK_SYS=$sys
        sleep 1
    done
    wait "$pid" || rc=$?
    trap - INT TERM
    RUN_SECONDS="$(awk -v a="$start" -v b="$EPOCHREALTIME" -v acc="$RUN_SECONDS" 'BEGIN { print acc + b - a }')"
    return "$rc"
}

print_resources() {
    printf '  wall time:    %s\n' "$(duration "$RUN_SECONDS")"
    printf '  peak memory:  odoo-bin %s; odoo-bin + Chrome %s; machine in use %s (was %s before the run)\n' \
        "$(mib "$RUN_PEAK_ODOO")" "$(mib "$RUN_PEAK_TREE")" "$(mib "$RUN_PEAK_SYS")" "$(mib "$RUN_BASE_SYS")"
}

# check_test_log LOGFILE RC [EXPECTED_TEST...]
# Decide whether a test run really passed. Odoo exits 0 when it collects zero
# tests or when a browser test is skipped (no Chrome, no websocket-client), so
# besides the exit status this requires: a final test summary with at least one
# test run, no skipped test, no ERROR/CRITICAL log line, and every
# EXPECTED_TEST started (Class.method, or Class for any test of that class).
# Sets CHECK_PROBLEMS; returns 0 or 1.
# LOGFILE holds everything one script invocation ran (the scripts truncate it).
check_test_log() {
    local logfile="$1" rc="$2"; shift 2
    local run summary ran=0 failed=0 errors=0 skipped started errlines problems=() t
    run="$(<"$logfile")"
    summary="$(grep -E 'odoo\.tests\.result: [0-9]+ failed, [0-9]+ error\(s\) of [0-9]+ tests when loading database' <<<"$run" | tail -n1 || true)"
    if [[ "$summary" =~ ([0-9]+)\ failed,\ ([0-9]+)\ error\(s\)\ of\ ([0-9]+)\ tests ]]; then
        failed="${BASH_REMATCH[1]}" errors="${BASH_REMATCH[2]}" ran="${BASH_REMATCH[3]}"
    fi
    started="$(grep -cE ': Starting [^ ]+ \.\.\.$' <<<"$run" || true)"
    skipped="$(grep -cE ': skipped [^ ]+ : ' <<<"$run" || true)"
    errlines="$(grep -cE '^[0-9-]+ [0-9:,]+ [0-9]+ (ERROR|CRITICAL) ' <<<"$run" || true)"

    (( rc == 0 )) || problems+=("odoo-bin exited with status $rc")
    [[ -n "$summary" ]] || problems+=("no test summary in the log (odoo-bin stopped before running tests?)")
    if [[ -n "$summary" ]] && (( ran == 0 )); then problems+=("zero tests were collected"); fi
    (( failed + errors == 0 )) || problems+=("$failed failed, $errors error(s)")
    if (( skipped > 0 )); then
        if (( skipped >= ran )); then problems+=("the whole suite was skipped ($skipped skipped)")
        else problems+=("$skipped test(s) skipped"); fi
    fi
    (( errlines == 0 )) || problems+=("$errlines ERROR/CRITICAL log line(s)")
    for t in "$@"; do
        if [[ "$t" == *.* ]]; then
            grep -qE ": Starting ${t//./\\.} \.\.\.\$" <<<"$run" || problems+=("$t did not run")
        else
            grep -qE ": Starting ${t}\.[^ ]+ \.\.\.\$" <<<"$run" || problems+=("no test of $t ran")
        fi
    done

    printf '\n  tests:        %s run, %s failed, %s error(s), %s skipped (%s started)\n' \
        "$ran" "$failed" "$errors" "$skipped" "$started"
    if (( skipped > 0 )); then
        printf '  skipped:\n'; grep -E ': skipped [^ ]+ : ' <<<"$run" | sed -E 's/.*: skipped /    /' | head -n 20
    fi
    if (( errlines > 0 )); then
        printf '  ERROR/CRITICAL lines:\n'
        grep -E '^[0-9-]+ [0-9:,]+ [0-9]+ (ERROR|CRITICAL) ' <<<"$run" | cut -c1-220 | head -n 20 | sed 's/^/    /'
    fi
    CHECK_PROBLEMS=("${problems[@]}")
    (( ${#problems[@]} == 0 ))
}

# print_verdict NAME LOGFILE: print the final PASSED/FAILED block from
# CHECK_PROBLEMS and the RUN_* measurements; returns 0 if nothing went wrong.
print_verdict() {
    local name="$1" logfile="$2" p
    print_resources
    printf '  log:          %s\n' "${logfile#"$REPO_ROOT"/}"
    if (( ${#CHECK_PROBLEMS[@]} == 0 )); then
        printf '%s%s: PASSED%s\n' "$_c_green" "$name" "$_c_off"
        return 0
    fi
    printf '%s%s: FAILED%s\n' "$_c_red" "$name" "$_c_off"
    for p in "${CHECK_PROBLEMS[@]}"; do printf '  - %s\n' "$p"; done
    return 1
}
