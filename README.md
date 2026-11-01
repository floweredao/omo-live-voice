<p align="center">
  <img src="assets/icon.svg" width="64" height="64" alt="omo-live-voice icon">
</p>

<h1 align="center">omo-live-voice</h1>

<p align="center">
  Talk to your open OmO coding-agent session by voice through OpenAI GPT-Live (<code>gpt-live-1</code>, voice <code>cedar</code>).
</p>

<p align="center">
  <a href="README.ko.md">한국어</a> · <a href="COMPAT.md">Compatibility</a> · <a href="LICENSE">MIT License</a>
</p>

## What it is

`omo-live-voice` adds real-time, full-duplex voice interaction to an open [OmO](https://omo.dev) desktop session without modifying the OmO application. You speak naturally in Korean, `gpt-live-1` (voice `cedar`) handles quick conversational turns directly, and coding or project requests are delegated into the active OmO session as regular user messages. When the agent finishes a turn, the bridge summarizes the reply for speech so `cedar` reads the answer aloud while code, file paths, and command output stay on screen.

## How it works

```text
+--------------------------+        WebSocket (127.0.0.1:47831)        +--------------------------+
|       Voice Panel        | <=======================================> |      Local Bridge        |
|  (Browser tab, WebAudio) |   24 kHz mono PCM16 + JSON envelopes      |     (bridge/main.ts)     |
+--------------------------+                                           +--------------------------+
                                                                            ^                ^
                                                  stdio JSON lines          |                | WSS (wss://api.openai.com/v1/live/sessions)
                                                  (utterances, state,       |                | 24 kHz PCM16, client delegation,
                                                   deltas, questions)       v                v commentary, usage
                                                                       +--------------------------+   +--------------------------+
                                                                       |      OmO Extension       |   |     OpenAI GPT-Live      |
                                                                       |   (extension/index.ts)   |   |  model: gpt-live-1       |
                                                                       |  /voice + voice_start    |   |  voice: cedar            |
                                                                       +--------------------------+   +--------------------------+
```

1. **OmO Extension (`extension/index.ts`)**: Registers the `/voice` slash command and the `voice_start` agent tool inside OmO. Starting voice mode spawns `bridge/main.ts`, acquires a single-session lock (`~/.omo-live-voice/active.json`), and opens the voice panel in a browser tab (the MCP App side panel did not render in OmO 2026.1030.1).
2. **Local Bridge (`bridge/main.ts`)**: Reads your OpenAI API key from the macOS login Keychain, opens a WebSocket session to `wss://api.openai.com/v1/live/sessions` with model `gpt-live-1` and voice `cedar`, and serves the local panel over `http://127.0.0.1:47831` authenticated with a per-launch random token and origin check.
3. **Client Delegation & Spoken Replies**: Greetings and small talk are answered immediately by `gpt-live-1`. Tasks that require reading files, running commands, or editing code trigger `session.delegation.created`. The bridge forwards your spoken words to the OmO session, plays a brief acknowledgment, and sends the agent's finished reply back via `session.commentary.append` (stripping code blocks, inline code, URLs, and file paths so only natural Korean summary sentences are spoken).
4. **Barge-in & Full Duplex**: Speaking for 400 ms or longer while the assistant is talking immediately flushes panel playback and interrupts the current utterance. Say `"그만"` or `"취소"` while the agent is working to abort the active turn.
5. **Agent Questions**: When the agent calls `ask_user_question`, the panel displays the question card and `cedar` reads the header, question, and numbered options aloud via commentary chunks. Because OmO extensions can observe question events but cannot submit answers back through an extension API, you select the answer on screen in OmO.

## Requirements

- **macOS 15+** on Apple silicon (tested on macOS 27.2).
- **OmO desktop >= 2026.1030.1** with bundled runtime **senpi 2026.10.27-1**.
- **Bun >= 1.4** (tested on Bun 1.4.4).
- **OpenAI platform API key** with active billing and access to `gpt-live-1`.
- **Korean `Yuna` system voice** (required only when regenerating QA audio fixtures with `scripts/qa/make-fixtures.sh` or running `OLV_DOCTOR_QA=1 scripts/doctor.sh`).

## Install

Clone the repository, store your OpenAI API key in the macOS Keychain, and run the installer. Built panel assets are not committed to git, so `scripts/install.sh` installs dependencies, builds `panel/dist/`, and registers the extension with OmO in place.

```sh
git clone https://github.com/floweredao/omo-live-voice.git
cd omo-live-voice

# 1. Save your OpenAI API key in the macOS login Keychain (service: openai-live-api-key)
scripts/set-key.sh
# Or pipe from clipboard without echoing to the terminal:
# pbpaste | scripts/set-key.sh

# 2. Install dependencies, build panel/dist, and register the extension with OmO
scripts/install.sh

# 3. Verify your local setup and compatibility baseline
scripts/doctor.sh
```

After installation, open a **new** OmO session and type `/voice`. (In the OmO composer, the first `Enter` after typing `/voice` accepts the slash-command autocomplete; press `Enter` a second time to submit.)

## Usage

### Slash commands and agent tool

| Command / Tool | What it does |
| --- | --- |
| `/voice` | Starts voice mode for the current session (or resumes if paused by a guard) and opens the voice panel in your browser. |
| `/voice tab` | Explicitly opens or reopens the voice panel in a browser tab. |
| `/voice confirm on` | Holds each recognized request as a draft in the panel so you can confirm before sending it to the agent. |
| `/voice confirm off` | Sends recognized requests to the agent immediately (default). |
| `/voice stop` | Stops the voice session, closes the GPT-Live connection, terminates the local bridge process, and releases the session lock. |
| `voice_start` (tool) | Agent tool that starts voice mode for the current session, equivalent to running `/voice`. |

Only one OmO session can hold an active voice bridge at a time. Starting `/voice` in a second session warns you which session owns the lock and asks you to run `/voice stop` there first.

### Voice panel controls and shortcuts

When the browser panel opens, click anywhere on the page or press any key once to unlock browser audio capture, and allow microphone access when prompted.

- **Mute / Unmute (`음소거` / `음소거 해제`)**: Click the button, or press `Space` or `M` (`ㅁ`), to mute or unmute your microphone.
- **Stop (`중지`)**: Click `중지` or press `Escape` (confirms first) to end the voice session and shut down the bridge, just like `/voice stop`.
- **Resume (`재개`)**: Reopens the GPT-Live connection after an idle or session-cap pause while keeping cumulative time and cost visible.
- **Confirm / Discard Draft (`보내기` / `취소`)**: When `/voice confirm on` is active, press `Enter`, click `보내기`, or say `"보내"` / `"전송"` to send the held draft; click `취소` or say `"취소"` / `"지워"` to discard it.
- **Reconnect (`다시 연결`)**: Performs a one-shot WebSocket reconnect to the local bridge if the socket drops.
- **Device Selectors (`마이크` / `스피커`)**: Switch input microphone and output speaker devices live; selections persist across reloads by device label.

## Cost guard

GPT-Live (`gpt-live-1`) bills by connected session time at approximately **$0.05 per connected minute**. To prevent runaway spend from an open tab, the bridge enforces automatic guards:

- **Live cost ticker**: The top-right badge in the panel updates every second with cumulative connected time and estimated cost (`MM:SS · 예상 $X.XX`).
- **3-minute idle auto-close**: After 3 minutes (`180,000 ms`) with neither user speech nor agent work, the bridge closes the GPT-Live WebSocket to stop per-minute billing. Click `재개` in the panel or run `/voice` to reconnect when you are ready to talk again.
- **55-minute warning & 60-minute cap**: The panel warns at 55 minutes of cumulative connected time and closes the GPT-Live connection at 60 minutes. Resuming from the user side starts a fresh budget window.
- **Single auto-reconnect on drop**: If the upstream WebSocket drops while you are actively talking or the agent is working, the bridge reconnects once with the last 10 transcript lines as context; if it drops after 30 seconds of silence or fails a second time, it stays closed until you resume.

## Privacy and data storage

- **API key in Keychain only**: `scripts/set-key.sh` stores your key in the macOS login Keychain under the service name `openai-live-api-key`. `bridge/main.ts` reads it directly via `/usr/bin/security`. The key is never passed to the browser panel or written to disk, and all bridge logs pass through automatic secret redaction (`sk-...`, `Bearer ...`, and URL `?token=...` values are masked as `[redacted]`).
- **Local runtime directory (`~/.omo-live-voice/`)**: Created with mode `0700`.
  - `~/.omo-live-voice/transcripts/<ISO-timestamp>.md`: Markdown conversation transcripts created lazily only when speech occurs.
  - `~/.omo-live-voice/logs/<ISO-timestamp>.log`: Redacted JSONL bridge logs (the newest 20 files are retained) and `ext-<ISO-timestamp>.log` extension logs.
  - `~/.omo-live-voice/settings.json`: Persisted microphone and speaker device labels.
  - `~/.omo-live-voice/active.json`: Ephemeral lock file holding the active session ID and bridge PID while voice mode is running.

## Known limitations

- **Answer agent questions on screen**: When the agent asks a multiple-choice question (`ask_user_question`), `cedar` reads the question and options aloud and the panel displays them, but you must click your choice in the OmO window. OmO extensions cannot programmatically submit answers to `ask_user_question`.
- **Occasional question-sentence phrasing variance**: While numbered option labels are read in order, `gpt-live-1` occasionally paraphrases a verb in the question sentence itself (for example saying `"어떤 순서로 할까요?"` instead of `"어떤 순서로 진행할까요?"`). Read the question card on screen when exact wording matters.
- **Inline code stripped for speech**: To avoid reading raw syntax aloud, the speech adapter removes inline code spans before sending text to `commentary.append`, which can occasionally leave a trailing Korean particle attached to an empty span in the spoken summary.
- **Browser-tab panel host**: Because the MCP App side panel surface did not render in OmO 2026.1030.1, `/voice` opens the voice panel in your default browser tab.

## QA and verification commands

```sh
# Run the full unit and end-to-end test suite (fake GPT-Live server, zero API spend)
env -u SENPI_RPC_INTERNAL_KEY_STDIN bun test

# Run TypeScript typechecking
bun run typecheck

# Rebuild panel assets into panel/dist/
bun run build:panel

# Test the installer and uninstaller in an isolated temporary directory
bash scripts/smoke-install.sh

# Run a gated real GPT-Live smoke test (~$0.05/min; requires Keychain key and checks budget ledger)
OLV_LIVE_E2E=1 bun scripts/qa/real-live-smoke.ts
```

## Troubleshooting

- **Microphone permission denied (`마이크 권한이 거부되었어요`)**: Allow microphone access for `127.0.0.1` in your browser's site settings, and verify that your browser is enabled under **System Settings > Privacy & Security > Microphone** in macOS. Also make sure you click once inside the panel tab so the browser unlocks `AudioContext`.
- **`cedar` voice rejected (`GPT-Live가 cedar 보이스를 거절했어요`)**: `omo-live-voice` uses the `cedar` voice exclusively. Verify that your OpenAI API key belongs to an organization and project with access to `gpt-live-1` and the `cedar` voice, and that billing credits are active.
- **Side panel does not open in OmO**: OmO 2026.1030.1 does not render the MCP App side panel, so the extension opens the panel in a browser tab automatically. If you closed the tab or the browser blocked it, run `/voice tab` in the OmO session to reopen it.
- **Another session holds the lock (`이미 다른 세션에 연결됨`)**: Run `/voice stop` in the other OmO session, or click `중지` inside its open voice panel. If the previous bridge process already exited, running `/voice` automatically reclaims the stale `~/.omo-live-voice/active.json` lock.
- **`Yuna` voice missing when building QA fixtures**: `scripts/qa/make-fixtures.sh` uses the macOS Korean voice `Yuna` to synthesize test WAV files. Install it in **System Settings > Accessibility > Spoken Content > System Voice > Manage Voices > Korean > Yuna**, then re-run `bun run fixtures`. Normal `/voice` usage does not require `Yuna`.

## Uninstall

```sh
scripts/uninstall.sh
```

`scripts/uninstall.sh` unregisters the extension from OmO and removes `~/.omo-live-voice/active.json`. Your saved transcripts and settings in `~/.omo-live-voice/` and your API key in the Keychain are kept; delete them manually with `rm -rf ~/.omo-live-voice` and `security delete-generic-password -s openai-live-api-key` if you want a complete wipe.

## Compatibility

See [COMPAT.md](COMPAT.md) for the tested version matrix (OmO `2026.1030.1`, senpi runtime `2026.10.27-1`, Bun `1.4.4`, macOS `27.2`). Run `scripts/doctor.sh` at any time to check your local runtime, Bun version, extension registration, built panel assets, Keychain entry, and port `47831` availability.

## License

[MIT](LICENSE).
