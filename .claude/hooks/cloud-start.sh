#!/usr/bin/env bash
# SessionStart hook, cloud sessions only. Unless CLAUDE_CODE_REMOTE is "true",
# exit 0 at once and do nothing. In a Claude Code cloud session: start
# PostgreSQL, create the role scripts/dev/odoo.conf names if it is missing,
# and check that scripts/dev/start.sh can connect with it. Prints one status
# line on stdout (added to the session's context); errors go to stderr.
# Idempotent. Installs nothing: without PostgreSQL, run scripts/dev/setup.sh.
# The hook's timeout in .claude/settings.json (110 s) caps the run.

[[ "${CLAUDE_CODE_REMOTE:-}" == true ]] || exit 0

root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
# lib.sh exports odoo.conf's connection settings as PG* variables and defines
# ensure_postgres, psql_q and db_exists: the same code start.sh runs.
# shellcheck source=scripts/dev/lib.sh
source "$root/scripts/dev/lib.sh"

# Run a command as the postgres OS user, over the local socket (without the
# PG* variables lib.sh exports for the odoo role). Same as in setup.sh.
as_postgres() {
    local clean=(env -u PGHOST -u PGUSER -u PGPASSWORD -u PGDATABASE)
    (cd / && if [[ $EUID -eq 0 ]]; then runuser -u postgres -- "${clean[@]}" "$@"; else sudo -u postgres "${clean[@]}" "$@"; fi)
}

for c in pg_isready psql; do
    command -v "$c" >/dev/null 2>&1 || die "PostgreSQL is not installed ($c is missing); run scripts/dev/setup.sh."
done
ensure_postgres

if [[ "$(as_postgres psql -XAtq -p "$PGPORT" -c "SELECT 1 FROM pg_roles WHERE rolname = '$PGUSER'")" != 1 ]]; then
    log "Creating PostgreSQL role $PGUSER"
    as_postgres psql -XAtq -p "$PGPORT" -c "CREATE ROLE \"$PGUSER\" LOGIN CREATEDB PASSWORD '$PGPASSWORD'"
fi

# start.sh connects over TCP with odoo.conf's credentials and creates
# $DB_NAME when it is missing, so the role must log in and create databases.
psql_q postgres "SELECT 1" >/dev/null \
    || die "Role $PGUSER cannot log in on $PGHOST:$PGPORT with the password in scripts/dev/odoo.conf (scripts/dev/setup.sh resets it)."
[[ "$(psql_q postgres "SELECT rolcreatedb FROM pg_roles WHERE rolname = current_user")" == t ]] \
    || die "Role $PGUSER cannot create databases, which start.sh needs to create $DB_NAME."

status="PostgreSQL $(psql_q postgres "SHOW server_version") is up on $PGHOST:$PGPORT; role $PGUSER connects as scripts/dev/start.sh does"
if db_exists; then status+="; $DB_NAME exists"; else status+="; $DB_NAME does not exist yet (start.sh creates it)"; fi
[[ -x "$PY" ]] || status+=". No .venv yet: run scripts/dev/setup.sh before start.sh"
echo "$status."
