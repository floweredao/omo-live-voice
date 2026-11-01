// Pure view-model for the voice panel: envelope reducer and formatting helpers. No DOM, no I/O.
import type {
  AgentStatus,
  BridgeToPanel,
  ConfirmMode,
  ConnectionState,
  DevicesMsg,
  InputState,
  OutputState,
} from "../shared/protocol.ts";

export interface UtteranceEntry {
  utteranceId: string;
  revision: number;
  text: string;
  final: boolean;
  interrupted: boolean;
}

export interface DeviceOption {
  id: string;
  label: string;
}

export interface QuestionView {
  header: string;
  question: string;
  options: string[];
}

export interface DraftView {
  draftId: string;
  text: string;
}

export interface ErrorView {
  code: string;
  message: string;
  recoverable: boolean;
}

export interface PanelViewState {
  sessionId: string;
  title: string | null;
  connection: ConnectionState;
  input: InputState;
  agent: AgentStatus;
  agentTool: string | null;
  output: OutputState;
  muted: boolean;
  closeReason: string | null;
  confirmMode: ConfirmMode;
  qa: boolean;
  persistedDeviceLabels: { input?: string; output?: string };
  userCaptions: UtteranceEntry[];
  assistantCaptions: UtteranceEntry[];
  question: QuestionView | null;
  draft: DraftView | null;
  error: ErrorView | null;
  connectedMs: number;
  cumulativeMs: number;
  estimatedUsd: number;
  flushGeneration: number | null;
}

export const MAX_UTTERANCES = 20;

const ERROR_KO: Record<string, string> = {
  unauthorized: "인증에 실패했어요. 패널 주소의 토큰이 올바르지 않아요.",
  panel_taken: "다른 음성 패널이 이미 연결되어 있어요.",
  bad_envelope: "브리지가 요청 형식을 거부했어요.",
  bad_frame: "오디오 프레임 형식이 올바르지 않아요.",
  hello_required: "연결 초기화가 필요해요.",
  live_start_failed: "음성 세션을 시작하지 못했어요.",
  live_dropped: "음성 서버 연결이 끊어졌어요.",
  live_unavailable: "음성 연결이 끊겨 다시 연결하지 못했어요. 다시 시작해 주세요.",
  live_error: "음성 서버 오류가 발생했어요.",
  question_speech_timeout: "질문을 읽지 못했어요. 화면을 확인해 주세요.",
  answer_on_screen: "화면에서 답해 주세요.",
};

const ERROR_DETAIL_KO: Record<string, string> = {
  "bad token": "인증 토큰 불일치",
  "another panel": "다른 패널 연결됨",
  "another panel is already connected": "다른 패널 연결됨",
  "invalid JSON": "형식 오류",
  "send hello first": "초기화 필요",
  "undecodable binary frame": "오디오 프레임 오류",
  connect: "연결 실패",
  invalid_value: "설정 거부",
  cedar_rejected: "음성 설정 거부",
  "Live connection dropped": "연결 끊김",
  unknown: "알 수 없는 오류",
  rate_limit: "요청 한도 초과",
  server_error: "서버 오류",
  invalid_request_error: "잘못된 요청",
  moderation: "안전 정책 제한",
};

const TOOL_KO: Record<string, string> = {
  bash: "명령 실행",
  read: "파일 읽기",
  edit: "파일 수정",
  write: "파일 쓰기",
  grep: "내용 검색",
  glob: "파일 찾기",
  eval: "코드 실행",
  task: "작업 위임",
  todo: "할 일 정리",
  web_search: "웹 검색",
  webfetch: "웹 문서 읽기",
  memory: "기억 저장",
  ask_user_question: "질문 확인",
  voice_start: "음성 시작",
};

const REASON_KO: Record<string, string> = {
  idle: "대기 시간 초과",
  cap: "시간 한도 도달",
  stop: "종료됨",
  "panel.disconnected": "패널 연결 끊김",
  ws_closed: "브리지 연결 끊김",
  live_dropped: "서버 연결 끊김",
  handshake_timeout: "연결 시간 초과",
  live_start_failed: "시작 실패",
  cedar_rejected: "음성 설정 거부",
  close_requested: "연결 종료",
  closed: "연결 종료",
};

const GUARD_REASONS = new Set(["idle", "cap"]);

/** Korean user-facing text for a bridge error; messages already in Korean pass through. */
export function formatErrorKo(code: string, message: string): string {
  if (/[가-힣]/.test(message)) return message;
  const base = ERROR_KO[code];
  const detail = ERROR_DETAIL_KO[message] ?? ERROR_DETAIL_KO[code];
  if (base) return detail ? `${base} (${detail})` : base;
  return detail ? `오류가 발생했어요 (${detail})` : "오류가 발생했어요.";
}

export const QUESTION_HINT_KO = "질문은 OmO 화면에서 선택해 주세요.";

/** True when the bridge WebSocket itself is disconnected and manual reconnect should be offered. */
export function isBridgeDisconnected(s: Pick<PanelViewState, "connection" | "closeReason">): boolean {
  return s.connection === "closed" && s.closeReason === "ws_closed";
}

/** True when the Live session closed due to an idle/cap guard and can be resumed from the panel. */
export function isGuardClosed(s: Pick<PanelViewState, "connection" | "closeReason">): boolean {
  return s.connection === "closed" && s.closeReason !== null && GUARD_REASONS.has(s.closeReason);
}

/** Control button enablement and primary hierarchy across live, guard-paused, and bridge-disconnected states. */
export function controlButtonStates(s: Pick<PanelViewState, "connection" | "closeReason">): {
  muteDisabled: boolean;
  resumeDisabled: boolean;
  resumePrimary: boolean;
  stopDisabled: boolean;
} {
  const disconnected = isBridgeDisconnected(s);
  const canResume = s.connection === "closed" && !disconnected;
  return {
    muteDisabled: s.connection !== "open",
    resumeDisabled: !canResume,
    resumePrimary: canResume,
    stopDisabled: disconnected,
  };
}

/** Label for the resume control, including cumulative cost when guard-closed or paused with recorded usage. */
export function resumeButtonText(s: Pick<PanelViewState, "connection" | "closeReason" | "cumulativeMs" | "estimatedUsd">): string {
  if (isGuardClosed(s) || (s.connection === "closed" && !isBridgeDisconnected(s) && s.cumulativeMs > 0)) {
    return `재개 (${formatCost(s.cumulativeMs, s.estimatedUsd)})`;
  }
  return "재개";
}

/** Structured reason and cost segments for the guard-close banner so the cost segment can stay no-wrap. */
export function guardCloseBannerParts(
  s: Pick<PanelViewState, "connection" | "closeReason" | "cumulativeMs" | "estimatedUsd">,
): { reason: string; cost: string } | null {
  if (!isGuardClosed(s)) return null;
  const why = s.closeReason ? REASON_KO[s.closeReason] ?? "일시정지" : "일시정지";
  return {
    reason: `${why}로 음성 세션이 일시정지되었어요 · `,
    cost: `누적 ${formatCost(s.cumulativeMs, s.estimatedUsd)}`,
  };
}

/** Korean summary banner when a guard closes the Live session, showing reason and cumulative cost so far. */
export function guardCloseBannerText(s: Pick<PanelViewState, "connection" | "closeReason" | "cumulativeMs" | "estimatedUsd">): string {
  const parts = guardCloseBannerParts(s);
  return parts ? `${parts.reason}${parts.cost}` : "";
}

export function initialViewState(): PanelViewState {
  return {
    sessionId: "",
    title: null,
    connection: "connecting",
    input: "quiet",
    agent: "idle",
    agentTool: null,
    output: "idle",
    muted: false,
    closeReason: null,
    confirmMode: "off",
    qa: false,
    persistedDeviceLabels: {},
    userCaptions: [],
    assistantCaptions: [],
    question: null,
    draft: null,
    error: null,
    connectedMs: 0,
    cumulativeMs: 0,
    estimatedUsd: 0,
    flushGeneration: null,
  };
}

/** Revision-replace by utteranceId (older revisions are ignored), keeping the last `cap` entries. */
export function upsertUtterance(list: readonly UtteranceEntry[], incoming: UtteranceEntry, cap = MAX_UTTERANCES): UtteranceEntry[] {
  const idx = list.findIndex((u) => u.utteranceId === incoming.utteranceId);
  if (idx >= 0) {
    if (incoming.revision < list[idx]!.revision) return [...list];
    const next = [...list];
    next[idx] = incoming;
    return next;
  }
  const next = [...list, incoming];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export type StateBadgeKey = "connecting" | "listening" | "speaking" | "paused";

export function stateBadgeKey(s: Pick<PanelViewState, "connection" | "output" | "muted">): StateBadgeKey {
  if (s.connection === "connecting") return "connecting";
  if (s.connection === "closed" || s.muted) return "paused";
  if (s.output === "speaking") return "speaking";
  return "listening";
}

/** `연결 중` / `듣는 중` / `말하는 중` / `일시정지` (+ ` · 무음` when muted, ` · <reason>` when closed). */
export function stateBadgeText(s: Pick<PanelViewState, "connection" | "output" | "muted" | "closeReason">): string {
  switch (stateBadgeKey(s)) {
    case "connecting":
      return "연결 중";
    case "listening":
      return "듣는 중";
    case "speaking":
      return "말하는 중";
    case "paused": {
      if (s.connection === "closed") {
        const why = s.closeReason ? REASON_KO[s.closeReason] : undefined;
        return why ? `일시정지 · ${why}` : "일시정지";
      }
      return "일시정지 · 무음";
    }
  }
}

/** `에이전트 작업 중: <tool>` / `질문 대기`; empty when idle (badge hidden). */
export function agentBadgeText(s: Pick<PanelViewState, "agent" | "agentTool">): string {
  switch (s.agent) {
    case "idle":
      return "";
    case "question":
      return "질문 대기";
    case "cancelling":
      return "에이전트 취소 중";
    case "submitting":
    case "working":
      return s.agentTool ? `에이전트 작업 중: ${s.agentTool}` : "에이전트 작업 중";
  }
}

/** `mm:ss · 예상 $x.xx` from the cumulative connected time and the bridge's estimate. */
export function formatCost(cumulativeMs: number, usd: number): string {
  const totalSec = Number.isFinite(cumulativeMs) && cumulativeMs > 0 ? Math.floor(cumulativeMs / 1000) : 0;
  const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");
  const safeUsd = Number.isFinite(usd) && usd > 0 ? usd : 0;
  return `${mm}:${ss} · 예상 $${safeUsd.toFixed(2)}`;
}

/** Device ids whose labels match the bridge-persisted labels; unmatched sides are left to the browser default. */
export function resolvePersistedDevices(
  inputs: readonly DeviceOption[],
  outputs: readonly DeviceOption[],
  persisted: { input?: string; output?: string },
): { input?: string; output?: string } {
  const input = persisted.input ? inputs.find((d) => d.label === persisted.input)?.id : undefined;
  const output = persisted.output ? outputs.find((d) => d.label === persisted.output)?.id : undefined;
  return { ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}) };
}

/** The `devices` envelope the bridge persists (it maps the selected ids back to labels). */
export function serializeDevicesMsg(
  seq: number,
  inputs: readonly DeviceOption[],
  outputs: readonly DeviceOption[],
  selected: { input?: string; output?: string },
): DevicesMsg {
  return {
    v: 1,
    type: "devices",
    seq,
    inputs: inputs.map((d) => ({ id: d.id, label: d.label })),
    outputs: outputs.map((d) => ({ id: d.id, label: d.label })),
    selected: { ...(selected.input ? { input: selected.input } : {}), ...(selected.output ? { output: selected.output } : {}) },
  };
}

export function applyEnvelope(state: PanelViewState, env: BridgeToPanel): PanelViewState {
  switch (env.type) {
    case "hello":
      return {
        ...state,
        sessionId: env.sessionId,
        title: env.title,
        qa: env.qa,
        confirmMode: env.confirmMode,
        persistedDeviceLabels: { ...env.devices },
      };
    case "state":
      return {
        ...state,
        connection: env.connection,
        input: env.input,
        agent: env.agent,
        agentTool: env.agent === "idle" ? null : state.agentTool,
        output: env.output,
        muted: env.muted,
        closeReason: env.connection === "closed" ? env.reason ?? state.closeReason : null,
        question: env.agent === "question" ? state.question : null,
        draft: env.connection === "closed" ? null : state.draft,
      };
    case "transcript": {
      const entry: UtteranceEntry = {
        utteranceId: env.utteranceId,
        revision: env.revision,
        text: env.text,
        final: env.final,
        interrupted: env.interrupted,
      };
      return env.speaker === "user"
        ? { ...state, userCaptions: upsertUtterance(state.userCaptions, entry) }
        : { ...state, assistantCaptions: upsertUtterance(state.assistantCaptions, entry) };
    }
    case "agent": {
      const question =
        env.status !== "question"
          ? null
          : env.question
            ? { header: env.question.header, question: env.question.question, options: [...env.question.options] }
            : state.question;
      return {
        ...state,
        agent: env.status,
        agentTool: env.status === "idle" ? null : env.tool ?? state.agentTool,
        question,
      };
    }
    case "draft":
      return { ...state, draft: env.status === "held" ? { draftId: env.draftId, text: env.text } : null };
    case "cost":
      return { ...state, connectedMs: env.connectedMs, cumulativeMs: env.cumulativeMs, estimatedUsd: env.estimatedUsd };
    case "flush":
      return { ...state, flushGeneration: env.generation };
    case "error":
      return { ...state, error: { code: env.code, message: formatErrorKo(env.code, env.message), recoverable: env.recoverable } };
  }
}
