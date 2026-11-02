// Composition root. Owns the only real timer (a 100 ms ticker); every other deadline is a
// Timers entry (or Guard scheduled through Timers), so OLV_FAKE_CLOCK=1 can drive time in QA.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
  BridgeToExt,
  ConfirmMode,
  DevicesMsg,
  ExtToBridge,
  PlaybackMsg,
  StateMsg,
} from "../shared/protocol.ts";
import { MAX_FRAME_SAMPLES } from "../shared/protocol.ts";
import { classifyUtterance, initialAdapterState, isStandaloneCancel, reduceAgent, type AdapterState, type LiveCommand } from "./adapter.ts";
import { base64ToPcm, InputPacer, isVoiced, transcriptWindow, VoiceActivity } from "./audio.ts";
import { CAP_MS, COMMENTARY_CAP_CHARS, IDLE_MS, KEYCHAIN_SERVICE, LIVE_VOICE, SETTLE_MS, WARN_MS } from "./config.ts";
import { readExt, sendExt } from "./ext-link.ts";
import { Guard } from "./guard.ts";
import { readApiKey } from "./keychain.ts";
import { LiveSession, type HistoryLine, type LiveEvent } from "./live.ts";
import { LogFile, redact } from "./logfile.ts";
import { createToken, startServer, type PanelConn, type PanelServer } from "./server.ts";
import { INITIAL_STATE, transition, type Axes, type Effect, type Event } from "./state.ts";
import { Timers } from "./timers.ts";
import { TranscriptLog } from "./transcript.ts";

const TICK_MS = 100;
const OUTPUT_RMS = 300;
const MIC_RMS = 500;
const OUTPUT_END_MS = 600;
// Live has no response-end event: question chunks require BOTH streams to be quiet.
const QUESTION_QUIESCENCE_MS = 600;
const TRAILING_SILENCE_MS = 600;
const SPEECH_END_MS = 600;
const DRAIN_FALLBACK_MS = 300;
const QUESTION_CHUNK_TIMEOUT_MS = 15_000;
const QUESTION_START_MS = 4_000;
const GRACEFUL_CLOSE_MS = 15_000;
const EOF_CLOSE_MS = 2_000;
const ACTIVE_WINDOW_MS = 30_000;
const HISTORY_LINES = 10;
const COST_TICK_MS = 1_000;
const CUT_PAD_MS = 500;
// Speech followed by this much silence before the delegated request was a separate turn that
// GPT-Live handled without delegating (a backchannel, a repeat); it is not forwarded (#10).
const UTTERANCE_GAP_MS = 1500;
const SEND_WORDS = /^(보내|보내줘|전송|send)$/i;
const ANSWER_ON_SCREEN = "화면에서 답해 주세요";

const DATA_DIR = process.env.OLV_DATA_DIR ?? join(homedir(), ".omo-live-voice");
const SETTINGS_FILE = join(DATA_DIR, "settings.json");
const PANEL_DIR = process.env.OLV_PANEL_DIR ?? resolve(import.meta.dir, "../panel/dist");
const FAKE_CLOCK = process.env.OLV_FAKE_CLOCK === "1";

let fakeNow = 0;
const now = (): number => (FAKE_CLOCK ? fakeNow : Date.now());

let logFile: LogFile | null = null;

function log(level: "info" | "warn" | "error", raw: string): void {
  const msg = redact(raw, apiKey ? [apiKey] : []);
  process.stderr.write(`${JSON.stringify({ level, msg })}\n`);
  logFile ??= new LogFile(join(DATA_DIR, "logs"));
  logFile.write({ level, event: msg.split(" ")[0], msg });
  if (level !== "info" && linkOpen && announced) sendExt({ type: "log", level, msg });
}


type Hello = Extract<ExtToBridge, { type: "hello" }>;
type Fragment = { text: string; startMs: number; endMs: number };
type Settings = { devices: { input?: string; output?: string } };
type PendingUtterance = { text: string; kind: "message" | "answer"; requestId?: string; optionIndex?: number };
type ChunkRun = { base: string; chunks: string[]; index: number; sawStart: boolean; delegationId: string | null };

let linkOpen = true;
let announced = false;
let hello: Hello | null = null;
let apiKey = "";
let server: PanelServer | null = null;
let token = "";
let panel: PanelConn | null = null;
let live: LiveSession | null = null;
let liveClosing: Promise<void> | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;
let closeTimeoutMs = GRACEFUL_CLOSE_MS;
let lastSpeechAt = -Infinity;
let reconnectBudget = 1;
let reconnectHistory: HistoryLine[] = [];
let lastCostAt = -Infinity;

const LIVE_ERROR_KO: Record<string, string> = {
  invalid_request_error: "요청이 올바르지 않아요. 다시 시도해 주세요.",
  rate_limit: "요청이 너무 많아요. 잠시 후 다시 시도해 주세요.",
  server_error: "음성 서버에 문제가 생겼어요. 잠시 후 다시 시도해 주세요.",
  moderation: "안전 정책 때문에 음성이 중단됐어요.",
};

function liveErrorMessage(code: string, type: string): string {
  for (const raw of [code, type]) {
    if (LIVE_ERROR_KO[raw]) return LIVE_ERROR_KO[raw]!;
    if (raw.startsWith("rate_limit")) return LIVE_ERROR_KO.rate_limit!;
    if (/moderat|content_filter|content_policy/.test(raw)) return LIVE_ERROR_KO.moderation!;
  }
  return `음성 연결에 오류가 있어요. (${code})`;
}

function userStart(): void {
  reconnectBudget = 1;
  dispatch({ type: "start" });
}

let state: Axes = INITIAL_STATE;
let adapter: AdapterState = initialAdapterState();
let confirmMode: ConfirmMode = "off";
let closeReason: string | undefined;
let connectedAt: number | null = null;
let eventSeq = 0;
const nextId = (prefix: string) => `${prefix}-${++eventSeq}`;

const timers = new Timers(now);
const guard = new Guard({ idleMs: IDLE_MS, capMs: CAP_MS, warnMs: WARN_MS, now, schedule: (fn, ms) => timers.schedule(fn, ms) });
guard.onIdle = () => dispatch({ type: "guard.idle" });
guard.onWarn = () => dispatch({ type: "guard.warn" });
guard.onCap = () => dispatch({ type: "guard.cap" });

const pacer = new InputPacer();
const vad = new VoiceActivity(MIC_RMS, 300, now);
let captureEnabled = false;
let muteControlled = false;

let fragments: Fragment[] = [];
let lastCutMs = 0;
let userUtteranceId = nextId("u");
let userText = "";
let userRevision = 0;
let delegationOffsetMs = 0;
let runDelegationId: string | null = null;
let pending: PendingUtterance | null = null;
let draft: { id: string; text: string } | null = null;
let heldDuringQuestion: string | null = null;
let cancelText = "";
let inputTurn: Fragment[] = [];
let lastInputDeltaAt = -Infinity;
let cancelledThroughMs = -1;

let outGen = 0;
let outSeq = 0;
let lastVoicedOut = -Infinity;
let outputEndedLocal = false;
let panelReportsPlayback = false;
let silentDropped = 0;
let assistantUtteranceId = nextId("a");
let assistantText = "";
let assistantRevision = 0;
let flushReason: "barge-in" | "stop" | "mute" = "barge-in";
let chunkRun: ChunkRun | null = null;

let transcript: TranscriptLog | null = null;


function loadSettings(): Settings {
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) as Partial<Settings>;
    const d = parsed.devices ?? {};
    return { devices: { ...(typeof d.input === "string" ? { input: d.input } : {}), ...(typeof d.output === "string" ? { output: d.output } : {}) } };
  } catch {
    return { devices: {} };
  }
}

function saveDevices(msg: DevicesMsg): void {
  const validList = (list: unknown): list is DevicesMsg["inputs"] => Array.isArray(list) &&
    list.every((device: unknown) => typeof device === "object" && device !== null &&
      "id" in device && typeof device.id === "string" && "label" in device && typeof device.label === "string");
  if (!validList(msg.inputs) || !validList(msg.outputs) ||
    typeof msg.selected !== "object" || msg.selected === null || Array.isArray(msg.selected) ||
    (msg.selected.input !== undefined && typeof msg.selected.input !== "string") ||
    (msg.selected.output !== undefined && typeof msg.selected.output !== "string")) {
    log("warn", "devices_invalid");
    return;
  }
  const label = (list: { id: string; label: string }[], id?: string) => (id === undefined ? undefined : list.find((d) => d.id === id)?.label);
  const input = label(msg.inputs, msg.selected.input);
  const output = label(msg.outputs, msg.selected.output);
  const devices = { ...loadSettings().devices, ...(input ? { input } : {}), ...(output ? { output } : {}) };
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(SETTINGS_FILE, `${JSON.stringify({ devices }, null, 2)}\n`);
  } catch (e) {
    log("warn", `settings_write_failed ${(e as Error).message.slice(0, 120)}`);
  }
}


const queue: Event[] = [];
let dispatching = false;

function dispatch(event: Event): void {
  queue.push(event);
  if (dispatching) return;
  dispatching = true;
  try {
    while (queue.length) {
      const ev = queue.shift()!;
      const result = transition(state, ev);
      const wasBusy = state.agent !== "idle";
      const wasSpeaking = state.input === "speech";
      state = result.state;
      if (outGen !== state.playbackGeneration) {
        outGen = state.playbackGeneration;
        outSeq = 0;
      }
      for (const effect of result.effects) {
        try {
          apply(effect);
        } catch (e) {
          log("error", `effect_failed ${effect.type} ${(e as Error).message.slice(0, 160)}`);
        }
      }
      if (wasBusy !== (state.agent !== "idle")) guard.setAgentBusy(state.agent !== "idle");
      if (wasSpeaking !== (state.input === "speech")) guard.setUserSpeaking(state.input === "speech");
    }
  } finally {
    dispatching = false;
  }
}

function stateMsg(s: Axes): Omit<StateMsg, "v" | "seq"> {
  return {
    type: "state",
    connection: s.connection,
    input: s.input,
    agent: s.agent,
    output: s.output,
    muted: s.muted,
    ...(s.connection === "closed" && closeReason ? { reason: closeReason } : {}),
  };
}

function apply(effect: Effect): void {
  switch (effect.type) {
    case "openLive":
      openLive();
      break;
    case "closeLive":
      closeReason = effect.reason;
      closeLive();
      break;
    case "enableCapture":
      captureEnabled = true;
      break;
    case "disableCapture":
      captureEnabled = false;
      pacer.take(1000);
      break;
    case "forwardUtterance":
      forwardPending();
      break;
    case "abortAgent":
      sendExt({ type: "utterance", id: nextId("utt"), text: cancelText, kind: "cancel" });
      cancelText = "";
      break;
    case "discardDraft":
      if (draft) {
        panel?.send({ type: "draft", draftId: draft.id, text: draft.text, status: "discarded" });
        draft = null;
      }
      state = { ...state, draftHeld: false };
      break;
    case "flushPlayback":
      lastVoicedOut = -Infinity;
      outputEndedLocal = false;
      timers.cancel("outputEnd");
      timers.cancel("drainFallback");
      if (assistantText) sendAssistant(true, true);
      panel?.send({ type: "flush", generation: effect.gen, reason: flushReason });
      flushReason = "barge-in";
      break;
    case "sendThinking":
      if (!live?.thinking(effect.content, delegationFor(), nextId("thinking"))) log("warn", "thinking_not_sent");
      break;
    case "sendCommentary":
      if (!live?.commentary(effect.content, delegationFor(), nextId("commentary"))) log("warn", "commentary_not_sent");
      break;
    case "notifyPanel": {
      const msg = stateMsg(effect.state);
      panel?.send(msg);
      sendExt(msg as BridgeToExt);
      break;
    }
    case "startTimer":
      armStateTimer(effect.name, effect.ms);
      break;
    case "cancelTimer":
      timers.cancel(`state.${effect.name}`);
      break;
    case "warnSpoken":
      log("info", "warn_spoken");
      break;
    case "warn":
      log("info", `unmatched_event ${effect.event}`);
      break;
  }
}

function delegationFor(): string | null {
  return state.pendingDelegationId ?? runDelegationId;
}

function armStateTimer(name: "ackWindow" | "settle" | "waitCue" | "confirm" | "handshake", ms: number): void {
  const key = `state.${name}`;
  switch (name) {
    case "ackWindow":
      return timers.start(key, ms, () => dispatch({ type: "timer.ackWindow" }));
    case "waitCue":
      return timers.start(key, ms, () => dispatch({ type: "timer.waitCue" }));
    case "handshake":
      return timers.start(key, ms, () => dispatch({ type: "live.error", code: "handshake_timeout" }));
    case "settle": {
      const offsetMs = delegationOffsetMs;
      const delegationId = state.pendingDelegationId;
      return timers.start(key, ms || SETTLE_MS, () => settleUtterance(offsetMs, delegationId));
    }
    case "confirm":
      return timers.start(key, ms, () => log("info", "confirm_timer"));
  }
}


function sendUser(final: boolean): void {
  if (!userText && !final) return;
  panel?.send({ type: "transcript", speaker: "user", utteranceId: userUtteranceId, revision: ++userRevision, text: userText, final, interrupted: false });
}

// P0 has only streamed deltas, no final event or server speech-end event.
// Complete a local turn after mic speech ends AND 600 ms without another delta.
// Re-arm on late ASR words; never classify an individual streamed prefix.
function completeInputTurn(): void {
  if (state.input === "speech" || now() - lastInputDeltaAt < SPEECH_END_MS) return;
  const turn = inputTurn;
  inputTurn = [];
  const endMs = turn.at(-1)?.endMs;
  const text = turn.map((f) => f.text).join("").trim();
  if (endMs === undefined || !isStandaloneCancel(text) ||
    (state.agent !== "working" && state.agent !== "submitting" && state.agent !== "question")) return;
  cancelledThroughMs = endMs;
  lastCutMs = Math.max(lastCutMs, endMs);
  fragments = fragments.filter((f) => f.endMs > endMs);
  timers.cancel("state.settle");
  timers.cancel("state.ackWindow");
  sendUser(true);
  userUtteranceId = nextId("u");
  userText = fragments.map((f) => f.text).join("");
  userRevision = 0;
  pending = null;
  cancelQuestion();
  cancelText = text;
  dispatch({ type: "utterance.committed", kind: "cancel" });
}

function settleUtterance(offsetMs: number, delegationId: string | null): void {
  const cut = offsetMs + CUT_PAD_MS;
  const text = transcriptWindow(fragments, lastCutMs, cut, UTTERANCE_GAP_MS).trim();
  lastCutMs = cut;
  fragments = fragments.filter((f) => f.endMs > cut);
  inputTurn = inputTurn.filter((f) => f.endMs > cut);
  sendUser(true);
  userUtteranceId = nextId("u");
  userText = fragments.map((f) => f.text).join("");
  userRevision = 0;
  if (!text) {
    log("info", `utterance_empty delegation=${delegationId ?? "none"}`);
    return;
  }
  const pq = state.pendingQuestion ? { requestId: state.pendingQuestion.requestId, options: [...state.pendingQuestion.options] } : null;
  const u = classifyUtterance(text, { pendingQuestion: pq });
  if (u.kind === "cancel") {
    pending = null;
    cancelText = text;
    dispatch({ type: "utterance.committed", kind: "cancel" });
    return;
  }
  if (u.kind === "answer") {
    pending = { text, kind: "answer", requestId: u.requestId, optionIndex: u.optionIndex };
    dispatch({ type: "utterance.committed", kind: "answer" });
    return;
  }
  if (state.agent === "question") {
    heldDuringQuestion = text;
    panel?.send({ type: "error", code: "answer_on_screen", message: ANSWER_ON_SCREEN, recoverable: true });
    log("info", "utterance_held_question");
    return;
  }
  if (confirmMode === "on") {
    const word = text.replace(/[.!?。\s]+$/u, "").trim();
    if (SEND_WORDS.test(word)) {
      if (!draft) return log("info", "send_without_draft");
      const held = draft;
      draft = null;
      state = { ...state, draftHeld: false };
      panel?.send({ type: "draft", draftId: held.id, text: held.text, status: "sent" });
      commitMessage(held.text);
      return;
    }
    if (draft) panel?.send({ type: "draft", draftId: draft.id, text: draft.text, status: "discarded" });
    draft = { id: nextId("draft"), text };
    state = { ...state, draftHeld: true };
    panel?.send({ type: "draft", draftId: draft.id, text, status: "held" });
    return;
  }
  commitMessage(text);
}

function commitMessage(text: string): void {
  pending = { text, kind: "message" };
  dispatch({ type: "utterance.committed", kind: "message" });
  if (pending) {
    log("warn", `utterance_not_forwarded agent=${state.agent} connection=${state.connection}`);
    panel?.send({ type: "error", code: "utterance_not_forwarded", message: "요청을 전달하지 못했어요. 잠시 후 다시 말해 주세요.", recoverable: true });
    pending = null;
  }
}

function forwardPending(): void {
  if (!pending) return log("warn", "forward_without_utterance");
  const p = pending;
  pending = null;
  runDelegationId = state.pendingDelegationId ?? runDelegationId;
  const msg: BridgeToExt = {
    type: "utterance",
    id: nextId("utt"),
    text: p.text,
    kind: p.kind,
    ...(p.requestId !== undefined ? { requestId: p.requestId } : {}),
    ...(p.optionIndex !== undefined ? { optionIndex: p.optionIndex } : {}),
  };
  sendExt(msg);
  guard.activity("agent");
}


function sendAssistant(final: boolean, interrupted = false): void {
  if (!assistantText) return;
  panel?.send({ type: "transcript", speaker: "assistant", utteranceId: assistantUtteranceId, revision: ++assistantRevision, text: assistantText, final, interrupted });
  if (final) {
    assistantUtteranceId = nextId("a");
    assistantText = "";
    assistantRevision = 0;
  }
}

function forwardPcm(pcm: Int16Array): void {
  for (let i = 0; i < pcm.length; i += MAX_FRAME_SAMPLES) server?.sendPcm(outGen, outSeq++, pcm.subarray(i, i + MAX_FRAME_SAMPLES));
}

function onOutputAudio(e: LiveEvent): void {
  if (typeof e.delta !== "string") return;
  const pcm = base64ToPcm(e.delta);
  const t = now();
  if (isVoiced(pcm, OUTPUT_RMS)) {
    lastVoicedOut = t;
    outputEndedLocal = false;
    timers.cancel("drainFallback");
    timers.start("outputEnd", OUTPUT_END_MS, onOutputEnd);
    questionProgress();
    if (state.output === "idle") dispatch({ type: "output.start" });
    if (state.output === "speaking") forwardPcm(pcm);
    return;
  }
  if (state.output === "speaking" && t - lastVoicedOut <= TRAILING_SILENCE_MS) {
    forwardPcm(pcm);
    return;
  }
  silentDropped++;
  if (silentDropped % 10 === 1) log("info", `silent_dropped total=${silentDropped}`);
}

function onOutputEnd(): void {
  outputEndedLocal = true;
  sendAssistant(true);
  dispatch({ type: "output.end" });
  if (!panelReportsPlayback) timers.start("drainFallback", DRAIN_FALLBACK_MS, () => {
    log("info", "drain_fallback no_playback_stats");
    dispatch({ type: "buffer.drained" });
  });
  if (chunkRun?.sawStart) {
    timers.cancel("questionChunk");
    chunkRun.index++;
    sendNextChunk();
  }
}

function onPlayback(msg: PlaybackMsg): void {
  if (typeof msg.flushAck === "number") {
    dispatch({ type: "flush.acked", gen: msg.flushAck });
    return;
  }
  panelReportsPlayback = true;
  if (msg.generation === state.playbackGeneration && msg.bufferedSamples === 0 && outputEndedLocal && state.output === "speaking") {
    timers.cancel("drainFallback");
    dispatch({ type: "buffer.drained" });
  }
}


function startQuestion(chunks: string[], delegationId: string | null): void {
  cancelQuestion();
  chunkRun = chunks.length ? { base: nextId("question"), chunks, index: 0, sawStart: false, delegationId } : null;
  sendNextChunk();
}

function sendNextChunk(): void {
  const run = chunkRun;
  if (!run) return;
  if (run.index >= run.chunks.length) {
    chunkRun = null;
    return;
  }
  run.sawStart = false; // observer armed BEFORE the append: an early output.start is kept
  armQuestionTimeout();
  // An appended acknowledgement is not speech. Retry only this chunk, once, without
  // extending its existing 15-second start/stall deadline.
  timers.start("questionStart", QUESTION_START_MS, () => {
    if (chunkRun !== run || run.sawStart) return;
    log("info", `question_chunk_retry chunk=${run.index + 1}/${run.chunks.length}`);
    appendQuestionChunk(nextId("question-retry"));
  });
  appendQuestionChunk(`${run.base}-${run.index + 1}`);
}

function appendQuestionChunk(eventId: string): void {
  const run = chunkRun;
  if (!run) return;
  if (!live?.commentary(run.chunks[run.index]!, run.delegationId, eventId)) {
    log("warn", "question_chunk_not_sent");
    cancelQuestion();
  }
}

function questionProgress(): void {
  if (!chunkRun) return;
  chunkRun.sawStart = true;
  timers.cancel("questionStart");
  armQuestionTimeout();
  // Either voiced PCM or nonempty transcript progress postpones the SAME deadline.
  // Continuous silent PCM and append acknowledgements postpone neither deadline.
  timers.start("outputEnd", QUESTION_QUIESCENCE_MS, onOutputEnd);
}

function armQuestionTimeout(): void {
  const run = chunkRun;
  if (!run) return;
  timers.start("questionChunk", QUESTION_CHUNK_TIMEOUT_MS, () => {
    log("warn", `question_chunk_timeout chunk=${run.index + 1}/${run.chunks.length}`);
    panel?.send({ type: "error", code: "question_speech_timeout", message: "질문을 읽지 못했어요. 화면을 확인해 주세요.", recoverable: true });
    cancelQuestion();
  });
}

function cancelQuestion(): void {
  chunkRun = null;
  timers.cancel("questionChunk");
  timers.cancel("questionStart");
}


function runCommands(commands: LiveCommand[]): string[] {
  const chunks: string[] = [];
  for (const c of commands) {
    if (c.kind === "panel") panel?.send(c.msg);
    else if (c.kind === "instructions") chunks.push(c.content);
  }
  return chunks;
}

function onExt(msg: ExtToBridge | { type: "qa.clock"; now: number }): void {
  if (msg.type === "qa.clock") {
    if (!FAKE_CLOCK || typeof msg.now !== "number") return log("warn", "qa_clock_ignored");
    fakeNow = msg.now;
    timers.poll();
    return;
  }
  if (msg.type === "hello") {
    if (hello) return log("warn", "duplicate_hello");
    hello = msg;
    void boot();
    return;
  }
  if (!hello) return log("warn", `ext_before_hello ${String(msg.type).slice(0, 40)}`);
  if (msg.type.startsWith("agent.")) return onAgent(msg);
  switch (msg.type) {
    case "confirm":
      confirmMode = msg.mode === "on" ? "on" : "off";
      if (confirmMode === "off" && draft) apply({ type: "discardDraft" });
      return;
    case "resume":
      if (state.connection === "closed") userStart();
      if (server) sendExt({ type: "ready", port: server.port, token, panelUrl: server.url });
      return;
    case "stop":
      void shutdown(0, "stop");
      return;
    default:
      log("warn", `ext_unknown_type ${String((msg as { type: string }).type).slice(0, 40)}`);
  }
}

function onAgent(msg: ExtToBridge): void {
  adapter = { ...adapter, delegationId: delegationFor(), agent: state.agent, pendingQuestion: state.pendingQuestion ? { requestId: state.pendingQuestion.requestId, options: [...state.pendingQuestion.options] } : null };
  let reduced: ReturnType<typeof reduceAgent>;
  try {
    reduced = reduceAgent(msg, adapter, COMMENTARY_CAP_CHARS);
  } catch (e) {
    return log("error", `adapter_failed ${(e as Error).message.slice(0, 160)}`);
  }
  adapter = reduced.state;
  const chunks = runCommands(reduced.commands);
  const spoken = reduced.commands.find((c) => c.kind === "commentary");
  const commentary = spoken && spoken.kind !== "panel" ? spoken.content : undefined;
  guard.activity("agent");
  switch (msg.type) {
    case "agent.delta":
      if (state.agent === "submitting" || state.agent === "working" || state.agent === "question")
        dispatch({ type: "agent.working" });
      return;
    case "agent.tool.start":
      dispatch({ type: "agent.working", tool: msg.name });
      return;
    case "agent.idle":
      if (!msg.idle) {
        dispatch({ type: state.agent === "submitting" ? "agent.accepted" : "agent.working" });
      } else {
        cancelQuestion();
        dispatch({ type: state.agent === "cancelling" ? "agent.cancelDone" : "agent.end" });
        runDelegationId = null;
      }
      return;
    case "agent.end":
      cancelQuestion();
      if (state.agent === "cancelling") return dispatch({ type: "agent.cancelDone" });
      dispatch({ type: "agent.end", ...(commentary ? { content: commentary } : {}) });
      runDelegationId = null;
      return;
    case "agent.question":
      if (state.agent === "cancelling") return;
      dispatch({ type: "agent.question", q: { requestId: msg.requestId, options: msg.options.map((o) => o.label) } });
      if (state.pendingQuestion?.requestId === msg.requestId) startQuestion(chunks, delegationFor());
      return;
    case "agent.question.closed":
      cancelQuestion();
      if (heldDuringQuestion !== null) {
        log("info", "utterance_discarded_question_closed");
        heldDuringQuestion = null;
      }
      dispatch({ type: "agent.answered" });
      return;
    default:
      return;
  }
}


function onPanel(conn: PanelConn): void {
  panel = conn;
  panelReportsPlayback = false;
  conn.send({
    type: "hello",
    sessionId: hello?.sessionId ?? "standalone",
    title: hello?.title ?? null,
    format: { rate: 24000, channels: 1 },
    limits: { idleMs: IDLE_MS, capMs: CAP_MS, warnMs: WARN_MS },
    qa: hello?.qa ?? false,
    devices: loadSettings().devices,
    confirmMode,
  });
  conn.send(stateMsg(state));
  conn.onPcm((frame) => {
    if (!captureEnabled || state.muted || state.connection !== "open") return;
    pacer.push(new Uint8Array(frame.pcm.buffer, frame.pcm.byteOffset, frame.pcm.byteLength));
    const cue = vad.classify(frame.pcm, state.output === "speaking");
    if (isVoiced(frame.pcm, MIC_RMS)) {
      lastSpeechAt = now();
      timers.start("speechEnd", SPEECH_END_MS, () => {
        dispatch({ type: "speech.end" });
        completeInputTurn();
      });
      guard.activity("speech");
    }
    if (cue === "interrupt") dispatch({ type: "interrupt" });
    if (cue) dispatch({ type: "speech.start" });
  });
  conn.onMessage((msg) => {
    switch (msg.type) {
      case "devices":
        return saveDevices(msg);
      case "playback":
        return onPlayback(msg);
      case "control":
        return onControl(msg.action);
    }
  });
  conn.onClose(() => {
    if (panel !== conn) return;
    panel = null;
    dispatch({ type: "panel.disconnected" });
  });
  if (state.connection === "closed" && !shuttingDown) userStart();
}

function onControl(action: "mute" | "unmute" | "stop" | "resume" | "confirm" | "discard"): void {
  switch (action) {
    case "mute":
      muteControlled = true;
      flushReason = "mute";
      dispatch({ type: "mute" });
      return syncLiveMute();
    case "unmute":
      muteControlled = true;
      dispatch({ type: "unmute" });
      return syncLiveMute();
    case "stop":
      return void shutdown(0, "stop");
    case "resume":
      return userStart();
    case "confirm":
      if (draft) {
        const held = draft;
        draft = null;
        state = { ...state, draftHeld: false };
        panel?.send({ type: "draft", draftId: held.id, text: held.text, status: "sent" });
        commitMessage(held.text);
      }
      return;
    case "discard":
      return apply({ type: "discardDraft" });
  }
}

function syncLiveMute(): void {
  if (!live?.ready) return;
  const action = state.muted ? "mute" : "unmute";
  live[action]().catch((e: Error) => log("warn", `${action}_failed ${e.message.slice(0, 80)}`));
}

function openLive(): void {
  if (live) return log("warn", "open_while_live");
  const session = new LiveSession({ apiKey, log: (line) => log("info", line), history: reconnectHistory });
  reconnectHistory = [];
  live = session;
  closeReason = undefined;
  fragments = [];
  lastCutMs = 0;
  inputTurn = [];
  lastInputDeltaAt = -Infinity;
  cancelledThroughMs = -1;
  timers.cancel("inputComplete");
  const mine = (fn: (e: LiveEvent) => void) => (e: LiveEvent) => {
    if (live === session) fn(e);
  };
  session.onEvent("session.started", mine((e) => {
    const voice = e.session?.audio?.output?.voice;
    if (voice !== undefined && voice !== LIVE_VOICE) return void cedarRejected(`voice=${String(voice).slice(0, 20)}`);
    connectedAt = now();
    guard.connected();
    dispatch({ type: "live.started" });
    if (muteControlled) syncLiveMute();
  }));
  session.onEvent("session.input_transcript.delta", mine((e) => {
    if (typeof e.delta !== "string") return;
    const text = e.delta;
    const startMs = Number(e.start_ms ?? 0);
    const endMs = Number(e.end_ms ?? startMs);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs || endMs <= cancelledThroughMs) return;
    if (startMs - (inputTurn.at(-1)?.endMs ?? startMs) >= SPEECH_END_MS) inputTurn = [];
    inputTurn.push({ text, startMs, endMs });
    lastInputDeltaAt = now();
    timers.start("inputComplete", SPEECH_END_MS, completeInputTurn);
    fragments.push({ text, startMs, endMs });
    userText += text;
    sendUser(false);
    transcript?.delta("사용자", text, startMs, endMs);
    guard.activity("speech");
  }));
  session.onEvent("session.output_transcript.delta", mine((e) => {
    const text = String(e.delta ?? "");
    if (text.trim()) questionProgress();
    assistantText += text;
    sendAssistant(false);
    transcript?.delta("어시스턴트", text, Number(e.start_ms ?? 0), Number(e.end_ms ?? 0));
  }));
  session.onEvent("session.output_audio.delta", mine(onOutputAudio));
  session.onEvent("session.delegation.created", mine((e) => {
    const id = String(e.delegation?.id ?? "");
    if (!id) return log("warn", "delegation_without_id");
    delegationOffsetMs = Number(e.offset_ms ?? 0);
    if (delegationOffsetMs <= cancelledThroughMs) return;
    dispatch({ type: "delegation.created", id, offsetMs: delegationOffsetMs });
  }));
  session.onEvent("session.usage.updated", mine(() => sendCost()));
  session.onEvent("error", mine((e) => {
    const code = String(e.error?.code ?? "unknown");
    const type = String(e.error?.type ?? "");
    log("warn", `live_error code=${code.slice(0, 60)} type=${type.slice(0, 60)}`);
    if (session.ready) panel?.send({ type: "error", code, message: liveErrorMessage(code, type), recoverable: true });
  }));
  session.onEvent("session.closed", mine((e) => {
    guard.disconnected();
    sendCost();
    connectedAt = null;
    live = null;
    closeReason = String(e.reason ?? "closed");
    log("info", `final_usage seconds=${String(e.usage?.seconds ?? session.usageSeconds)} reason=${closeReason}`);
    const dropped = closeReason === "live_dropped";
    const active = now() - lastSpeechAt <= ACTIVE_WINDOW_MS;
    const reconnect = dropped && active && reconnectBudget > 0 && !shuttingDown && panel !== null;
    if (dropped) {
      log("warn", `live_dropped active=${active} reconnect=${reconnect}`);
      if (!reconnect) {
        const unavailable = active && !shuttingDown;
        panel?.send(unavailable
          ? { type: "error", code: "live_unavailable", message: "음성 연결이 끊겨 다시 연결하지 못했어요. 다시 시작해 주세요.", recoverable: true }
          : { type: "error", code: "live_dropped", message: "Live connection dropped", recoverable: true });
      }
    }
    cancelQuestion();
    timers.cancel("inputComplete");
    timers.cancel("speechEnd");
    inputTurn = [];
    dispatch({ type: "live.closed", reason: closeReason });
    if (reconnect) {
      reconnectBudget--;
      reconnectHistory = (transcript?.recent(HISTORY_LINES) ?? []).map((l) => ({ role: l.speaker === "사용자" ? "user" : "assistant", text: l.text }));
      dispatch({ type: "start" });
    }
  }));
  session.start().catch((err: Error) => {
    if (live !== session) return;
    const code = /rejected: (\S+)/.exec(err.message)?.[1];
    log("warn", `live_start_failed code=${code ?? "connect"}`);
    panel?.send({ type: "error", code: "live_start_failed", message: code ?? "connect", recoverable: code !== "invalid_value" });
    if (code === "invalid_value") return void cedarRejected("invalid_value");
    live = null;
    dispatch({ type: "live.error", code: "live_start_failed" });
  });
}

async function cedarRejected(detail: string): Promise<void> {
  log("error", `cedar_rejected ${detail}`);
  panel?.send({ type: "error", code: "live_start_failed", message: "cedar_rejected", recoverable: false });
  await shutdown(1, "cedar_rejected");
}

function closeLive(): void {
  const session = live;
  live = null;
  cancelQuestion();
  timers.cancel("inputComplete");
  timers.cancel("speechEnd");
  inputTurn = [];
  if (connectedAt !== null) {
    guard.disconnected();
    sendCost();
    connectedAt = null;
  }
  if (!session) return;
  liveClosing = session.close(closeTimeoutMs)
    .then(() => log("info", `final_usage seconds=${session.usageSeconds}`))
    .catch((e: Error) => log("warn", `live_close_failed ${e.message.slice(0, 80)}`));
}

function sendCost(): void {
  lastCostAt = now();
  const cumulativeMs = guard.cumulativeMs();
  panel?.send({ type: "cost", connectedMs: connectedAt === null ? 0 : now() - connectedAt, cumulativeMs, estimatedUsd: guard.estimatedUsd() });
}


function tick(): void {
  timers.poll();
  if (connectedAt !== null && now() - lastCostAt >= COST_TICK_MS) sendCost();
  if (live && state.connection === "open" && captureEnabled && !state.muted) live.appendAudio(pacer.take(TICK_MS));
}

async function boot(): Promise<void> {
  try {
    apiKey = await readApiKey(KEYCHAIN_SERVICE);
  } catch (e) {
    log("error", `key_missing ${(e as Error).name}`);
    return shutdown(1, "key_missing");
  }
  if (shuttingDown) return;
  token = createToken();
  logFile?.addSecret(apiKey);
  transcript = new TranscriptLog(join(DATA_DIR, "transcripts"));
  let panelDir = PANEL_DIR;
  if (!existsSync(panelDir)) {
    log("warn", "panel_not_built run bun run build:panel");
    panelDir = resolve(import.meta.dir, "../panel");
  }
  try {
    server = await startServer({ panelDir, token, allowedOrigins: [], onPanel, qa: () => hello?.qa ?? false, log: (level, msg) => level === "debug" || log(level, msg) });
  } catch (e) {
    log("error", `server_start_failed ${(e as Error).message.slice(0, 120)}`);
    return shutdown(1, "server_start_failed");
  }
  if (shuttingDown) return;
  ticker = setInterval(tick, TICK_MS);
  sendExt({ type: "ready", port: server.port, token, panelUrl: server.url });
  announced = true;
}

async function shutdown(code: number, reason: string, closeMs = GRACEFUL_CLOSE_MS): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  closeTimeoutMs = closeMs;
  flushReason = "stop";
  dispatch({ type: "stop" });
  if (live) closeLive();
  if (liveClosing) await Promise.race([liveClosing, Bun.sleep(closeMs + 500)]);
  if (ticker) clearInterval(ticker);
  timers.clear();
  transcript?.flush();
  if (silentDropped) log("info", `silent_dropped total=${silentDropped}`);
  panel?.close(1001, reason);
  await server?.close().catch(() => undefined);
  if (linkOpen) {
    try {
      sendExt({ type: "exit", reason });
    } catch {
      // stdout already gone: the extension died first
    }
  }
  process.exit(code);
}

process.on("SIGTERM", () => void shutdown(0, "sigterm"));
process.on("SIGINT", () => void shutdown(0, "sigint"));
process.stdout.on("error", () => {
  linkOpen = false;
});

if (process.argv.includes("--standalone")) {
  onExt({ type: "hello", sessionId: "standalone", sessionFile: null, cwd: process.cwd(), title: null, qa: true });
}

void readExt(onExt as (msg: ExtToBridge) => void).then(() => {
  log("info", "stdin_closed");
  void shutdown(0, "stdin_closed", EOF_CLOSE_MS);
});
