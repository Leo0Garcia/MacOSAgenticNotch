#!/bin/sh
# Stand-in for the claude binary. Records argv and stdin, replies with a canned result.
# STUB_DIR: where to record. STUB_RESPONSE: file to print for -p runs. STUB_EXIT: exit code.
if [ "$1" = "agents" ]; then echo '[]'; exit 0; fi
dir="${STUB_DIR:?}"
: > "$dir/argv"
for a in "$@"; do printf '%s\n' "$a" >> "$dir/argv"; done
cat > "$dir/stdin"
env > "$dir/env"
pwd > "$dir/cwd"
if [ -n "$STUB_RESPONSE" ]; then cat "$STUB_RESPONSE"; fi
exit "${STUB_EXIT:-0}"
