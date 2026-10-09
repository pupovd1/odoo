#!/usr/bin/env bash
# PreToolUse hook for Edit and Write. On a run branch (eval/claude-code-*),
# allow the write only if the file, relative to the repository root, is under
# addons/crm/ or .eval/state/; otherwise block it (exit 2, reason on stderr).
# On any other branch: exit 0 and do nothing.
set -u

root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
branch="$(git -C "$root" symbolic-ref --short -q HEAD 2>/dev/null || true)"
[[ "$branch" == eval/claude-code-* ]] || exit 0

input="$(cat)"
field() {  # field PATH -> JSON value at PATH ("" if missing, null or false): jq, else python3
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
canon() { realpath -m -- "$1" 2>/dev/null || python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$1"; }

path="$(field tool_input.file_path)"
if [[ -z "$path" ]]; then
    echo "Blocked: the hook input has no tool_input.file_path." >&2
    exit 2
fi
if [[ "$path" != /* ]]; then cwd="$(field cwd)"; path="${cwd:-$root}/$path"; fi
real="$(canon "$path")"   # resolves .. and symlinks, so addons/crm/../web is caught
top="$(canon "$root")"
rel="${real#"$top"/}"     # stays absolute when the file is outside the repository

case "$rel" in
    addons/crm/*|.eval/state/*) exit 0 ;;
esac
echo "Blocked write to $rel. Only addons/crm/ may change. Extend other addons from inside addons/crm/ with _inherit, patch(), or XML inheritance." >&2
exit 2
