#!/bin/sh
# Stores the API key in the login Keychain without echoing it.
# Usage: scripts/set-key.sh (hidden Keychain prompt)
#        pbpaste | scripts/set-key.sh (stdin)
set -eu
SERVICE="${OLV_KEYCHAIN_SERVICE:-openai-live-api-key}"
if [ -t 0 ]; then
  security add-generic-password -U -a "$USER" -s "$SERVICE" -w
else
  IFS= read -r KEY || true
  case "$KEY" in
    sk-*) ;;
    *) echo "not an OpenAI key (expected API-key prefix); nothing stored" >&2; exit 2 ;;
  esac
  security add-generic-password -U -a "$USER" -s "$SERVICE" -w "$KEY"
  unset KEY
fi
echo "stored in Keychain service $SERVICE" >&2
