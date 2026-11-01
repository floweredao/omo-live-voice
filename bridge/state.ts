import type { AgentStatus, ConnectionState, InputState, OutputState } from "../shared/protocol.ts";

export type PendingQuestion = { readonly requestId: string; readonly options: readonly string[] };

export type Axes = {
  readonly connection: ConnectionState;
  readonly input: InputState;
  readonly agent: AgentStatus;
  readonly output: OutputState;
  readonly muted: boolean;
  readonly playbackGeneration: number;
  readonly captureGeneration: number;
  readonly pendingDelegationId: string | null;
  readonly pendingQuestion: PendingQuestion | null;
  readonly waitCueSent: boolean;
  // Reducer-owned latches, optional so callers can supply just the public axes.
  // The transcript owner supplies draftHeld when holding a confirm-mode draft.
  readonly draftHeld?: boolean;
  readonly outputEnded?: boolean;
  readonly bufferDrained?: boolean;
  readonly waitCueStarted?: boolean;
  readonly queuedCommentary?: readonly string[];
};

export const INITIAL_STATE: Axes = {
  connection: "closed", input: "quiet", agent: "idle", output: "idle",
  muted: false, playbackGeneration: 0, captureGeneration: 0,
  pendingDelegationId: null, pendingQuestion: null, waitCueSent: false,
};

export const HOLD = "사용자의 요청을 에이전트에 넘겼어요. 결과가 올 때까지 아무 말도 하지 마세요.";
export const WAIT_CUE = "아직 작업 중이에요.";
export const CAP_WARNING = "5분 후 음성 세션이 종료돼요. 필요하면 /voice로 다시 시작해요.";

export type TimerName = "ackWindow" | "settle" | "waitCue" | "confirm" | "handshake";
export type Event =
  | { readonly type: "start" | "live.started" | "speech.start" | "speech.end" }
  | { readonly type: "live.closed"; readonly reason: string }
  | { readonly type: "live.error"; readonly code: string }
  | { readonly type: "delegation.created"; readonly id: string; readonly offsetMs: number }
  | { readonly type: "utterance.committed"; readonly kind: "message" | "answer" | "cancel" }
  | { readonly type: "agent.accepted"; readonly accepted?: boolean }
  | { readonly type: "agent.working"; readonly tool?: string }
  | { readonly type: "agent.question"; readonly q: PendingQuestion; readonly content?: string }
  | { readonly type: "agent.answered" | "agent.cancelRequested" }
  | { readonly type: "agent.cancelDone"; readonly restore?: AgentStatus }
  | { readonly type: "agent.turnEnd" | "agent.end"; readonly content?: string }
  | { readonly type: "output.start" | "output.end" | "buffer.drained" | "interrupt" }
  | { readonly type: "flush.acked"; readonly gen: number }
  | { readonly type: "mute" | "unmute" | "panel.disconnected" | "stop" }
  | { readonly type: "guard.idle" | "guard.cap" | "guard.warn" | "timer.ackWindow" | "timer.waitCue" };

export type Effect =
  | { readonly type: "closeLive"; readonly reason: string }
  | { readonly type: "openLive" | "enableCapture" | "disableCapture" | "forwardUtterance" | "abortAgent" | "discardDraft" | "warnSpoken" }
  | { readonly type: "flushPlayback"; readonly gen: number }
  | { readonly type: "sendThinking" | "sendCommentary"; readonly content: string }
  | { readonly type: "notifyPanel"; readonly state: Axes }
  | { readonly type: "startTimer"; readonly name: TimerName; readonly ms: number }
  | { readonly type: "cancelTimer"; readonly name: TimerName }
  | { readonly type: "warn"; readonly event: Event["type"] };

export type TransitionResult = { readonly state: Axes; readonly effects: Effect[] };
type Reducer<E> = (state: Axes, event: E) => TransitionResult;

function matches<T extends Event["type"]>(event: Event, type: T): event is Event & { type: T } {
  return event.type === type;
}

function row<const N extends string, T extends Event["type"]>(
  name: N,
  type: T,
  when: (state: Axes, event: Event & { type: T }) => boolean,
  apply: Reducer<Event & { type: T }>,
) {
  return {
    name, type,
    run(state: Axes, event: Event): TransitionResult | undefined {
      // Intersection narrowing keeps the event payload typed at each table row.
      if (matches(event, type) && when(state, event)) return apply(state, event);
      return undefined;
    },
  };
}

function changed(state: Axes, patch: Partial<Axes>, effects: Effect[] = []): TransitionResult {
  return { state: { ...state, ...patch }, effects };
}

function interruptPlayback(state: Axes): TransitionResult {
  const gen = state.playbackGeneration + 1;
  return changed(state, { output: "interrupted", playbackGeneration: gen, outputEnded: false, bufferDrained: false },
    [{ type: "flushPlayback", gen }]);
}

function close(state: Axes, reason: string, closeSocket = true): TransitionResult {
  return changed(state, {
    connection: "closed", input: "quiet", output: "idle",
    playbackGeneration: state.playbackGeneration + 1, captureGeneration: state.captureGeneration + 1,
    draftHeld: false, outputEnded: false, bufferDrained: false, queuedCommentary: [],
    pendingDelegationId: null, waitCueSent: false, waitCueStarted: false,
  }, [
    { type: "disableCapture" }, { type: "flushPlayback", gen: state.playbackGeneration + 1 },
    { type: "discardDraft" },
    ...(["ackWindow", "settle", "waitCue", "confirm", "handshake"] as const)
      .map((name): Effect => ({ type: "cancelTimer", name })),
    ...(closeSocket ? [{ type: "closeLive" as const, reason }] : []),
  ]);
}

function busy(state: Axes): boolean {
  return state.agent === "working" || state.agent === "submitting" || state.agent === "question";
}

function cancel(state: Axes): TransitionResult {
  return changed(state, {
    ...(state.draftHeld ? { draftHeld: false } : {}),
    ...(busy(state) ? { agent: "cancelling" } : {}),
  }, [
    ...(state.draftHeld ? [{ type: "discardDraft" as const }, { type: "cancelTimer" as const, name: "confirm" as const }] : []),
    ...(busy(state) ? [{ type: "abortAgent" as const }] : []),
  ]);
}

function finish(state: Axes, content?: string): TransitionResult {
  return changed(state, {
    agent: "idle", pendingQuestion: null, pendingDelegationId: null, waitCueStarted: false,
    ...(content ? { queuedCommentary: [...(state.queuedCommentary ?? []), content] } : {}),
  }, [
    { type: "cancelTimer", name: "waitCue" }, { type: "cancelTimer", name: "ackWindow" },
    { type: "cancelTimer", name: "settle" },
  ]);
}

/** First matching row wins. Unknown state/event pairs do not change any axis. */
export const TRANSITIONS = [
  row("start.closed", "start", s => s.connection === "closed", s => changed(s, {
    connection: "connecting", input: "quiet", output: "idle",
    playbackGeneration: s.playbackGeneration + 1, captureGeneration: s.captureGeneration + 1,
    outputEnded: false, bufferDrained: false,
  }, [{ type: "openLive" }, { type: "startTimer", name: "handshake", ms: 10_000 }])),
  row("live.started", "live.started", s => s.connection === "connecting", s => changed(s, { connection: "open" },
    [{ type: "cancelTimer", name: "handshake" }, ...(!s.muted ? [{ type: "enableCapture" as const }] : [])])),
  row("live.closed", "live.closed", s => s.connection !== "closed", (s, e) => close(s, e.reason, false)),
  row("live.error", "live.error", s => s.connection !== "closed", (s, e) => close(s, e.code)),
  row("speech.start.speaking", "speech.start", s => s.connection === "open" && !s.muted && s.output === "speaking", s => {
    const result = interruptPlayback(s);
    return changed(result.state, { input: "speech" },
      [...result.effects, { type: "cancelTimer", name: "confirm" }]);
  }),
  row("speech.start.quiet", "speech.start", s => s.connection === "open" && !s.muted && s.input === "quiet",
    s => changed(s, { input: "speech" }, [{ type: "cancelTimer", name: "confirm" }])),
  row("speech.end", "speech.end", s => s.connection === "open" && s.input === "speech",
    s => changed(s, { input: "quiet" })),
  row("delegation.created", "delegation.created", (s, e) => s.connection === "open" && s.pendingDelegationId !== e.id,
    (s, e) => changed(s, { pendingDelegationId: e.id, waitCueSent: false, waitCueStarted: false }, [
      { type: "startTimer", name: "ackWindow", ms: 2500 }, { type: "startTimer", name: "settle", ms: 600 },
    ])),
  row("utterance.message.idle", "utterance.committed", (s, e) => s.connection === "open" && s.agent === "idle" && e.kind === "message",
    s => changed(s, { agent: "submitting" }, [{ type: "forwardUtterance" }])),
  row("utterance.message.busy", "utterance.committed", (s, e) => s.connection === "open" &&
    (s.agent === "submitting" || s.agent === "working") && e.kind === "message",
    s => ({ state: s, effects: [{ type: "forwardUtterance" }] })),
  row("utterance.answer.question", "utterance.committed", (s, e) => s.connection === "open" && s.agent === "question" && s.pendingQuestion !== null && e.kind === "answer",
    s => ({ state: s, effects: [{ type: "forwardUtterance" }] })),
  row("utterance.cancel.draft.busy", "utterance.committed", (s, e) => e.kind === "cancel" && !!s.draftHeld && busy(s), cancel),
  row("utterance.cancel.busy", "utterance.committed", (s, e) => e.kind === "cancel" && busy(s), cancel),
  row("utterance.cancel.draft", "utterance.committed", (s, e) => e.kind === "cancel" && !!s.draftHeld, cancel),
  row("utterance.cancel.idle", "utterance.committed", (s, e) => e.kind === "cancel" && s.agent === "idle",
    s => ({ state: s, effects: [{ type: "notifyPanel", state: s }] })),
  row("agent.accepted", "agent.accepted", (s, e) => s.agent === "submitting" && e.accepted !== false,
    s => changed(s, { agent: "working" })),
  row("agent.rejected", "agent.accepted", (s, e) => s.agent === "submitting" && e.accepted === false,
    s => finish(s)),
  row("agent.working.first", "agent.working", s => s.agent !== "cancelling" && !s.waitCueStarted && !s.waitCueSent,
    s => changed(s, { agent: "working", waitCueStarted: true },
      s.connection === "open" ? [{ type: "startTimer", name: "waitCue", ms: 12_000 }] : [])),
  row("agent.working.update", "agent.working", s => s.agent !== "cancelling",
    s => s.agent === "working" ? { state: s, effects: [] } : changed(s, { agent: "working" })),
  row("agent.question", "agent.question", (s, e) => s.agent !== "cancelling" && s.pendingQuestion?.requestId !== e.q.requestId,
    (s, e) => changed(s, { agent: "question", pendingQuestion: { requestId: e.q.requestId, options: [...e.q.options] },
      ...(e.content ? { queuedCommentary: [...(s.queuedCommentary ?? []), e.content] } : {}),
    })),
  row("agent.answered", "agent.answered", s => s.agent === "question",
    s => changed(s, { agent: "working", pendingQuestion: null })),
  row("agent.cancelRequested", "agent.cancelRequested", busy, cancel),
  row("agent.cancelDone", "agent.cancelDone", s => s.agent === "cancelling",
    (s, e) => e.restore && e.restore !== "idle"
      ? changed(s, { agent: e.restore }) : finish(s)),
  row("agent.turnEnd", "agent.turnEnd", s => s.agent !== "idle" || s.pendingQuestion !== null,
    (s, e) => finish(s, e.content)),
  row("agent.end", "agent.end", s => s.agent !== "idle" || s.pendingQuestion !== null || s.waitCueStarted === true,
    (s, e) => finish(s, e.content)),
  // output.start is normalized from transcript activity, NEVER continuous PCM deltas.
  row("output.start", "output.start", s => s.connection === "open" && s.input === "quiet" && s.output === "idle",
    s => changed(s, { output: "speaking", outputEnded: false, bufferDrained: false })),
  row("output.end.drained", "output.end", s => s.output === "speaking" && !!s.bufferDrained,
    s => changed(s, { output: "idle", outputEnded: true })),
  row("output.end.pending", "output.end", s => s.output === "speaking" && !s.outputEnded,
    s => changed(s, { outputEnded: true })),
  row("buffer.drained.ended", "buffer.drained", s => s.output === "speaking" && !!s.outputEnded,
    s => changed(s, { output: "idle", bufferDrained: true })),
  row("buffer.drained.pending", "buffer.drained", s => s.output === "speaking" && !s.bufferDrained,
    s => changed(s, { bufferDrained: true })),
  row("interrupt.speaking", "interrupt", s => s.output === "speaking", interruptPlayback),
  row("flush.acked.matching", "flush.acked", (s, e) => s.output === "interrupted" && e.gen === s.playbackGeneration,
    s => changed(s, { output: "idle", outputEnded: false, bufferDrained: false })),
  row("mute", "mute", s => !s.muted,
    s => changed(s, { muted: true, captureGeneration: s.captureGeneration + 1, input: "quiet" },
      [{ type: "disableCapture" }, { type: "cancelTimer", name: "confirm" }])),
  row("unmute", "unmute", s => s.muted,
    s => changed(s, { muted: false, captureGeneration: s.captureGeneration + 1 },
      s.connection === "open" ? [{ type: "enableCapture" }] : [])),
  row("panel.disconnected", "panel.disconnected", s => s.connection !== "closed", s => close(s, "panel.disconnected")),
  row("stop", "stop", s => s.connection !== "closed", s => close(s, "stop")),
  row("guard.idle", "guard.idle", s => s.connection !== "closed" && s.input === "quiet" && s.agent === "idle" && s.output === "idle",
    s => close(s, "idle")),
  row("guard.cap", "guard.cap", s => s.connection !== "closed", s => close(s, "cap")),
  row("guard.warn", "guard.warn", s => s.connection === "open",
    s => changed(s, { queuedCommentary: [...(s.queuedCommentary ?? []), CAP_WARNING] })),
  row("timer.ackWindow", "timer.ackWindow", s => s.connection === "open" && (s.agent === "working" || s.agent === "submitting"),
    s => ({ state: s, effects: [{ type: "sendThinking", content: HOLD }] })),
  row("timer.waitCue", "timer.waitCue", s => s.connection === "open" && s.agent === "working" && !s.waitCueSent,
    s => changed(s, { waitCueSent: true, queuedCommentary: [...(s.queuedCommentary ?? []), WAIT_CUE] })),
] as const;

/**
 * Pure reducer: the caller serializes events, executes effects, correlates timers
 * to the current delegation/session, and normalizes fatal/handshake errors.
 * Pass dev=true to request a data-only warning for unmatched pairs.
 */
export function transition(state: Axes, event: Event, dev = false): TransitionResult {
  for (const entry of TRANSITIONS) {
    const result = entry.run(state, event);
    if (!result) continue;
    const next = result.state;
    if (next.connection === "open" && next.input === "quiet" && next.output === "idle" && next.queuedCommentary?.length) {
      const settled = { ...next, queuedCommentary: [] };
      return {
        state: settled,
        effects: [
          ...result.effects, ...next.queuedCommentary.map((content): Effect => ({ type: "sendCommentary", content })),
          { type: "notifyPanel", state: settled },
        ],
      };
    }
    return {
      state: next,
      effects: next === state ? result.effects : [...result.effects, { type: "notifyPanel", state: next }],
    };
  }
  return { state, effects: dev ? [{ type: "warn", event: event.type }] : [] };
}
