#!/bin/sh
# Entry point for the notch app, launchd and the terminal.
#   run.sh run "what's the weather in Southampton"
#   run.sh remind add --when "in 20 minutes" --text "check the oven"
# Apps started from Finder or launchd get a minimal PATH, so add the usual
# homes of bun and claude before handing over to the TypeScript CLI.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
JARVIS_REPO="${JARVIS_REPO:-$(cd "$here/.." && pwd)}"
export JARVIS_REPO
for d in "$HOME/.bun/bin" "$HOME/.local/bin" "$HOME/.claude/local" /opt/homebrew/bin /usr/local/bin; do
  case ":$PATH:" in
    *":$d:"*) ;;
    *) [ -d "$d" ] && PATH="$PATH:$d" ;;
  esac
done
export PATH
exec bun "$JARVIS_REPO/launcher/src/cli.ts" "$@"
