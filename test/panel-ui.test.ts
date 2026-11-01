import { describe, expect, test } from "bun:test";
import type { BridgeToPanel } from "../shared/protocol.ts";
import { decodeFrame, encodeFrame } from "../shared/protocol.ts";
import {
  MAX_UTTERANCES,
  agentBadgeText,
  applyEnvelope,
  formatCost,
  initialViewState,
  resolvePersistedDevices,
  serializeDevicesMsg,
  stateBadgeText,
  type PanelViewState,
} from "../panel/viewmodel.ts";
import { HANDSHAKE_REFUSED_KO, buildWsUrl, connectPanelWs } from "../panel/ws.ts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Body = DistributiveOmit<BridgeToPanel, "v" | "seq">;

let seq = 0;
const env = (body: Body): BridgeToPanel => ({ ...body, v: 1, seq: ++seq }) as BridgeToPanel;
const stateEnv = (over: Partial<Omit<Extract<Body, { type: "state" }>, "type">>) =>
  env({ type: "state", connection: "open", input: "quiet", agent: "idle", output: "idle", muted: false, ...over });
const transcript = (speaker: "user" | "assistant", utteranceId: string, revision: number, text: string, final = false) =>
  env({ type: "transcript", speaker, utteranceId, revision, text, final, interrupted: false });

class FakeWs {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static instances: FakeWs[] = [];
  readyState = FakeWs.OPEN;
  binaryType = "blob";
  sent: (string | ArrayBuffer)[] = [];
  private listeners = new Map<string, ((ev: unknown) => void)[]>();
  constructor(readonly url: string) {
    FakeWs.instances.push(this);
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  emit(type: string, ev: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
}
const WsStub = FakeWs as unknown as typeof WebSocket;

describe("panel/viewmodel", () => {
  test("transcript: revision replaces by utteranceId, stale revisions are ignored, last 20 kept per speaker", () => {
    let s = applyEnvelope(initialViewState(), transcript("user", "u-1", 1, "현재 폴더"));
    s = applyEnvelope(s, transcript("user", "u-1", 2, "현재 폴더의 파일 목록을 보여줘", true));
    expect(s.userCaptions).toEqual([{ utteranceId: "u-1", revision: 2, text: "현재 폴더의 파일 목록을 보여줘", final: true, interrupted: false }]);

    s = applyEnvelope(s, transcript("user", "u-1", 1, "과거 텍스트"));
    expect(s.userCaptions[0]!.text).toBe("현재 폴더의 파일 목록을 보여줘");

    for (let i = 2; i <= 25; i++) s = applyEnvelope(s, transcript("user", `u-${i}`, 1, `발화 ${i}`, true));
    expect(s.userCaptions).toHaveLength(MAX_UTTERANCES);
    expect(s.userCaptions[0]!.utteranceId).toBe("u-6");
    expect(s.userCaptions.at(-1)!.utteranceId).toBe("u-25");

    s = applyEnvelope(s, transcript("assistant", "a-1", 1, "파일이 세 개 있어요.", true));
    expect(s.assistantCaptions.map((u) => u.text)).toEqual(["파일이 세 개 있어요."]);
    expect(s.userCaptions).toHaveLength(MAX_UTTERANCES);
  });

  test("state badge: 연결 중 / 듣는 중 / 말하는 중 / 일시정지 with 무음 and close reason", () => {
    let s = initialViewState();
    expect(stateBadgeText(s)).toBe("연결 중");
    s = applyEnvelope(s, stateEnv({}));
    expect(stateBadgeText(s)).toBe("듣는 중");
    s = applyEnvelope(s, stateEnv({ output: "speaking" }));
    expect(stateBadgeText(s)).toBe("말하는 중");
    s = applyEnvelope(s, stateEnv({ output: "speaking", muted: true }));
    expect(stateBadgeText(s)).toBe("일시정지 · 무음");
    s = applyEnvelope(s, stateEnv({ connection: "closed", reason: "idle" }));
    expect(stateBadgeText(s)).toBe("일시정지 · 대기 시간 초과");
    expect(s.closeReason).toBe("idle");
    s = applyEnvelope(s, stateEnv({ connection: "connecting" }));
    expect(stateBadgeText(s)).toBe("연결 중");
    expect(s.closeReason).toBeNull();
  });

  test("agent badge and question card follow agent/state envelopes", () => {
    let s = initialViewState();
    expect(agentBadgeText(s)).toBe("");
    s = applyEnvelope(s, env({ type: "agent", status: "working", tool: "bash" }));
    expect(agentBadgeText(s)).toBe("에이전트 작업 중: bash");
    s = applyEnvelope(s, stateEnv({ agent: "working" }));
    expect(agentBadgeText(s)).toBe("에이전트 작업 중: bash");

    const question = { header: "배포 대상", question: "어느 환경에 배포할까요?", options: ["스테이징", "프로덕션"] };
    s = applyEnvelope(s, env({ type: "agent", status: "question", question }));
    s = applyEnvelope(s, stateEnv({ agent: "question" }));
    expect(agentBadgeText(s)).toBe("질문 대기");
    expect(s.question).toEqual(question);

    s = applyEnvelope(s, env({ type: "agent", status: "working" }));
    expect(s.question).toBeNull();
    expect(agentBadgeText(s)).toBe("에이전트 작업 중: bash");
    s = applyEnvelope(s, env({ type: "agent", status: "idle" }));
    expect(agentBadgeText(s)).toBe("");
    expect(s.agentTool).toBeNull();
  });

  test("cost: mm:ss · 예상 $x.xx", () => {
    expect(formatCost(0, 0)).toBe("00:00 · 예상 $0.00");
    expect(formatCost(65_400, 0.0545)).toBe("01:05 · 예상 $0.05");
    expect(formatCost(3_600_000, 3)).toBe("60:00 · 예상 $3.00");
    expect(formatCost(Number.NaN, -1)).toBe("00:00 · 예상 $0.00");
    const s = applyEnvelope(initialViewState(), env({ type: "cost", connectedMs: 120_000, cumulativeMs: 185_000, estimatedUsd: 0.154 }));
    expect(formatCost(s.cumulativeMs, s.estimatedUsd)).toBe("03:05 · 예상 $0.15");
  });

  test("devices: hello labels resolve to ids and serialize as the bridge's devices envelope", () => {
    const s = applyEnvelope(
      initialViewState(),
      env({
        type: "hello",
        sessionId: "sess-1",
        title: "테스트 세션",
        format: { rate: 24000, channels: 1 },
        limits: { idleMs: 180000, capMs: 3600000, warnMs: 3300000 },
        qa: true,
        devices: { input: "외장 USB 마이크", output: "스튜디오 헤드폰" },
        confirmMode: "off",
      }),
    );
    expect(s.persistedDeviceLabels).toEqual({ input: "외장 USB 마이크", output: "스튜디오 헤드폰" });
    const inputs = [{ id: "mic-1", label: "내장 마이크" }, { id: "mic-2", label: "외장 USB 마이크" }];
    const outputs = [{ id: "spk-1", label: "내장 스피커" }];
    expect(resolvePersistedDevices(inputs, outputs, s.persistedDeviceLabels)).toEqual({ input: "mic-2" });
    expect(serializeDevicesMsg(7, inputs, outputs, { input: "mic-2" })).toEqual({
      v: 1,
      type: "devices",
      seq: 7,
      inputs,
      outputs,
      selected: { input: "mic-2" },
    });
  });

  test("draft shows only while held; errors get Korean copy; closing clears the draft", () => {
    let s = applyEnvelope(initialViewState(), env({ type: "draft", draftId: "d-1", text: "테스트를 실행해 줘", status: "held" }));
    expect(s.draft).toEqual({ draftId: "d-1", text: "테스트를 실행해 줘" });
    s = applyEnvelope(s, env({ type: "draft", draftId: "d-1", text: "테스트를 실행해 줘", status: "sent" }));
    expect(s.draft).toBeNull();
    s = applyEnvelope(s, env({ type: "draft", draftId: "d-2", text: "다시", status: "held" }));
    s = applyEnvelope(s, stateEnv({ connection: "closed", reason: "stop" }));
    expect(s.draft).toBeNull();

    s = applyEnvelope(s, env({ type: "error", code: "unauthorized", message: "bad token", recoverable: false }));
    expect(s.error!.message).toContain("인증");
    expect(s.error!.message).toContain("bad token");
    s = applyEnvelope(s, env({ type: "error", code: "answer_on_screen", message: "화면에서 답해 주세요", recoverable: true }));
    expect(s.error).toEqual({ code: "answer_on_screen", message: "화면에서 답해 주세요", recoverable: true });
    s = applyEnvelope(s, env({ type: "error", code: "weird_code", message: "", recoverable: true }));
    expect(s.error!.message).toBe("오류가 발생했어요 (weird_code)");
  });
});

describe("panel/ws", () => {
  test("hello carries token, capabilities and sampleRate; envelopes and PCM frames round-trip", () => {
    expect(buildWsUrl(47831, "a b")).toBe("ws://127.0.0.1:47831/ws?token=a%20b");
    const envelopes: BridgeToPanel[] = [];
    const frames: { generation: number; sequence: number; pcm: Int16Array }[] = [];
    const errors: { code: string; recoverable: boolean }[] = [];
    const client = connectPanelWs({
      port: "47831",
      token: "tok-123",
      capabilities: { audioWorklet: true, setSinkId: false },
      sampleRate: 48000,
      WebSocketImpl: WsStub,
      handlers: { onEnvelope: (e) => void envelopes.push(e), onPcm: (f) => void frames.push(f), onError: (e) => void errors.push({ code: e.code, recoverable: e.recoverable }) },
    });
    const ws = FakeWs.instances.at(-1)!;
    expect(ws.url).toBe("ws://127.0.0.1:47831/ws?token=tok-123");
    expect(ws.binaryType).toBe("arraybuffer");

    ws.emit("open", {});
    expect(JSON.parse(String(ws.sent[0]))).toEqual({
      v: 1,
      type: "hello",
      seq: 1,
      token: "tok-123",
      capabilities: { audioWorklet: true, setSinkId: false },
      sampleRate: 48000,
    });
    expect(client.sendControl("mute")).toBe(true);
    expect(JSON.parse(String(ws.sent[1]))).toEqual({ v: 1, type: "control", seq: 2, action: "mute" });
    expect(client.sendPlayback({ generation: 3, consumedSamples: 2400, bufferedSamples: 0, flushAck: 3 })).toBe(true);
    expect(JSON.parse(String(ws.sent[2]))).toMatchObject({ type: "playback", seq: 3, generation: 3, flushAck: 3 });
    expect(client.sendPcm(2, 5, new Int16Array([10, -10]))).toBe(true);
    expect(decodeFrame(ws.sent[3] as ArrayBuffer)).toEqual({ generation: 2, sequence: 5, pcm: new Int16Array([10, -10]) });

    ws.emit("message", { data: JSON.stringify({ v: 1, type: "cost", seq: 9, connectedMs: 1, cumulativeMs: 2, estimatedUsd: 0 }) });
    ws.emit("message", { data: JSON.stringify({ v: 2, type: "cost", seq: 10 }) });
    ws.emit("message", { data: encodeFrame(4, 9, new Int16Array([42])) });
    ws.emit("message", { data: "not json" });
    ws.emit("message", { data: new Uint8Array(3).buffer });
    expect(envelopes.map((e) => e.type)).toEqual(["cost"]);
    expect(frames).toEqual([{ generation: 4, sequence: 9, pcm: new Int16Array([42]) }]);
    expect(errors).toEqual([{ code: "bad_envelope", recoverable: true }, { code: "bad_frame", recoverable: true }]);

    ws.close();
    expect(client.sendControl("stop")).toBe(false);
  });

  test("handshake refused before hello -> one unauthorized error; a server error envelope is never overwritten", () => {
    const connect = () => {
      const errors: { code: string; message: string; recoverable: boolean }[] = [];
      const closes: { code: number; reason: string; hadHello: boolean }[] = [];
      connectPanelWs({
        port: 1,
        token: "wrong",
        capabilities: { audioWorklet: false, setSinkId: false },
        sampleRate: 24000,
        WebSocketImpl: WsStub,
        handlers: { onEnvelope: () => undefined, onPcm: () => undefined, onError: (e) => void errors.push(e), onClose: (c) => void closes.push(c) },
      });
      return { ws: FakeWs.instances.at(-1)!, errors, closes };
    };

    const refused = connect();
    refused.ws.emit("close", { code: 1006, reason: "" });
    expect(refused.errors).toEqual([{ code: "unauthorized", message: HANDSHAKE_REFUSED_KO, recoverable: false }]);
    expect(refused.errors[0]!.message).toContain("인증");
    expect(refused.closes).toEqual([{ code: 1006, reason: "", hadHello: false }]);

    const taken = connect();
    taken.ws.emit("message", { data: JSON.stringify({ v: 1, type: "error", seq: 1, code: "panel_taken", message: "another panel", recoverable: false }) });
    taken.ws.emit("close", { code: 4409, reason: "panel_taken" });
    expect(taken.errors).toEqual([]);
    expect(taken.closes).toEqual([{ code: 4409, reason: "panel_taken", hadHello: false }]);

    const normal = connect();
    normal.ws.emit("message", { data: JSON.stringify({ v: 1, type: "hello", seq: 1, sessionId: "s", title: null, format: { rate: 24000, channels: 1 }, limits: { idleMs: 1, capMs: 2, warnMs: 3 }, qa: false, devices: {}, confirmMode: "off" }) });
    normal.ws.emit("close", { code: 1001, reason: "stop" });
    expect(normal.errors).toEqual([]);
    expect(normal.closes).toEqual([{ code: 1001, reason: "stop", hadHello: true }]);
  });
});

test("view state type stays serializable (no functions, no DOM)", () => {
  const s: PanelViewState = initialViewState();
  expect(JSON.parse(JSON.stringify(s))).toEqual(s);
});
