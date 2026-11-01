#!/usr/bin/env bash
# Reverses install.sh steps 2-3 and removes active.json (keeps transcripts/settings).
set -eu

R="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="${SENPI_CODING_AGENT_DIR:-$HOME/.omo/agent}"
MODE="${OLV_INSTALL_MODE:-omo-install}"
PANEL_HOST="${OLV_PANEL_HOST:-browser-tab}"
OLV_DIR="${OLV_HOME:-$HOME/.omo-live-voice}"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
OMO_APP=/Applications/OmO.app/Contents/Resources/omo-runtime/darwin-arm64/omo
if [ -x "$OMO_APP" ]; then OMO="$OMO_APP"; else OMO="$(command -v omo)"; fi
export SENPI_CODING_AGENT_DIR="$AGENT_DIR"

case "$MODE" in
  omo-install) "$OMO" remove "$R/extension" || true ;;
  symlink) rm -f "$AGENT_DIR/extensions/omo-live-voice" ;;
  *) echo "unknown OLV_INSTALL_MODE: $MODE" >&2; exit 1 ;;
esac

if [ "$PANEL_HOST" = "mcp-app" ] && [ -f "$AGENT_DIR/mcp.json" ]; then
  "$BUN" "$R/scripts/mcp-json.ts" remove "$AGENT_DIR/mcp.json"
fi

rm -f "$OLV_DIR/active.json"
echo "uninstalled: AGENT_DIR=$AGENT_DIR MODE=$MODE PANEL_HOST=$PANEL_HOST"
