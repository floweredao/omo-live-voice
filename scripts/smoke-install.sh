#!/usr/bin/env bash
set -euo pipefail

R="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:---worktree-copy}"
case "$MODE" in
  --worktree-copy|--fresh-clone) ;;
  *) echo "usage: $0 [--worktree-copy|--fresh-clone]" >&2; exit 2 ;;
esac
if [[ "$MODE" == --fresh-clone ]]; then
  TEMP_ROOT="$(mktemp -d)"
  CLONE="$TEMP_ROOT/clone"
  git -C "$R" clone -q "$R" "$CLONE"
else
  TEMP_ROOT="$(mktemp -d)"
  CLONE="$TEMP_ROOT/clone"
  mkdir -p "$CLONE"
  git -C "$R" ls-files -co --exclude-standard | rsync -a --files-from=- "$R/" "$CLONE/"
fi

TEMP_ROOT="${TEMP_ROOT:-$(dirname "$CLONE")}"
AGENT_DIR="$TEMP_ROOT/agent"
OLV_DIR="$TEMP_ROOT/olv"
mkdir -p "$AGENT_DIR" "$OLV_DIR"
REAL_AGENT_DIR="$HOME/.omo/agent"
hash_file() { if [[ -f "$1" ]]; then shasum -a 256 "$1" | awk '{print $1}'; else printf absent; fi; }
SETTINGS_BEFORE="$(hash_file "$REAL_AGENT_DIR/settings.json")"
MCP_BEFORE="$(hash_file "$REAL_AGENT_DIR/mcp.json")"
BRIDGE_PID=""
cleanup() {
  if [[ -n "$BRIDGE_PID" ]]; then kill "$BRIDGE_PID" 2>/dev/null || true; wait "$BRIDGE_PID" 2>/dev/null || true; fi
  exec 3>&- 3<&- || true
  rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT

export SENPI_CODING_AGENT_DIR="$AGENT_DIR"
export OMO_CODING_AGENT_DIR="$AGENT_DIR"
export OLV_HOME="$OLV_DIR"
export OLV_INSTALL_MODE=symlink
PORT="${OLV_PORT:-47831}"
export OLV_PORT="$PORT"
export OLV_LIVE_URL=ws://127.0.0.1:1
(cd "$CLONE" && bash scripts/install.sh) >"$TEMP_ROOT/install.log" 2>&1 || { cat "$TEMP_ROOT/install.log"; exit 1; }
[[ -f "$CLONE/panel/dist/index.html" ]]
[[ -L "$AGENT_DIR/extensions/omo-live-voice" ]]
if [[ "${OLV_PANEL_HOST:-browser-tab}" == mcp-app ]]; then
  grep -q omo_live_voice "$AGENT_DIR/mcp.json"
fi
mkfifo "$TEMP_ROOT/bridge.stdin"
exec 3<>"$TEMP_ROOT/bridge.stdin"
bun "$CLONE/bridge/main.ts" --standalone <&3 >"$TEMP_ROOT/bridge.log" 2>&1 &
BRIDGE_PID=$!
HTTP_CODE="$(curl --retry 50 --retry-connrefused --retry-delay 0 --retry-max-time 10 -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)"
if [[ "$HTTP_CODE" != 200 ]]; then cat "$TEMP_ROOT/bridge.log"; exit 1; fi
kill "$BRIDGE_PID"
wait "$BRIDGE_PID" 2>/dev/null || true
BRIDGE_PID=""

(cd "$CLONE" && bash scripts/uninstall.sh) >"$TEMP_ROOT/uninstall.log" 2>&1 || { cat "$TEMP_ROOT/uninstall.log"; exit 1; }
[[ ! -e "$AGENT_DIR/extensions/omo-live-voice" ]]
if [[ -f "$AGENT_DIR/mcp.json" ]]; then ! grep -q omo_live_voice "$AGENT_DIR/mcp.json"; fi
[[ "$SETTINGS_BEFORE" == "$(hash_file "$REAL_AGENT_DIR/settings.json")" ]]
[[ "$MCP_BEFORE" == "$(hash_file "$REAL_AGENT_DIR/mcp.json")" ]]
echo "real agent dir unchanged"
