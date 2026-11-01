#!/bin/bash
# Fake voice bridge for extension tests (stands in for `bun bridge/main.ts`).
# Env: FAKE_BRIDGE_LOG    file that gets "spawned <pid>" and "recv <line>" for every stdin line
#      FAKE_BRIDGE_SCRIPT file whose lines are printed verbatim right after the first ready
#      FAKE_BRIDGE_IGNORE_STOP=1  do not exit on {"type":"stop"} (exercises the SIGTERM fallback)
log() { [ -n "$FAKE_BRIDGE_LOG" ] && printf '%s\n' "$1" >> "$FAKE_BRIDGE_LOG"; }
ready='{"type":"ready","port":1,"token":"fake-token","panelUrl":"http://127.0.0.1:1/?token=fake-token"}'
log "spawned $$"
while IFS= read -r line; do
  log "recv $line"
  case "$line" in
    *'"type":"hello"'*)
      printf '%s\n' "$ready"
      printf '%s\n' '{"type":"state","connection":"connecting","input":"quiet","agent":"idle","output":"idle","muted":false}'
      [ -n "$FAKE_BRIDGE_SCRIPT" ] && [ -f "$FAKE_BRIDGE_SCRIPT" ] && cat "$FAKE_BRIDGE_SCRIPT"
      ;;
    *'"type":"resume"'*)
      printf '%s\n' "$ready"
      ;;
    *'"type":"stop"'*)
      if [ "$FAKE_BRIDGE_IGNORE_STOP" != "1" ]; then
        printf '%s\n' '{"type":"exit","reason":"stop"}'
        log "exit stop"
        exit 0
      fi
      ;;
  esac
done
log "exit eof"
