// Panel <-> bridge WebSocket transport: JSON envelopes and binary PCM frames from shared/protocol.ts. No DOM.
import {
  decodeFrame,
  encodeFrame,
  type BridgeToPanel,
  type ControlMsg,
  type DevicesMsg,
  type PanelHello,
  type PanelToBridge,
  type PlaybackMsg,
} from "../shared/protocol.ts";

export const HANDSHAKE_REFUSED_KO = "브리지에 연결하지 못했어요. 인증 토큰이 올바르지 않거나 브리지가 실행 중이 아니에요.";

export interface PcmFrame {
  generation: number;
  sequence: number;
  pcm: Int16Array;
}

export interface PanelWsHandlers {
  onEnvelope(env: BridgeToPanel): void;
  onPcm(frame: PcmFrame): void;
  onError?(err: { code: string; message: string; recoverable: boolean }): void;
  onClose?(ev: { code: number; reason: string; hadHello: boolean }): void;
}

export interface ConnectWsOptions {
  port: string | number;
  token: string;
  capabilities: PanelHello["capabilities"];
  sampleRate: number;
  handlers: PanelWsHandlers;
  WebSocketImpl?: typeof WebSocket;
}

export interface PanelWsClient {
  readonly url: string;
  sendControl(action: ControlMsg["action"]): boolean;
  sendDevices(inputs: DevicesMsg["inputs"], outputs: DevicesMsg["outputs"], selected: DevicesMsg["selected"]): boolean;
  sendPlayback(report: Omit<PlaybackMsg, "v" | "type" | "seq">): boolean;
  sendPcm(generation: number, sequence: number, pcm: Int16Array): boolean;
  close(code?: number, reason?: string): void;
}

type Outbound =
  | Omit<PanelHello, "v" | "seq">
  | Omit<DevicesMsg, "v" | "seq">
  | Omit<ControlMsg, "v" | "seq">
  | Omit<PlaybackMsg, "v" | "seq">;

export function buildWsUrl(port: string | number, token: string): string {
  return `ws://127.0.0.1:${String(port)}/ws?token=${encodeURIComponent(token)}`;
}

function isEnvelope(value: unknown): value is BridgeToPanel {
  const v = value as { v?: unknown; type?: unknown; seq?: unknown } | null;
  return typeof v === "object" && v !== null && v.v === 1 && typeof v.type === "string" && typeof v.seq === "number";
}

export function connectPanelWs(opts: ConnectWsOptions): PanelWsClient {
  const WS = opts.WebSocketImpl ?? WebSocket;
  const url = buildWsUrl(opts.port, opts.token);
  const ws = new WS(url);
  ws.binaryType = "arraybuffer";
  const { handlers } = opts;

  let seq = 0;
  let hadHello = false;
  let sawServerError = false;

  const send = (body: Outbound): boolean => {
    if (ws.readyState !== WS.OPEN) return false;
    const msg: PanelToBridge = { ...body, v: 1, seq: ++seq };
    ws.send(JSON.stringify(msg));
    return true;
  };

  ws.addEventListener("open", () => {
    send({ type: "hello", token: opts.token, capabilities: opts.capabilities, sampleRate: opts.sampleRate });
  });

  ws.addEventListener("message", (ev: MessageEvent) => {
    if (typeof ev.data === "string") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        handlers.onError?.({ code: "bad_envelope", message: "브리지 응답을 해석할 수 없어요.", recoverable: true });
        return;
      }
      if (!isEnvelope(parsed)) return;
      if (parsed.type === "hello") hadHello = true;
      if (parsed.type === "error") sawServerError = true;
      handlers.onEnvelope(parsed);
      return;
    }
    if (!(ev.data instanceof ArrayBuffer)) return;
    try {
      handlers.onPcm(decodeFrame(ev.data));
    } catch {
      handlers.onError?.({ code: "bad_frame", message: "오디오 데이터를 읽지 못했어요.", recoverable: true });
    }
  });

  ws.addEventListener("close", (ev: CloseEvent) => {
    if (!hadHello && !sawServerError) {
      sawServerError = true;
      handlers.onError?.({ code: "unauthorized", message: HANDSHAKE_REFUSED_KO, recoverable: false });
    }
    handlers.onClose?.({ code: ev.code, reason: ev.reason, hadHello });
  });

  return {
    url,
    sendControl: (action) => send({ type: "control", action }),
    sendDevices: (inputs, outputs, selected) => send({ type: "devices", inputs, outputs, selected }),
    sendPlayback: (report) => send({ type: "playback", ...report }),
    sendPcm(generation, sequence, pcm) {
      if (ws.readyState !== WS.OPEN) return false;
      ws.send(encodeFrame(generation, sequence, pcm));
      return true;
    },
    close(code = 1000, reason = "panel_closed") {
      if (ws.readyState === WS.OPEN || ws.readyState === WS.CONNECTING) ws.close(code, reason);
    },
  };
}
