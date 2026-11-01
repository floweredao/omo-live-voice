import { afterEach, beforeAll, describe, expect, test } from "bun:test";

type Got = { auth: string | null; messages: any[]; sockets: any[] };
type Behavior = (ws: any, msg: any) => void;

let got: Got;
let behavior: Behavior;
let server: ReturnType<typeof Bun.serve>;
let LiveSession: typeof import("../bridge/live.ts").LiveSession;
let config: typeof import("../bridge/config.ts");
const lines: string[] = [];
const live: InstanceType<typeof LiveSession>[] = [];

const defaultBehavior: Behavior = (ws, msg) => {
  if (msg.type === "session.start") {
    ws.send(JSON.stringify({ type: "session.started", session: { id: "sess_test", ...msg.session } }));
  } else if (msg.type === "session.close") {
    ws.send(JSON.stringify({ type: "session.closed", reason: "close_requested", usage: { seconds: 3 } }));
  }
};

beforeAll(async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      got.auth = req.headers.get("authorization");
      return srv.upgrade(req, { data: undefined }) ? undefined : new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(ws) {
        got.sockets.push(ws);
      },
      message(ws, raw) {
        const msg = JSON.parse(String(raw));
        got.messages.push(msg);
        behavior(ws, msg);
      },
    },
  });
  process.env.OLV_LIVE_URL = `ws://127.0.0.1:${server.port}`;
  config = await import("../bridge/config.ts");
  ({ LiveSession } = await import("../bridge/live.ts"));
});

function fresh(b: Behavior = defaultBehavior) {
  got = { auth: null, messages: [], sockets: [] };
  behavior = b;
  const s = new LiveSession({ apiKey: "test-key", log: (l) => lines.push(l) });
  live.push(s);
  return s;
}

function next<T = any>(s: InstanceType<typeof LiveSession>, type: string, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
    const off = s.onEvent(type, (e) => {
      clearTimeout(t);
      off();
      resolve(e as T);
    });
  });
}

function nextMessage(type: string, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for message ${type}`)), timeoutMs);
    const prev = behavior;
    behavior = (ws, msg) => {
      prev(ws, msg);
      if (msg.type === type) {
        clearTimeout(t);
        behavior = prev;
        resolve(msg);
      }
    };
  });
}

afterEach(async () => {
  for (const s of live.splice(0)) await s.close(500).catch(() => {});
});

describe("LiveSession", () => {
  test("upgrade carries the bearer key and session.start pins cedar / gpt-live-1 / client delegation", async () => {
    const s = fresh();
    await s.start(3000);
    expect(got.auth).toBe("Bearer test-key");
    const [start] = got.messages;
    expect(start.type).toBe("session.start");
    expect(start.session.audio.output.voice).toBe("cedar");
    expect(start.session.model).toBe("gpt-live-1");
    expect(start.session.delegation.type).toBe("client");
    expect(start.session.delegation.acknowledgement_delay_ms).toBe(0);
    expect(start.session.audio.format).toEqual({ type: "audio/pcm", rate: 24000 });
    expect(s.sessionId).toBe("sess_test");
    expect(s.startedSnapshot?.audio.output.voice).toBe("cedar");
  });

  test("voice is not influenced by the environment", async () => {
    const saved = process.env.OLV_VOICE;
    process.env.OLV_VOICE = "override-attempt";
    process.env.LIVE_VOICE = "override-attempt";
    try {
      const s = fresh();
      await s.start(3000);
      expect(got.messages[0].session.audio.output.voice).toBe("cedar");
      expect(config.LIVE_VOICE).toBe("cedar");
    } finally {
      delete process.env.LIVE_VOICE;
      if (saved === undefined) delete process.env.OLV_VOICE;
      else process.env.OLV_VOICE = saved;
    }
  });

  test("appendAudio sends even bytes only and carries the odd byte", async () => {
    const s = fresh();
    await s.start(3000);
    const first = nextMessage("session.input_audio.append");
    s.appendAudio(new Uint8Array(4801));
    const a = await first;
    expect(Buffer.from(a.audio, "base64").length).toBe(4800);
    const second = nextMessage("session.input_audio.append");
    s.appendAudio(new Uint8Array([7]));
    const b = await second;
    expect([...Buffer.from(b.audio, "base64")]).toEqual([0, 7]);
  });

  test("commentary, thinking and instructions payload shapes", async () => {
    const s = fresh();
    await s.start(3000);
    const c = nextMessage("session.commentary.append");
    expect(s.commentary("결과예요", "item_d1", "c1")).toBe(true);
    expect(await c).toEqual({ type: "session.commentary.append", event_id: "c1", delegation_id: "item_d1", content: "결과예요" });
    const t = nextMessage("session.thinking.append");
    expect(s.thinking("기다려", "item_d1", "t1")).toBe(true);
    expect(await t).toEqual({ type: "session.thinking.append", event_id: "t1", delegation_id: "item_d1", content: "기다려" });
    const i = nextMessage("session.instructions.append");
    expect(s.instructions("말해", null, "i1")).toBe(true);
    expect(await i).toEqual({ type: "session.instructions.append", event_id: "i1", delegation_id: null, content: "말해" });
  });

  test("mute() resolves only after the muted ack with the matching client_event_id", async () => {
    let muteId = "";
    const s = fresh((ws, msg) => {
      defaultBehavior(ws, msg);
      if (msg.type === "session.input_audio.mute") muteId = msg.event_id;
    });
    await s.start(3000);
    let done = false;
    const p = s.mute().then(() => (done = true));
    const sent = nextMessage("session.input_audio.mute");
    await sent;
    const server0 = got.sockets[0];
    const wrongAck = next(s, "session.input_audio.muted");
    server0.send(JSON.stringify({ type: "session.input_audio.muted", client_event_id: "other" }));
    await wrongAck;
    expect(done).toBe(false);
    const rightAck = next(s, "session.input_audio.muted");
    server0.send(JSON.stringify({ type: "session.input_audio.muted", client_event_id: muteId }));
    await rightAck;
    await p;
    expect(done).toBe(true);
  });

  test("unmute() resolves on the unmuted ack", async () => {
    const s = fresh((ws, msg) => {
      defaultBehavior(ws, msg);
      if (msg.type === "session.input_audio.unmute") {
        ws.send(JSON.stringify({ type: "session.input_audio.unmuted", client_event_id: msg.event_id }));
      }
    });
    await s.start(3000);
    await s.unmute(2000);
  });

  test("close() resolves on session.closed and records usage seconds", async () => {
    const s = fresh();
    await s.start(3000);
    await s.close(3000);
    expect(got.messages.at(-1).type).toBe("session.close");
    expect(s.usageSeconds).toBe(3);
    expect(s.ready).toBe(false);
  });

  test("transport loss emits a terminal event and blocks further sends", async () => {
    const s = fresh();
    await s.start(3000);
    const closed = next(s, "session.closed");
    got.sockets[0].terminate();
    expect(await closed).toMatchObject({ type: "session.closed", reason: "live_dropped" });
    expect(s.ready).toBe(false);
    const count = got.messages.length;
    s.appendAudio(new Uint8Array(4800));
    expect(s.commentary("result", null, "c-drop")).toBe(false);
    expect(s.thinking("waiting", null, "t-drop")).toBe(false);
    expect(s.instructions("question", null, "i-drop")).toBe(false);
    await s.close(3000);
    expect(got.messages).toHaveLength(count);
  });

  test("start() rejects on an error event before session.started with the code in the message", async () => {
    const s = fresh((ws, msg) => {
      if (msg.type === "session.start") {
        ws.send(JSON.stringify({ type: "error", error: { code: "invalid_value", param: "session.audio.output.voice", message: "echo test-key" } }));
      }
    });
    await expect(s.start(3000)).rejects.toThrow(/invalid_value/);
  });

  test("emits typed events, routes unknown types to '*', tracks usage", async () => {
    const s = fresh();
    await s.start(3000);
    const seen: string[] = [];
    for (const t of [
      "session.output_audio.delta",
      "session.input_transcript.delta",
      "session.output_transcript.delta",
      "session.delegation.created",
      "session.commentary.appended",
      "session.thinking.appended",
      "*",
    ]) {
      s.onEvent(t, (e) => seen.push(`${t}:${e.type}`));
    }
    const star = next(s, "*");
    const usage = next(s, "session.usage.updated");
    const ws = got.sockets[0];
    for (const type of [
      "session.output_audio.delta",
      "session.input_transcript.delta",
      "session.output_transcript.delta",
      "session.delegation.created",
      "session.commentary.appended",
      "session.thinking.appended",
    ]) {
      ws.send(JSON.stringify({ type }));
    }
    ws.send(JSON.stringify({ type: "response.event" }));
    ws.send(JSON.stringify({ type: "session.usage.updated", usage: { seconds: 14 } }));
    await star;
    await usage;
    expect(seen).toContain("session.delegation.created:session.delegation.created");
    expect(seen).toContain("session.output_transcript.delta:session.output_transcript.delta");
    expect(seen).toContain("*:response.event");
    expect(seen.filter((x) => x.startsWith("*:")).length).toBe(1);
    expect(s.usageSeconds).toBe(14);
  });

  test("the API key never appears in logs", async () => {
    const s = fresh((ws, msg) => {
      if (msg.type === "session.start") ws.send(JSON.stringify({ type: "error", error: { code: "invalid_api_key", message: "bad key test-key" } }));
    });
    await expect(s.start(3000)).rejects.toThrow(/invalid_api_key/);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes("test-key"))).toBe(false);
  });
});
