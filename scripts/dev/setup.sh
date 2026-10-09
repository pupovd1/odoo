#!/usr/bin/env bash
# Install what this Odoo checkout needs for development and testing: system
# packages, PostgreSQL (with an "odoo" role), a headless Chrome/Chromium and a
# Python virtualenv (.venv) with requirements.txt plus the packages it lacks.
# Idempotent: each step checks first and only installs what is missing.
#
# Usage: scripts/dev/setup.sh [--force-pip]
#   --force-pip  reinstall the Python packages even if nothing changed
# Environment:
#   PYTHON=python3.13      interpreter for .venv (default: python3.12, Ubuntu 24.04's)
#   ODOO_BROWSER_BIN=PATH  use this Chrome/Chromium instead of looking for one

USER_BROWSER_BIN="${ODOO_BROWSER_BIN:-}"
# shellcheck source=scripts/dev/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

FORCE_PIP=0
for arg in "$@"; do
    case "$arg" in
        --force-pip) FORCE_PIP=1 ;;
        -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
        *) die "Unknown argument: $arg (see --help)" ;;
    esac
done

# requirements.txt does not list these, but the test browser driver needs
# websocket-client and crm (via phone_validation) needs phonenumbers. Pinned to
# the Ubuntu 24.04 package versions, like the rest of requirements.txt.
EXTRA_PIP=("websocket-client==1.7.0" "phonenumbers==8.12.57")
MIN_PG=16  # MIN_PG_VERSION in odoo/release.py

command -v apt-get >/dev/null 2>&1 || die "setup.sh supports Debian/Ubuntu (apt-get) only."
# shellcheck source=/dev/null
. /etc/os-release

# Run a command as the postgres OS user, over the local socket (without the
# PG* variables lib.sh exports for the odoo role).
as_postgres() {
    local clean=(env -u PGHOST -u PGUSER -u PGPASSWORD -u PGDATABASE)
    (cd / && if [[ $EUID -eq 0 ]]; then runuser -u postgres -- "${clean[@]}" "$@"; else sudo -u postgres "${clean[@]}" "$@"; fi)
}
pkg_installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q "install ok installed"; }
pkg_available() { [[ "$(apt-cache policy "$1" 2>/dev/null | awk '/Candidate:/ {print $2}')" =~ ^[0-9] ]]; }
pkg_satisfied() {  # installed, or provided by an installed package (libmagic1 -> libmagic1t64)
    local sim
    pkg_installed "$1" && return 0
    [[ "$1" != */* ]] && sim="$(apt-get install -s -qq "$1" 2>/dev/null)" && ! grep -q '^Inst ' <<<"$sim"
}

APT_UPDATED=0
apt_install() {  # apt_install PKG... -> install the ones that are missing
    local missing=() p
    for p in "$@"; do pkg_satisfied "$p" || missing+=("$p"); done
    (( ${#missing[@]} )) || return 0
    if (( ! APT_UPDATED )); then
        log "apt-get update"
        as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq
        APT_UPDATED=1
    fi
    log "Installing: ${missing[*]}"
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${missing[@]}"
}

# --- 1. system packages -------------------------------------------------------

log "System packages"
apt_install build-essential pkg-config curl ca-certificates git \
    libpq-dev libsasl2-dev libxml2-dev libxslt1-dev libjpeg-dev zlib1g-dev \
    libffi-dev libssl-dev libmagic1
if pkg_installed libldap-dev || pkg_installed libldap2-dev; then :
elif pkg_available libldap-dev; then apt_install libldap-dev
else apt_install libldap2-dev; fi

# --- 2. Python virtualenv -------------------------------------------------------

python_ok() { "$1" -c 'import sys; sys.exit(not (3, 12) <= sys.version_info[:2] <= (3, 14))' 2>/dev/null; }
choose_python() {
    local c
    for c in ${PYTHON:-} python3.12 python3.13 python3.14 python3; do
        command -v "$c" >/dev/null 2>&1 && python_ok "$c" && { echo "$c"; return 0; }
    done
    return 1
}

py_version() { "$1" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null; }

log "Python"
if [[ -x "$PY" ]] && python_ok "$PY" && [[ -z "${PYTHON:-}" || "$(py_version "$PY")" == "$(py_version "$PYTHON")" ]]; then
    log "Reusing ${VENV_DIR#"$REPO_ROOT"/} ($("$PY" -V))"
else
    [[ ! -e "$VENV_DIR" || -f "$VENV_DIR/pyvenv.cfg" ]] || die "$VENV_DIR exists and is not a virtualenv; move it away."
    PYBIN="$(choose_python)" || { apt_install python3.12 python3.12-venv python3.12-dev; PYBIN=python3.12; }
    python_ok "$PYBIN" || die "Odoo 20.0 needs Python 3.12-3.14; $PYBIN is $("$PYBIN" -V 2>&1)."
    # Debian-packaged interpreters ship venv/ensurepip and the C headers separately.
    if [[ "$(command -v "$PYBIN")" == /usr/bin/* ]]; then
        pkgs=()
        "$PYBIN" -c 'import ensurepip, venv' 2>/dev/null || pkgs+=("${PYBIN##*/}-venv")
        "$PYBIN" -c 'import os, sysconfig, sys; sys.exit(not os.path.exists(os.path.join(sysconfig.get_paths()["include"], "Python.h")))' \
            || pkgs+=("${PYBIN##*/}-dev")
        (( ${#pkgs[@]} == 0 )) || apt_install "${pkgs[@]}"
    fi
    log "Creating ${VENV_DIR#"$REPO_ROOT"/} with $("$PYBIN" -V)"
    rm -rf "$VENV_DIR"
    "$PYBIN" -m venv "$VENV_DIR"
fi

stamp="$VENV_DIR/.scripts-dev-requirements"
wanted="$({ "$PY" -V; cat requirements.txt; printf '%s\n' "${EXTRA_PIP[@]}"; } | sha256sum | cut -d' ' -f1)"
if (( FORCE_PIP )) || [[ "$(cat "$stamp" 2>/dev/null)" != "$wanted" ]]; then
    log "Installing Python packages (requirements.txt + ${EXTRA_PIP[*]})"
    run_logged "$LOG_DIR/setup-pip.log" "$PY" -m pip install --disable-pip-version-check -q -r requirements.txt "${EXTRA_PIP[@]}"
    echo "$wanted" >"$stamp"
else
    log "Python packages already installed (requirements.txt unchanged; --force-pip to reinstall)"
fi
"$PY" -m pip check --disable-pip-version-check >/dev/null || warn "pip check reports conflicts: $("$PY" -m pip check 2>&1 | head -n 3)"
"$PY" -c 'import odoo, psycopg2, lxml, ldap, websocket, phonenumbers' \
    || die "The virtualenv is missing modules (see above); re-run with --force-pip."

# --- 3. headless Chrome / Chromium ---------------------------------------------

browser_ok() { [[ -n "$1" && -x "$1" ]] && "$1" --version 2>/dev/null | grep -qiE 'chrom'; }

find_browser() {
    local c
    for c in "$USER_BROWSER_BIN" "$(readlink -f "$VENV_DIR/bin/chromium" 2>/dev/null)"; do
        browser_ok "$c" && { echo "$c"; return 0; }
    done
    for c in google-chrome google-chrome-stable chromium chromium-browser; do
        c="$(command -v "$c" 2>/dev/null)" || continue
        # Ubuntu's chromium-browser is a stub that asks for the snap: browser_ok rejects it.
        browser_ok "$c" && { echo "$c"; return 0; }
    done
    # Playwright-managed Chromium (pre-installed in some CI/cloud images), newest first.
    local pw=()
    shopt -s nullglob
    pw=("${PLAYWRIGHT_BROWSERS_PATH:-/nonexistent}"/chromium-*/chrome-linux*/chrome
        "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome)
    shopt -u nullglob
    while read -r c; do
        browser_ok "$c" && { readlink -f "$c"; return 0; }
    done < <(echo "${PLAYWRIGHT_BROWSERS_PATH:-/nonexistent}/chromium"; printf '%s\n' "${pw[@]}" | sort -rV)
    return 1
}

log "Headless Chrome/Chromium"
if ! BROWSER="$(find_browser)"; then
    if [[ "${ID:-}" == debian ]]; then
        apt_install chromium
    elif [[ "$(dpkg --print-architecture)" == amd64 ]]; then
        # Ubuntu only packages Chromium as a snap, which does not run in containers.
        deb="$(mktemp -d)/google-chrome-stable_current_amd64.deb"
        log "Downloading Google Chrome (stable)"
        curl -fsSL -o "$deb" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
            || die "Could not download Google Chrome. Install Chrome/Chromium yourself and re-run with ODOO_BROWSER_BIN=/path/to/chrome."
        apt_install "$deb"
    fi
    BROWSER="$(find_browser)" || die "No working Chrome/Chromium. Install one and re-run with ODOO_BROWSER_BIN=/path/to/chrome."
fi
ln -sfn "$BROWSER" "$VENV_DIR/bin/chromium"
log "Using $("$BROWSER" --version) ($BROWSER), linked as ${VENV_DIR#"$REPO_ROOT"/}/bin/chromium"

# --- 4. PostgreSQL ---------------------------------------------------------------

log "PostgreSQL"
pg_server_version() {  # highest installed server major version, if any
    local bin ver best=''
    for bin in /usr/lib/postgresql/*/bin/postgres; do
        ver="${bin#/usr/lib/postgresql/}"; ver="${ver%%/*}"
        [[ -x "$bin" && "$ver" =~ ^[0-9]+$ ]] && (( ver > ${best:-0} )) && best="$ver"
    done
    echo "$best"
}
PG_VER="$(pg_server_version)"
if [[ -z "$PG_VER" ]]; then
    apt_install postgresql postgresql-client
    PG_VER="$(pg_server_version)"
fi
[[ -n "$PG_VER" ]] || die "PostgreSQL server installation failed."
(( PG_VER >= MIN_PG )) || die "PostgreSQL $PG_VER is too old for Odoo 20.0 (needs $MIN_PG+). Install it from apt.postgresql.org."
pkg_installed "postgresql-client-$PG_VER" || command -v psql >/dev/null || apt_install "postgresql-client-$PG_VER"
if [[ -z "$(pg_lsclusters --no-header 2>/dev/null | awk -v v="$PG_VER" '$1 == v')" ]]; then
    log "Creating PostgreSQL $PG_VER cluster 'main'"
    as_root pg_createcluster "$PG_VER" main --port="$PGPORT"
fi
ensure_postgres
if [[ "$(as_postgres psql -XAtq -p "$PGPORT" -c "SELECT 1 FROM pg_roles WHERE rolname = '$PGUSER'")" != 1 ]]; then
    log "Creating PostgreSQL role $PGUSER"
    as_postgres psql -XAtq -p "$PGPORT" -c "CREATE ROLE \"$PGUSER\" LOGIN CREATEDB PASSWORD '$PGPASSWORD'"
fi
psql_q postgres "SELECT 1" >/dev/null 2>&1 || {
    log "Resetting the password of PostgreSQL role $PGUSER"
    as_postgres psql -XAtq -p "$PGPORT" -c "ALTER ROLE \"$PGUSER\" LOGIN CREATEDB PASSWORD '$PGPASSWORD'"
}
psql_q postgres "SELECT 1" >/dev/null || die "Cannot connect to PostgreSQL as $PGUSER@$PGHOST:$PGPORT."
PG_SERVER="$(psql_q postgres "SHOW server_version")"
# (.venv/ and .odoo-data/ are ignored as dotfiles; lib.sh keeps logs/ out of git.)

printf '\n%sSetup complete%s\n' "$_c_green" "$_c_off"
printf '  Python:     %s (%s, %s packages)\n' "${VENV_DIR#"$REPO_ROOT"/}" "$("$PY" -V)" "$("$PY" -m pip list --disable-pip-version-check 2>/dev/null | tail -n +3 | wc -l)"
printf '  PostgreSQL: %s on %s:%s, role %s\n' "$PG_SERVER" "$PGHOST" "$PGPORT" "$PGUSER"
printf '  Browser:    %s (%s)\n' "$("$BROWSER" --version)" "$BROWSER"
printf 'Next: scripts/dev/start.sh\n'
