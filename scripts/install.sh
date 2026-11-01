#!/usr/bin/env bash
# Idempotent installer for omo-live-voice (extension via `omo install`, optional MCP App entry).
set -eu

R="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="${SENPI_CODING_AGENT_DIR:-$HOME/.omo/agent}"
MODE="${OLV_INSTALL_MODE:-omo-install}"          # decisions.extInstall
PANEL_HOST="${OLV_PANEL_HOST:-browser-tab}"      # decisions.panelHost
OLV_DIR="${OLV_HOME:-$HOME/.omo-live-voice}"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
OMO_APP=/Applications/OmO.app/Contents/Resources/omo-runtime/darwin-arm64/omo
if [ -x "$OMO_APP" ]; then OMO="$OMO_APP"; else OMO="$(command -v omo)"; fi
export SENPI_CODING_AGENT_DIR="$AGENT_DIR"

echo "[0] build artifacts"
(cd "$R" && "$BUN" install && "$BUN" run build:panel)
if [ "$PANEL_HOST" = "mcp-app" ]; then (cd "$R" && "$BUN" run build:mcp-app); fi
[ -f "$R/panel/dist/index.html" ] || { echo "FATAL: $R/panel/dist/index.html missing after build" >&2; exit 1; }

echo "[1] extension deps"
(cd "$R/extension" && "$BUN" install --production)

echo "[2] register extension ($MODE)"
case "$MODE" in
  omo-install) "$OMO" install "$R/extension" ;;
  symlink) mkdir -p "$AGENT_DIR/extensions" && ln -sfn "$R/extension" "$AGENT_DIR/extensions/omo-live-voice" ;;
  *) echo "unknown OLV_INSTALL_MODE: $MODE" >&2; exit 1 ;;
esac

if [ "$PANEL_HOST" = "mcp-app" ]; then
  echo "[3] mcp.json"
  mkdir -p "$AGENT_DIR"
  MCP="$AGENT_DIR/mcp.json"
  BAK="$MCP.bak-omo-live-voice-$(date +%Y%m%d)"
  [ -f "$MCP" ] || echo '{"mcpServers":{}}' > "$MCP"
  [ -f "$BAK" ] || cp "$MCP" "$BAK"
  "$BUN" "$R/scripts/mcp-json.ts" add "$MCP" "$BUN" "$R/mcp-app/server.ts"
else
  echo "[3] mcp.json skipped (panelHost=$PANEL_HOST)"
fi

echo "[4] data dir"
mkdir -p "$OLV_DIR" && chmod 700 "$OLV_DIR"

echo "done: AGENT_DIR=$AGENT_DIR MODE=$MODE PANEL_HOST=$PANEL_HOST extension=$R/extension data=$OLV_DIR"
