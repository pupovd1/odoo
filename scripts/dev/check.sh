#!/usr/bin/env bash
# Prove the acceptance checks that a script can prove.
#
# Usage: scripts/dev/check.sh scope   static checks of the change set; runs no tests (seconds)
#        scripts/dev/check.sh full    scope, rebuild-assets.sh, then the five test commands
#
# The change set is everything between eval/base and the working tree: commits
# on top of eval/base plus staged, unstaged and untracked changes (ignored
# files, such as .venv/ or logs/, do not count). The base is the merge base of
# HEAD and eval/base (origin/eval/base if there is no local branch);
# CHECK_BASE=<ref> compares with another ref.
#
# scope prints PASS or FAIL per check, with the paths that fail:
#   1. every changed path is under addons/crm/                  (acceptance check 2)
#   2. requirements.txt and every security/ path are unchanged   (acceptance check 3)
#   3. no new indexedDB, new IndexedDB, navigator.locks or
#      caches.open under addons/crm/                             (acceptance check 4)
#   4. no existing test file (tests/ directories, test_*.py,
#      *.test.js) changed, except addons/crm/tests/__init__.py   (acceptance check 11, files)
#   5. no .test.js file in the change set contains only( or
#      debug(                                                    (acceptance check 13, static)
# full runs scope, rebuild-assets.sh, test-py.sh, test-py.sh TestCrmOffline,
# test-js.sh desktop, test-js.sh mobile and test-guard.sh, and ends with a
# summary table (also written to logs/check-summary.txt). It fails if any step
# fails or runs zero tests. A TestCrmOffline class that does not exist yet is
# reported as "not yet created", which is not a pass. test-py.sh recreates
# crm_offline, and the test scripts stop a running dev server.

# shellcheck source=scripts/dev/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() { die "Usage: scripts/dev/check.sh scope|full"; }
case "${1:-}" in
    scope|full) (( $# == 1 )) || usage ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) usage ;;
esac

# --- scope -------------------------------------------------------------------

FAILED_CHECKS=0

pass_fail() {  # pass_fail NUMBER TITLE [FAILURE...]
    local number="$1" title="$2"; shift 2
    if (( $# == 0 )); then
        printf '%sPASS%s  %s. %s\n' "$_c_green" "$_c_off" "$number" "$title"
    else
        printf '%sFAIL%s  %s. %s\n' "$_c_red" "$_c_off" "$number" "$title"
        printf '        %s\n' "$@"
        FAILED_CHECKS=$((FAILED_CHECKS + 1))
    fi
}

count_matches() {  # count_matches ERE FILE -> matches in FILE (0 for a binary file)
    local n
    n="$(grep -IoE -- "$1" "$2" 2>/dev/null | wc -l)" || n=0
    echo "$n"
}

run_scope() {
    local started=$EPOCHREALTIME ref base path status line i now was
    ref="${CHECK_BASE:-eval/base}"
    if ! git rev-parse -q --verify "$ref^{commit}" >/dev/null; then
        git rev-parse -q --verify "origin/$ref^{commit}" >/dev/null \
            || die "Cannot find $ref or origin/$ref: run 'git fetch origin $ref' or set CHECK_BASE."
        ref="origin/$ref"
    fi
    base="$(git merge-base "$ref" HEAD)" || die "HEAD has no history in common with $ref."

    # path -> A added, M modified, D deleted, T type changed, ? untracked
    local -A change=()
    while IFS= read -r -d '' status && IFS= read -r -d '' path; do
        change["$path"]="${status:0:1}"
    done < <(git diff --name-status --no-renames -z "$base" --)
    while IFS= read -r -d '' path; do
        change["$path"]='?'
    done < <(git ls-files -z --others --exclude-standard)
    local paths=()
    if (( ${#change[@]} )); then
        mapfile -t paths < <(printf '%s\n' "${!change[@]}" | LC_ALL=C sort)
    fi

    printf 'Change set: %s (merge base %s) -> HEAD %s plus uncommitted and untracked changes\n' \
        "$ref" "$(git rev-parse --short "$base")" "$(git rev-parse --short HEAD)"
    printf '%d changed path(s)\n' "${#paths[@]}"
    for i in "${!paths[@]}"; do
        if (( i == 40 )); then printf '    ... and %d more\n' $(( ${#paths[@]} - 40 )); break; fi
        printf '    %s %s\n' "${change[${paths[$i]}]}" "${paths[$i]}"
    done
    echo

    local fails=()
    for path in "${paths[@]}"; do
        if [[ "$path" != addons/crm/* ]]; then fails+=("$path"); fi
    done
    pass_fail 1 "Every changed path is under addons/crm/ (acceptance check 2)" "${fails[@]}"

    local re_security='(^|/)security/'
    fails=()
    for path in "${paths[@]}"; do
        if [[ "$path" == requirements.txt || "$path" =~ $re_security ]]; then fails+=("$path"); fi
    done
    pass_fail 2 "requirements.txt and every security/ path are unchanged (acceptance check 3)" "${fails[@]}"

    local names=('indexedDB' 'new IndexedDB' 'navigator.locks' 'caches.open')
    local regexes=('indexedDB' 'new[[:space:]]+IndexedDB' 'navigator\??\.locks' 'caches\??\.open')
    local before
    before="$(mktemp)"
    fails=()
    for path in "${paths[@]}"; do
        [[ "$path" == addons/crm/* && -f "$path" ]] || continue
        if git cat-file -e "$base:$path" 2>/dev/null; then git show "$base:$path" >"$before"; else : >"$before"; fi
        for i in "${!regexes[@]}"; do
            now="$(count_matches "${regexes[$i]}" "$path")"
            was="$(count_matches "${regexes[$i]}" "$before")"
            if (( now > was )); then
                fails+=("$path: $((now - was)) new ${names[$i]}")
                while IFS= read -r line; do fails+=("  $line"); done \
                    < <(grep -nE -- "${regexes[$i]}" "$path" | head -n 3 | cut -c1-150)
            fi
        done
    done
    rm -f "$before"
    pass_fail 3 "No new indexedDB, new IndexedDB, navigator.locks or caches.open under addons/crm/ (acceptance check 4)" \
        "${fails[@]}"

    local re_tests='(^|/)tests/' re_test_py='(^|/)test_[^/]*\.py$'
    fails=()
    for path in "${paths[@]}"; do
        [[ "$path" =~ $re_tests || "$path" =~ $re_test_py || "$path" == *.test.js ]] || continue
        [[ "$path" != addons/crm/tests/__init__.py ]] || continue
        git cat-file -e "$base:$path" 2>/dev/null || continue  # new test files are allowed
        case "${change[$path]}" in
            D) fails+=("$path (deleted)") ;;
            '?') git show "$base:$path" | cmp -s - "$path" || fails+=("$path (differs from the base)") ;;
            *) fails+=("$path (modified)") ;;
        esac
    done
    pass_fail 4 "No existing test file changed, except addons/crm/tests/__init__.py (acceptance check 11, file part)" \
        "${fails[@]}"

    local hits
    fails=()
    for path in "${paths[@]}"; do
        [[ "$path" == *.test.js && -f "$path" ]] || continue
        mapfile -t hits < <(grep -nE '(^|[^[:alnum:]_$])(only|debug)\(' "$path" | cut -c1-150 || true)
        if (( ${#hits[@]} )); then
            fails+=("$path")
            for line in "${hits[@]}"; do fails+=("  $line"); done
        fi
    done
    pass_fail 5 "No .test.js file in the change set contains only( or debug( (acceptance check 13, static part)" \
        "${fails[@]}"

    local took
    took="$(awk -v a="$started" -v b="$EPOCHREALTIME" 'BEGIN { printf "%.1f", b - a }')"
    echo
    if (( FAILED_CHECKS )); then
        printf '%scheck.sh scope: FAILED%s (%d of 5 checks failed, %ss)\n' "$_c_red" "$_c_off" "$FAILED_CHECKS" "$took"
        return 1
    fi
    printf '%scheck.sh scope: PASSED%s (5 of 5 checks, %ss)\n' "$_c_green" "$_c_off" "$took"
}

# --- full --------------------------------------------------------------------

STEP_CMD=() STEP_RESULT=() STEP_TESTS=() STEP_TIME=() NOTES=()
FAILED_STEPS=0

# run_step KIND CMD...: run one step, show its output, and record its result.
# KIND: scope, assets, py (test count from "tests:"), js (also needs hoot's
# passed count), offline (like py, but "not yet created" without the class).
run_step() {
    local kind="$1"; shift
    local label="${*//"$REPO_ROOT"\//}" out rc=0 started=$EPOCHREALTIME ran js result tests
    out="$(mktemp)"
    printf '\n%s######## %s%s\n' "$_c_blue" "$label" "$_c_off"
    "$@" 2>&1 | tee "$out" || rc=$?
    ran="$(sed -nE 's/^  tests: +([0-9]+) run.*/\1/p' "$out" | tail -n 1)"
    js="$(sed -nE 's/^  hoot: +Passed ([0-9]+) tests.*/\1/p' "$out" | tail -n 1)"
    rm -f "$out"
    ran="${ran:-0}" js="${js:-0}" result=FAILED tests="${ran:-0}"
    case "$kind" in
        scope) tests='5 checks'; (( rc )) || result=PASSED ;;
        assets) tests='-'; (( rc )) || result=PASSED ;;
        py) (( rc || ran == 0 )) || result=PASSED ;;
        js) tests="$js JS"; (( rc || ran == 0 || js == 0 )) || result=PASSED ;;
        offline)
            if (( rc == 0 && ran > 0 )); then
                result=PASSED
            elif ! grep -rqE '^[[:space:]]*class[[:space:]]+TestCrmOffline\b' addons/crm/tests --include='*.py'; then
                result='not yet created'
            elif (( ran == 0 )); then
                NOTES+=("TestCrmOffline is defined but none of its tests ran: is its module imported in addons/crm/tests/__init__.py?")
            fi ;;
    esac
    [[ "$result" == PASSED ]] || FAILED_STEPS=$((FAILED_STEPS + 1))
    STEP_CMD+=("$label") STEP_RESULT+=("$result") STEP_TESTS+=("$tests")
    STEP_TIME+=("$(duration "$(awk -v a="$started" -v b="$EPOCHREALTIME" 'BEGIN { print b - a }')")")
}

run_full() {
    run_step scope "$DEV_DIR/check.sh" scope
    run_step assets "$DEV_DIR/rebuild-assets.sh"
    run_step py "$DEV_DIR/test-py.sh"
    run_step offline "$DEV_DIR/test-py.sh" TestCrmOffline
    run_step js "$DEV_DIR/test-js.sh" desktop
    run_step js "$DEV_DIR/test-js.sh" mobile
    run_step py "$DEV_DIR/test-guard.sh"

    local i note
    {
        printf '\n%-40s  %-16s  %-9s  %s\n' COMMAND RESULT TESTS TIME
        for i in "${!STEP_CMD[@]}"; do
            printf '%-40s  %-16s  %-9s  %s\n' "${STEP_CMD[$i]}" "${STEP_RESULT[$i]}" "${STEP_TESTS[$i]}" "${STEP_TIME[$i]}"
        done
        for note in "${NOTES[@]}"; do printf 'Note: %s\n' "$note"; done
        if (( FAILED_STEPS )); then
            printf 'check.sh full: FAILED (%d of %d steps did not pass)\n' "$FAILED_STEPS" "${#STEP_CMD[@]}"
        else
            printf 'check.sh full: PASSED (%d of %d steps)\n' "${#STEP_CMD[@]}" "${#STEP_CMD[@]}"
        fi
    } | tee "$LOG_DIR/check-summary.txt"
    (( FAILED_STEPS == 0 ))
}

if [[ "$1" == scope ]]; then run_scope; else run_full; fi
