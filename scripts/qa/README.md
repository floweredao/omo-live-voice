# scripts/qa

QA helpers. Nothing here touches the real network; every listening port is random (`port: 0`) and printed.

| File | Purpose |
| --- | --- |
| `make-fixtures.sh`, `make-silence.ts` | build the 24 kHz mono PCM16 WAVs in `fixtures/` |
| `fake-live-server.ts` | fake GPT-Live WebSocket server |
| `fake-ext-host.ts` | fake senpi extension host that spawns `bridge/main.ts` |
| `fake-panel.ts` | fake browser panel that talks to the bridge WebSocket |

## fake-live-server.ts

`bun scripts/qa/fake-live-server.ts` prints `{"port":N,"url":"ws://127.0.0.1:N"}` on line 1 and serves until SIGTERM.
`--self-test` starts itself, runs a scripted exchange, asserts the event order and exits 0 (`OLV_FAKE_REJECT_VOICE=1 --self-test` checks the rejection path instead).

- `session.start` -> `session.started` with `session.id = "fake-1"` and the requested voice echoed (`error` with `error.code = "invalid_value"` when `OLV_FAKE_REJECT_VOICE=1`).
- Input audio (`session.input_audio.append`, base64 PCM16 24 kHz) is cut into speech bursts on the audio clock: a burst starts at the first 100 ms frame with any `|v| > 500` and ends after 800 ms of silent frames. Burst k emits `session.input_transcript.delta` fragments spelling entry k of `OLV_FAKE_TRANSCRIPTS` (last entry reused), then `session.delegation.created` with `delegation.id = "d<k>"` and `offset_ms` = burst end.
- `session.instructions.append` / `session.commentary.append`: one `session.output_transcript.delta` with the content verbatim, then a 440 Hz tone as 100 ms `session.output_audio.delta` frames (`delta` = base64), then silent frames. The `.appended` ack comes first by default; `OLV_FAKE_ACK_AFTER_AUDIO=1` sends it 300 ms after the first output.
- `session.thinking.append` -> `.appended`; `session.input_audio.mute` -> `.muted`; both echo `client_event_id`. `session.usage.updated` every second; `session.close` -> `session.closed {reason, usage:{seconds}}`.

| Env | Default | Meaning |
| --- | --- | --- |
| `OLV_FAKE_TRANSCRIPTS` | `["현재 폴더의 파일 목록을 보여줘"]` | JSON array, one entry per speech burst |
| `OLV_FAKE_REJECT_VOICE` | off | `1` answers `session.start` with `error invalid_value` |
| `OLV_FAKE_ACK_AFTER_AUDIO` | off | `1` sends audio/transcript 300 ms before `.appended` |
| `OLV_FAKE_MUTE_OUTPUT` | off | `1` acks appends but never emits output audio/transcript |
| `OLV_FAKE_OUTPUT_MS` | 2000 | tone duration per spoken append |
| `OLV_FAKE_TRAILING_SILENCE_MS` | 3000 | silent output frames after each tone |
| `OLV_FAKE_LOG` | none | JSONL of every inbound message (audio replaced by `_audio_bytes`) |

## fake-ext-host.ts

`bun scripts/qa/fake-ext-host.ts --env KEY=VAL ... [--script file]` spawns `bun bridge/main.ts` with that env, sends `hello`, and prints the bridge's `ready` JSON as stdout line 1. Later lines: `recv <json>` (utterance/state/log/exit) and `sent <json>` (everything forwarded to the bridge).

Script lines are `+<ms> <kind> <arg>` with ms measured from ready, e.g. `+500 agent.tool.start bash`, `+3000 agent.end "파일은 세 개예요."`, or raw JSON `+100 {"type":"agent.idle","idle":true}`.
Stdin control, one per line: `emit <ExtToBridge JSON>` forwards immediately (hold the agent in `working`, then emit `agent.end` once you saw the event you wait for); `quit` sends `stop`, waits, exits.
`--bridge <main.ts>` swaps the child (used to test the fake itself).

## fake-panel.ts

`bun scripts/qa/fake-panel.ts --url ws://127.0.0.1:PORT/... --token T --wav fixtures/ko-list-files.wav --out /tmp/panel.json` connects with the token and an Origin header, sends `hello`, streams the WAV as 2,400-sample binary frames (`--pace 1.0` = real time), then a silent tail so the last burst can end. It records every envelope, counts received PCM bytes, answers `flush` with `playback {flushAck}` immediately, and writes a JSON summary. `--mute-at <ms>` sends `control mute`; `--inject-at <ms> <wav>` mixes a second WAV into the mic stream; `--expect-reject` exits 0 only when the connection is refused.
The mic frames use generation 0.
