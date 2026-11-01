// Wire types + PCM frame codec. Types and codec only; no behavior beyond that.

export type AgentStatus = "idle" | "submitting" | "working" | "question" | "cancelling";
export type ConnectionState = "closed" | "connecting" | "open";
export type InputState = "quiet" | "speech";
export type OutputState = "idle" | "speaking" | "interrupted";
export type ConfirmMode = "off" | "on";

export interface QuestionOption {
  label: string;
  description?: string;
}

/** extension -> bridge, stdio JSONL. */
export type ExtToBridge =
  | { type: "hello"; sessionId: string; sessionFile: string | null; cwd: string; title: string | null; qa: boolean }
  | { type: "agent.delta"; text: string }
  | { type: "agent.tool.start"; name: string }
  | { type: "agent.tool.end"; name: string; ok: boolean }
  | { type: "agent.turn.end" }
  | { type: "agent.end"; text: string }
  | { type: "agent.idle"; idle: boolean }
  | { type: "agent.question"; requestId: string; header: string; question: string; options: QuestionOption[] }
  | { type: "agent.question.closed"; requestId: string }
  | { type: "confirm"; mode: ConfirmMode }
  | { type: "resume" } // same-session /voice while the bridge runs: re-open Live session if closed, re-announce ready
  | { type: "stop" };

/** bridge -> extension, stdio JSONL. */
export type BridgeToExt =
  | { type: "ready"; port: number; token: string; panelUrl: string }
  | { type: "utterance"; id: string; text: string; kind: "message" | "cancel" | "answer"; requestId?: string; optionIndex?: number }
  | {
      type: "state";
      connection: ConnectionState;
      input: InputState;
      agent: AgentStatus;
      output: OutputState;
      muted: boolean;
      reason?: string;
    }
  | { type: "log"; level: "info" | "warn" | "error"; msg: string }
  | { type: "exit"; reason: string };

/** Panel <-> bridge WebSocket JSON envelope: {v:1, type, seq, ...}. */
export interface Envelope<T extends string> {
  v: 1;
  type: T;
  seq: number;
}

export type PanelHello = Envelope<"hello"> & {
  token: string;
  capabilities: { audioWorklet: boolean; setSinkId: boolean };
  sampleRate: number;
};
export type BridgeHello = Envelope<"hello"> & {
  sessionId: string;
  title: string | null;
  format: { rate: 24000; channels: 1 };
  limits: { idleMs: number; capMs: number; warnMs: number };
  qa: boolean;
  devices: { input?: string; output?: string }; // persisted labels
  confirmMode: ConfirmMode;
};
export type DevicesMsg = Envelope<"devices"> & {
  inputs: { id: string; label: string }[];
  outputs: { id: string; label: string }[];
  selected: { input?: string; output?: string };
};
export type ControlMsg = Envelope<"control"> & {
  action: "mute" | "unmute" | "stop" | "resume" | "confirm" | "discard";
};
export type StateMsg = Envelope<"state"> & {
  connection: ConnectionState;
  input: InputState;
  agent: AgentStatus;
  output: OutputState;
  muted: boolean;
  reason?: string;
};
export type TranscriptMsg = Envelope<"transcript"> & {
  speaker: "user" | "assistant";
  utteranceId: string;
  revision: number;
  text: string;
  final: boolean;
  interrupted: boolean;
};
export type AgentMsg = Envelope<"agent"> & {
  status: AgentStatus;
  tool?: string;
  question?: { header: string; question: string; options: string[] };
};
export type DraftMsg = Envelope<"draft"> & {
  draftId: string;
  text: string;
  status: "held" | "sent" | "discarded";
};
export type CostMsg = Envelope<"cost"> & {
  connectedMs: number;
  cumulativeMs: number;
  estimatedUsd: number;
};
export type FlushMsg = Envelope<"flush"> & {
  generation: number;
  reason: "barge-in" | "stop" | "mute";
};
export type PlaybackMsg = Envelope<"playback"> & {
  generation: number;
  consumedSamples: number;
  bufferedSamples: number;
  flushAck?: number;
};
export type ErrorMsg = Envelope<"error"> & {
  code: string;
  message: string;
  recoverable: boolean;
};

export type PanelToBridge = PanelHello | DevicesMsg | ControlMsg | PlaybackMsg;
export type BridgeToPanel =
  | BridgeHello
  | StateMsg
  | TranscriptMsg
  | AgentMsg
  | DraftMsg
  | CostMsg
  | FlushMsg
  | ErrorMsg;

/** Estimated Live API cost: USD 0.05 per connected minute. */
export function estimatedUsd(cumulativeMs: number): number {
  return (cumulativeMs / 60000) * 0.05;
}

// ---- binary PCM frames: u32le generation | u32le sequence | PCM16LE ----
export const FRAME_HEADER_BYTES = 8;
export const MAX_FRAME_SAMPLES = 2400;
export const MAX_FRAME_PAYLOAD_BYTES = MAX_FRAME_SAMPLES * 2;

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameError";
  }
}

export function encodeFrame(generation: number, sequence: number, pcm: Int16Array): ArrayBuffer {
  if (pcm.length > MAX_FRAME_SAMPLES) {
    throw new FrameError(`payload ${pcm.length} samples exceeds ${MAX_FRAME_SAMPLES}`);
  }
  const out = new ArrayBuffer(FRAME_HEADER_BYTES + pcm.length * 2);
  const view = new DataView(out);
  view.setUint32(0, generation >>> 0, true);
  view.setUint32(4, sequence >>> 0, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(FRAME_HEADER_BYTES + i * 2, pcm[i]!, true);
  return out;
}

export function decodeFrame(buf: ArrayBuffer): { generation: number; sequence: number; pcm: Int16Array } {
  if (buf.byteLength < FRAME_HEADER_BYTES) throw new FrameError(`frame too short: ${buf.byteLength} bytes`);
  const payload = buf.byteLength - FRAME_HEADER_BYTES;
  if (payload % 2 !== 0) throw new FrameError(`odd payload length: ${payload} bytes`);
  if (payload > MAX_FRAME_PAYLOAD_BYTES) throw new FrameError(`payload ${payload} bytes exceeds ${MAX_FRAME_PAYLOAD_BYTES}`);
  const view = new DataView(buf);
  const pcm = new Int16Array(payload / 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(FRAME_HEADER_BYTES + i * 2, true);
  return { generation: view.getUint32(0, true), sequence: view.getUint32(4, true), pcm };
}
