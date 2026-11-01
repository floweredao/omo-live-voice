#!/usr/bin/env bash
set -u

R="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="${SENPI_CODING_AGENT_DIR:-$HOME/.omo/agent}"
OMO_APP=/Applications/OmO.app/Contents/Resources/omo-runtime/darwin-arm64/omo
OMO="${OMO_APP}"
if [ ! -x "$OMO" ]; then OMO="$(command -v omo || true)"; fi
COMPAT="$R/COMPAT.md"
failed=0

check() {
  local name="$1"; shift
  if "$@"; then printf 'PASS %s\n' "$name"; else printf 'FAIL %s\n' "$name"; failed=1; fi
}

printf '%s\n' 'Compatibility baseline:'
awk '/^\| (OmO|senpi runtime|Bun|macOS) \|/ { print }' "$COMPAT"

runtime_ok() {
  local version
  version="$("$OMO" --version 2>&1)" || return 1
  printf '%s\n' "$version"
  if [[ "$version" == *"senpi 2026.10.27-1"* ]]; then return 0; fi
  echo "WARN untested runtime"
  return 0
}
bun_ok() {
  local version major minor
  version="$(bun --version 2>/dev/null)" || return 1
  printf 'Bun %s\n' "$version"
  major="${version%%.*}"; minor="${version#*.}"; minor="${minor%%.*}"
  (( major > 1 || (major == 1 && minor >= 4) ))
}
extension_ok() {
  export SENPI_CODING_AGENT_DIR="$AGENT_DIR"
  if env -u SENPI_RPC_INTERNAL_KEY_STDIN "$OMO" list 2>/dev/null | grep -q 'omo-live-voice'; then return 0; fi
  [ -L "$AGENT_DIR/extensions/omo-live-voice" ]
}
KEYCHAIN_SERVICE="${OLV_KEYCHAIN_SERVICE:-openai-live-api-key}"
keychain_ok() { security find-generic-password -s "$KEYCHAIN_SERVICE" >/dev/null 2>&1; }
panel_ok() {
  if [ -f "$R/panel/dist/index.html" ]; then return 0; fi
  echo "Hint: run bun run build:panel or scripts/install.sh"
  return 1
}
port_ok() { ! lsof -nP -iTCP:47831 -sTCP:LISTEN >/dev/null 2>&1; }

check 'OmO runtime' runtime_ok
check 'Bun >= 1.4' bun_ok
check 'extension installed' extension_ok
check 'panel build exists' panel_ok
check "Keychain service $KEYCHAIN_SERVICE" keychain_ok
check 'port 47831 free' port_ok

if [[ "${OLV_DOCTOR_QA:-0}" == 1 ]]; then
  check 'QA speech voice Yuna available' bash -c "say -v '?' | grep -q Yuna"
fi
if [[ "${OLV_PANEL_HOST:-browser-tab}" == mcp-app ]]; then
  check 'mcp.json entry' bash -c 'test -f "$1/mcp.json" && grep -q omo_live_voice "$1/mcp.json"' _ "$AGENT_DIR"
fi

exit "$failed"
