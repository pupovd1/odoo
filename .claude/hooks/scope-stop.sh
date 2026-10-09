#!/usr/bin/env bash
# Stop hook. On a run branch (eval/claude-code-*), run scripts/dev/check.sh
# scope; if it fails, exit 2 with the failing checks on stderr, so the session
# fixes them before it stops. When stop_hook_active is true (the session is
# already continuing because of this hook), exit 0 so it cannot loop.
# On any other branch: exit 0 and do nothing.
set -u

root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
input="$(cat)"
field() {  # same helper as in scope-guard.sh
    if command -v jq >/dev/null 2>&1; then
        printf '%s' "$input" | jq -r ".$1 // empty" 2>/dev/null
    else
        printf '%s' "$input" | python3 -c '
import json, sys
value = json.load(sys.stdin)
for key in sys.argv[1].split("."):
    value = value.get(key) if isinstance(value, dict) else None
if value is not None and value is not False:
    print(value if isinstance(value, str) else json.dumps(value))' "$1" 2>/dev/null
    fi
}

[[ "$(field stop_hook_active)" == true ]] && exit 0
branch="$(git -C "$root" symbolic-ref --short -q HEAD 2>/dev/null || true)"
[[ "$branch" == eval/claude-code-* ]] || exit 0

output="$("$root/scripts/dev/check.sh" scope 2>&1)" && exit 0
failing="$(printf '%s\n' "$output" | awk '
    /^FAIL/ { show = 1; print; next }
    /^PASS/ || /^$/ { show = 0; next }
    show || /^(ERROR:|check\.sh scope:)/ { print }')"
{
    echo "scripts/dev/check.sh scope failed. Fix these before stopping:"
    printf '%s\n' "${failing:-$output}"
} >&2
exit 2
