// Panel entry: wires the DOM to the view-model (viewmodel.ts), the bridge socket (ws.ts) and the audio graph (audio.ts).
import { MAX_FRAME_SAMPLES, type BridgeToPanel } from "../shared/protocol.ts";
import { PanelAudio, armAudioContext, audioCapabilities, listDevices, parseQaParams, type AudioDevice } from "./audio.ts";
import {
  agentBadgeText,
  applyEnvelope,
  formatCost,
  initialViewState,
  resolvePersistedDevices,
  stateBadgeKey,
  stateBadgeText,
  type PanelViewState,
  type UtteranceEntry,
} from "./viewmodel.ts";
import { connectPanelWs, type PanelWsClient, type PcmFrame } from "./ws.ts";

const QA_WAV_PREFIX = "/assets/qa/";
const DEFAULT_QA_WAV = `${QA_WAV_PREFIX}ko-list-files.wav`;
const DEFAULT_PORT = "47831";
const DEFAULT_SAMPLE_RATE = 48_000;
const TOAST_MS = 6_000;
const AUTOSCROLL_SLACK_PX = 24;
const EMPTY_USER_COPY = "말을 시작하면 여기에 자막이 나타나요.";
const EMPTY_ASSISTANT_COPY = "어시스턴트의 말이 여기에 나타나요.";
const GESTURE_NOTICE = "마이크를 켜려면 화면을 한 번 클릭하거나 아무 키나 눌러 주세요.";
const MIC_DENIED_KO = "마이크 권한이 거부되었어요. 브라우저 설정에서 마이크 권한을 허용해 주세요.";
const NOT_CONNECTED_KO = "브리지에 연결되어 있지 않아요.";

interface OlvHook {
  stats: { consumed: number; buffered: number; generation: number; lastFlushAck: number | null };
  qa: { inject(wavUrl?: string): Promise<void> };
  getState(): PanelViewState;
  audio(): { contextState: AudioContextState; currentTime: number; sampleRate: number; capture: string } | null;
}

declare global {
  interface Window {
    __olv?: OlvHook;
  }
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`panel: #${id} missing from index.html`);
  return node as T;
}

function probeSampleRate(): number {
  try {
    const ctx = new AudioContext();
    const rate = ctx.sampleRate || DEFAULT_SAMPLE_RATE;
    void ctx.close().catch(() => undefined);
    return rate;
  } catch {
    return DEFAULT_SAMPLE_RATE;
  }
}

function isMicPermissionError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name ?? "";
  return name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError";
}

function wavPcm16(buf: ArrayBuffer): Int16Array {
  const view = new DataView(buf);
  const tag = (off: number) => String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
  if (buf.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a RIFF/WAVE file");
  let channels = 1;
  let bits = 16;
  let off = 12;
  while (off + 8 <= buf.byteLength) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt ") {
      channels = view.getUint16(body + 2, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === "data") {
      if (bits !== 16) throw new Error(`unsupported WAV: ${bits}-bit`);
      const frames = Math.floor(Math.min(size, buf.byteLength - body) / (2 * channels));
      const mono = new Int16Array(frames);
      for (let i = 0; i < frames; i++) mono[i] = view.getInt16(body + i * channels * 2, true);
      return mono;
    }
    off = body + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

function resolveQaWav(wavUrl: string): string {
  const url = new URL(wavUrl, location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith(QA_WAV_PREFIX) || !url.pathname.endsWith(".wav")) {
    throw new Error(`qa_wav must be a same-origin ${QA_WAV_PREFIX}*.wav`);
  }
  return url.href;
}

function renderCaptions(container: HTMLElement, countEl: HTMLElement, list: readonly UtteranceEntry[], emptyCopy: string): void {
  countEl.textContent = String(list.length);
  const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= AUTOSCROLL_SLACK_PX;
  const previous = new Map<string, HTMLElement>();
  for (const child of Array.from(container.children)) {
    const id = (child as HTMLElement).dataset.utteranceId;
    if (id) previous.set(id, child as HTMLElement);
  }
  const fragment = document.createDocumentFragment();
  if (list.length === 0) {
    const empty = document.createElement("p");
    empty.className = "pane-empty";
    empty.textContent = emptyCopy;
    fragment.appendChild(empty);
  }
  for (const item of list) {
    let node = previous.get(item.utteranceId);
    if (!node) {
      node = document.createElement("div");
      node.className = "utterance";
      node.dataset.utteranceId = item.utteranceId;
      const text = document.createElement("p");
      text.className = "utterance-text";
      const meta = document.createElement("p");
      meta.className = "utterance-meta";
      node.append(text, meta);
    }
    node.dataset.final = String(item.final);
    node.dataset.interrupted = String(item.interrupted);
    node.querySelector(".utterance-text")!.textContent = item.text;
    const meta = node.querySelector<HTMLElement>(".utterance-meta")!;
    meta.textContent = item.interrupted ? "중단됨" : item.final ? "" : "인식 중…";
    meta.hidden = meta.textContent === "";
    fragment.appendChild(node);
  }
  container.replaceChildren(fragment);
  if (wasAtBottom || previous.size === 0) container.scrollTop = container.scrollHeight;
}

function bootPanel(): void {
  const shell = el<HTMLElement>("shell");
  const sessionLabel = el<HTMLElement>("session-label");
  const costEl = el<HTMLElement>("cost");
  const statePill = el<HTMLElement>("state");
  const stateText = el<HTMLElement>("state-text");
  const agentPill = el<HTMLElement>("agent-state");
  const noticeEl = el<HTMLElement>("notice");
  const errorToast = el<HTMLElement>("error");
  const errorText = el<HTMLElement>("error-text");
  const errorDismiss = el<HTMLButtonElement>("error-dismiss");
  const questionCard = el<HTMLElement>("question");
  const questionHeader = el<HTMLElement>("question-header");
  const questionBody = el<HTMLElement>("question-body");
  const questionOptions = el<HTMLOListElement>("question-options");
  const draftCard = el<HTMLElement>("draft");
  const draftText = el<HTMLElement>("draft-text");
  const draftConfirm = el<HTMLButtonElement>("draft-confirm");
  const draftDiscard = el<HTMLButtonElement>("draft-discard");
  const userCaption = el<HTMLElement>("user-caption");
  const assistantCaption = el<HTMLElement>("assistant-caption");
  const userCount = el<HTMLElement>("user-count");
  const assistantCount = el<HTMLElement>("assistant-count");
  const muteBtn = el<HTMLButtonElement>("mute");
  const muteLabel = el<HTMLElement>("mute-label");
  const resumeBtn = el<HTMLButtonElement>("resume");
  const stopBtn = el<HTMLButtonElement>("stop");
  const qaInjectBtn = el<HTMLButtonElement>("qa-inject");
  const deviceInput = el<HTMLSelectElement>("device-input");
  const deviceOutput = el<HTMLSelectElement>("device-output");

  const params = new URLSearchParams(location.search);
  const token = params.get("token") ?? "";
  const port = location.port || DEFAULT_PORT;
  const qaParams = parseQaParams(location.search, location.href);
  const workletBase = new URL(shell.dataset.worklets ?? "./worklets/", document.baseURI).href;
  const caps = audioCapabilities();

  let state: PanelViewState = initialViewState();
  let ws: PanelWsClient | null = null;
  let audio: PanelAudio | null = null;
  let audioBoot: Promise<PanelAudio | null> | null = null;
  let captureState: "idle" | "starting" | "running" = "idle";
  let inputs: AudioDevice[] = [];
  let outputs: AudioDevice[] = [];
  let selected: { input?: string; output?: string } = {};
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let overflowReported = false;
  const qaOpts = { qa: qaParams.qa, qaWav: qaParams.qaWav };
  const stats: OlvHook["stats"] = { consumed: 0, buffered: 0, generation: 0, lastFlushAck: null };

  function render(): void {
    const key = stateBadgeKey(state);
    shell.dataset.state = key;
    statePill.dataset.state = key;
    stateText.textContent = stateBadgeText(state);
    sessionLabel.textContent = state.title ?? (state.sessionId || "세션 연결 중");
    costEl.textContent = formatCost(state.cumulativeMs, state.estimatedUsd);

    const agentText = agentBadgeText(state);
    agentPill.textContent = agentText;
    agentPill.hidden = agentText === "";

    const needsGesture = !qaParams.qa && audio === null && state.connection === "open";
    noticeEl.textContent = needsGesture ? GESTURE_NOTICE : "";
    noticeEl.hidden = !needsGesture;

    errorText.textContent = state.error?.message ?? "";
    errorToast.hidden = state.error === null;

    if (state.agent === "question" && state.question) {
      questionHeader.textContent = state.question.header;
      questionBody.textContent = state.question.question;
      questionOptions.replaceChildren(
        ...state.question.options.map((option) => {
          const li = document.createElement("li");
          li.textContent = option;
          return li;
        }),
      );
      questionCard.hidden = false;
    } else {
      questionCard.hidden = true;
    }

    draftText.textContent = state.draft?.text ?? "";
    draftCard.hidden = state.draft === null;

    renderCaptions(userCaption, userCount, state.userCaptions, EMPTY_USER_COPY);
    renderCaptions(assistantCaption, assistantCount, state.assistantCaptions, EMPTY_ASSISTANT_COPY);

    muteBtn.setAttribute("aria-pressed", String(state.muted));
    muteLabel.textContent = state.muted ? "음소거 해제 (M)" : "음소거 (M)";
    resumeBtn.disabled = state.connection !== "closed";
    stopBtn.disabled = state.connection === "closed";
    qaInjectBtn.hidden = !state.qa;
  }

  function showError(code: string, message: string, recoverable: boolean): void {
    state = applyEnvelope(state, { v: 1, type: "error", seq: 0, code, message, recoverable });
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = recoverable
      ? setTimeout(() => {
          state = { ...state, error: null };
          render();
        }, TOAST_MS)
      : null;
    render();
  }

  function fillSelect(select: HTMLSelectElement, devices: AudioDevice[], fallback: string, current: string | undefined): void {
    const list = devices.length > 0 ? devices : [{ id: "", label: fallback }];
    select.replaceChildren(
      ...list.map((d) => {
        const option = document.createElement("option");
        option.value = d.id;
        option.textContent = d.label;
        option.selected = d.id === (current ?? "");
        return option;
      }),
    );
  }

  function renderDevices(): void {
    const resolved = resolvePersistedDevices(inputs, outputs, state.persistedDeviceLabels);
    selected = { input: selected.input ?? resolved.input, output: selected.output ?? resolved.output };
    fillSelect(deviceInput, inputs, "기본 마이크", selected.input);
    fillSelect(deviceOutput, outputs, "기본 스피커", selected.output);
    deviceOutput.disabled = !caps.setSinkId;
  }

  async function refreshDevices(): Promise<void> {
    if (!navigator.mediaDevices?.enumerateDevices) return renderDevices();
    try {
      const listed = await listDevices();
      inputs = listed.inputs;
      outputs = listed.outputs;
    } catch {
      inputs = [];
      outputs = [];
    }
    renderDevices();
  }

  function ensureAudio(): Promise<PanelAudio | null> {
    if (audio) return Promise.resolve(audio);
    if (audioBoot) return audioBoot;
    audioBoot = (async () => {
      try {
        const ctx = await armAudioContext(qaParams.qa, window);
        const instance = await PanelAudio.create(ctx, {
          qa: qaOpts,
          workletBase,
          callbacks: {
            onFrame: (frame) => void ws?.sendPcm(frame.generation, frame.seq, frame.pcm),
            onPlayback(report) {
              stats.generation = report.generation;
              if (typeof report.flushAck === "number") {
                stats.lastFlushAck = report.flushAck;
                stats.buffered = 0;
              } else {
                stats.consumed = report.consumedSamples;
                stats.buffered = report.bufferedSamples;
              }
              ws?.sendPlayback(report);
            },
            onOverflow(generation, dropped) {
              console.warn(`playback overflow gen=${generation} dropped=${dropped}`);
              if (overflowReported) return;
              overflowReported = true;
              showError("audio_overflow", "재생 버퍼가 가득 차서 일부 음성을 건너뛰었어요.", true);
            },
          },
        });
        audio = instance;
        render();
        return instance;
      } catch (err) {
        audioBoot = null;
        showError("audio_init_failed", `오디오를 초기화하지 못했어요. (${err instanceof Error ? err.message : String(err)})`, true);
        return null;
      }
    })();
    return audioBoot;
  }

  async function startCaptureIfReady(): Promise<void> {
    if (captureState !== "idle" || state.connection !== "open" || state.muted) return;
    captureState = "starting";
    const panelAudio = await ensureAudio();
    if (!panelAudio || state.connection !== "open") {
      captureState = "idle";
      return;
    }
    try {
      await panelAudio.startCapture({ deviceId: selected.input || undefined, bridgeQa: state.qa });
      panelAudio.setMuted(state.muted);
      captureState = "running";
      await refreshDevices();
    } catch (err) {
      captureState = "idle";
      if (isMicPermissionError(err)) showError("mic_permission_denied", MIC_DENIED_KO, false);
      else showError("mic_capture_failed", `마이크 입력을 시작하지 못했어요. (${err instanceof Error ? err.message : String(err)})`, true);
    }
  }

  function stopCapture(): void {
    audio?.stopCapture();
    captureState = "idle";
  }

  async function injectQaWav(wavUrl = DEFAULT_QA_WAV): Promise<void> {
    if (!state.qa) throw new Error("bridge hello.qa is false: QA injection is disabled");
    const href = resolveQaWav(wavUrl);
    if (audio) {
      qaOpts.qa = true;
      qaOpts.qaWav = href;
      captureState = "starting";
      await audio.startCapture({ bridgeQa: true });
      captureState = "running";
      return;
    }
    const res = await fetch(href);
    if (!res.ok) throw new Error(`QA WAV ${href}: HTTP ${res.status}`);
    const pcm = wavPcm16(await res.arrayBuffer());
    for (let off = 0, seq = 0; off < pcm.length; off += MAX_FRAME_SAMPLES, seq++) {
      const frame = new Int16Array(MAX_FRAME_SAMPLES);
      frame.set(pcm.subarray(off, off + MAX_FRAME_SAMPLES));
      if (!ws?.sendPcm(0, seq, frame)) throw new Error(NOT_CONNECTED_KO);
    }
  }

  function sendControl(action: "mute" | "unmute" | "stop" | "resume" | "confirm" | "discard"): boolean {
    const sent = ws?.sendControl(action) ?? false;
    if (!sent) showError("not_connected", NOT_CONNECTED_KO, true);
    return sent;
  }

  function toggleMute(): void {
    const muted = !state.muted;
    if (!sendControl(muted ? "mute" : "unmute")) return;
    state = { ...state, muted };
    audio?.setMuted(muted);
    render();
  }

  muteBtn.addEventListener("click", toggleMute);
  resumeBtn.addEventListener("click", () => void sendControl("resume"));
  stopBtn.addEventListener("click", () => void sendControl("stop"));
  draftConfirm.addEventListener("click", () => void sendControl("confirm"));
  draftDiscard.addEventListener("click", () => void sendControl("discard"));
  errorDismiss.addEventListener("click", () => {
    state = { ...state, error: null };
    render();
  });
  qaInjectBtn.addEventListener("click", () => {
    injectQaWav(qaOpts.qaWav ?? DEFAULT_QA_WAV).catch((err) => showError("qa_inject_failed", `QA 음성을 주입하지 못했어요. (${String(err)})`, true));
  });
  deviceInput.addEventListener("change", () => {
    selected = { ...selected, input: deviceInput.value || undefined };
    ws?.sendDevices(inputs, outputs, selected);
    if (captureState === "running") {
      stopCapture();
      void startCaptureIfReady();
    }
  });
  deviceOutput.addEventListener("change", () => {
    selected = { ...selected, output: deviceOutput.value || undefined };
    ws?.sendDevices(inputs, outputs, selected);
    if (selected.output && audio) {
      audio.setOutputDevice(selected.output).catch(() => showError("output_device_failed", "스피커를 바꾸지 못했어요.", true));
    }
  });
  navigator.mediaDevices?.addEventListener?.("devicechange", () => void refreshDevices());

  window.addEventListener("keydown", (ev: KeyboardEvent) => {
    const target = ev.target as HTMLElement | null;
    const tag = target?.tagName ?? "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.repeat) return;
    const isM = ev.key === "m" || ev.key === "M" || ev.key === "ㅁ";
    const isSpace = ev.code === "Space" || ev.key === " ";
    if (!isM && !(isSpace && tag !== "BUTTON")) return;
    ev.preventDefault();
    toggleMute();
  });
  window.addEventListener("beforeunload", () => ws?.close());

  window.__olv = {
    stats,
    qa: { inject: injectQaWav },
    getState: () => state,
    audio: () => (audio ? { contextState: audio.ctx.state, currentTime: audio.ctx.currentTime, sampleRate: audio.ctx.sampleRate, capture: captureState } : null),
  };

  render();
  renderDevices();

  if (!token) {
    showError("unauthorized", "인증 토큰이 없어요 (unauthorized). /voice 명령이 연 패널 주소로 접속해 주세요.", false);
    return;
  }

  ws = connectPanelWs({
    port,
    token,
    capabilities: caps,
    sampleRate: probeSampleRate(),
    handlers: {
      onEnvelope(env: BridgeToPanel) {
        const wasOpen = state.connection === "open";
        state = applyEnvelope(state, env);
        switch (env.type) {
          case "hello":
            void ensureAudio();
            void refreshDevices();
            break;
          case "flush":
            if (audio) {
              audio.flush(env.generation);
            } else {
              stats.lastFlushAck = env.generation;
              stats.buffered = 0;
              ws?.sendPlayback({ generation: env.generation, consumedSamples: stats.consumed, bufferedSamples: 0, flushAck: env.generation });
            }
            break;
          case "state":
            audio?.setMuted(env.muted);
            if (env.connection === "open" && !env.muted) void startCaptureIfReady();
            if (env.connection === "closed" && wasOpen) stopCapture();
            break;
          default:
            break;
        }
        render();
      },
      onPcm(frame: PcmFrame) {
        if (audio) {
          audio.play(frame.generation, frame.pcm);
          return;
        }
        stats.generation = frame.generation;
        stats.consumed += frame.pcm.length;
        ws?.sendPlayback({ generation: frame.generation, consumedSamples: stats.consumed, bufferedSamples: 0 });
      },
      onError: (err) => showError(err.code, err.message, err.recoverable),
      onClose(ev) {
        stopCapture();
        if (ev.hadHello && state.connection !== "closed") {
          state = { ...state, connection: "closed", closeReason: "ws_closed", error: { code: "ws_closed", message: "브리지와의 연결이 끊어졌어요.", recoverable: false } };
          render();
        }
      },
    },
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bootPanel, { once: true });
else bootPanel();
