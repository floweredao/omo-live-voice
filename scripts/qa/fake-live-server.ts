// Fake GPT-Live server (QA only). No network beyond 127.0.0.1, random port, printed on stdout line 1.
// Usage: bun fake-live-server.ts [--self-test]
// Env: OLV_FAKE_TRANSCRIPTS (JSON string[]), OLV_FAKE_REJECT_VOICE=1, OLV_FAKE_ACK_AFTER_AUDIO=1,
//      OLV_FAKE_MUTE_OUTPUT=1, OLV_FAKE_OUTPUT_MS (2000), OLV_FAKE_TRAILING_SILENCE_MS (3000), OLV_FAKE_LOG (JSONL path).
import { appendFileSync } from "node:fs";
import type { Server, ServerWebSocket } from "bun";

export interface FakeLiveConfig {
  transcripts: string[];
  rejectVoice: boolean;
  ackAfterAudio: boolean;
  muteOutput: boolean;
  outputMs: number;
  trailingSilenceMs: number;
  logPath: string | null;
}

const RATE = 24000;
const FRAME_SAMPLES = 2400; // 100 ms
const VOICED = 500; // |v| > 500 is non-silent
const SILENT_FRAMES_TO_END = 8; // 800 ms

export function configFromEnv(env: Record<string, string | undefined> = process.env): FakeLiveConfig {
  let transcripts = ["현재 폴더의 파일 목록을 보여줘"];
  if (env.OLV_FAKE_TRANSCRIPTS) {
    const parsed: unknown = JSON.parse(env.OLV_FAKE_TRANSCRIPTS);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((s) => typeof s !== "string")) {
      throw new Error("OLV_FAKE_TRANSCRIPTS must be a non-empty JSON array of strings");
    }
    transcripts = parsed as string[];
  }
  const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    transcripts,
    rejectVoice: env.OLV_FAKE_REJECT_VOICE === "1",
    ackAfterAudio: env.OLV_FAKE_ACK_AFTER_AUDIO === "1",
    muteOutput: env.OLV_FAKE_MUTE_OUTPUT === "1",
    outputMs: num(env.OLV_FAKE_OUTPUT_MS, 2000),
    trailingSilenceMs: num(env.OLV_FAKE_TRAILING_SILENCE_MS, 3000),
    logPath: env.OLV_FAKE_LOG || null,
  };
}

interface Conn {
  startedAt: number;
  closed: boolean;
  eid: number;
  carry: Buffer; // undecoded tail bytes of input audio
  frameSamples: number[]; // samples of the partial current frame
  frameIndex: number; // frames consumed on the input sample clock
  burstStart: number; // frame index, -1 when no burst open
  lastVoiced: number;
  silentRun: number;
  burstCount: number;
  speechChain: Promise<void>;
  usageTimer: ReturnType<typeof setInterval> | null;
  abort: AbortController;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res) => {
    if (signal.aborted) return res();
    const t = setTimeout(res, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), res()), { once: true });
  });

function pcmFrame(tone: boolean, startSample: number): string {
  const buf = Buffer.alloc(FRAME_SAMPLES * 2);
  if (tone) {
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      buf.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * (startSample + i)) / RATE)), i * 2);
    }
  }
  return buf.toString("base64");
}

export function startFakeLive(cfg: FakeLiveConfig): Server<Conn> {
  const log = (c: Conn, msg: unknown) => {
    if (!cfg.logPath) return;
    const m = { ...(msg as Record<string, unknown>) };
    if (typeof m.audio === "string") (m._audio_bytes = Buffer.from(m.audio, "base64").length), delete m.audio;
    appendFileSync(cfg.logPath, JSON.stringify({ ts: new Date().toISOString(), t_ms: Date.now() - c.startedAt, type: m.type, event: m }) + "\n");
  };

  const send = (ws: ServerWebSocket<Conn>, ev: Record<string, unknown>) => {
    if (ws.data.closed) return;
    ws.send(JSON.stringify({ event_id: `fake_evt_${++ws.data.eid}`, ...ev }));
  };
  const now = (ws: ServerWebSocket<Conn>) => Date.now() - ws.data.startedAt;

  const finishBurst = (ws: ServerWebSocket<Conn>, startFrame: number, endFrame: number) => {
    const c = ws.data;
    const k = ++c.burstCount;
    const text = cfg.transcripts[Math.min(k - 1, cfg.transcripts.length - 1)]!;
    const startMs = startFrame * 100;
    const endMs = endFrame * 100;
    const chars = Array.from(text);
    const chunks: string[] = [];
    for (let i = 0; i < chars.length; i += 3) chunks.push(chars.slice(i, i + 3).join(""));
    const span = Math.max(endMs - startMs, chunks.length);
    chunks.forEach((delta, i) => {
      send(ws, {
        type: "session.input_transcript.delta",
        start_ms: startMs + Math.floor((span * i) / chunks.length),
        end_ms: startMs + Math.floor((span * (i + 1)) / chunks.length),
        delta,
      });
    });
    send(ws, { type: "session.delegation.created", offset_ms: endMs, delegation: { id: `d${k}`, type: "delegation", target: "client" } });
  };

  const onFrame = (ws: ServerWebSocket<Conn>, samples: number[]) => {
    const c = ws.data;
    const voiced = samples.some((v) => Math.abs(v) > VOICED);
    const idx = c.frameIndex++;
    if (voiced) {
      if (c.burstStart < 0) c.burstStart = idx;
      c.lastVoiced = idx;
      c.silentRun = 0;
    } else if (c.burstStart >= 0) {
      if (++c.silentRun >= SILENT_FRAMES_TO_END) {
        const s = c.burstStart;
        const e = c.lastVoiced + 1;
        c.burstStart = -1;
        c.silentRun = 0;
        finishBurst(ws, s, e);
      }
    }
  };

  const appendAudio = (ws: ServerWebSocket<Conn>, b64: string) => {
    const c = ws.data;
    const buf = Buffer.concat([c.carry, Buffer.from(b64, "base64")]);
    const even = buf.length - (buf.length % 2);
    c.carry = buf.subarray(even);
    for (let i = 0; i < even; i += 2) {
      c.frameSamples.push(buf.readInt16LE(i));
      if (c.frameSamples.length === FRAME_SAMPLES) {
        const f = c.frameSamples;
        c.frameSamples = [];
        onFrame(ws, f);
      }
    }
  };

  /** Speak `text`: one transcript delta + tone audio, then trailing silent frames. Serialized per connection. */
  const speak = (ws: ServerWebSocket<Conn>, text: string): Promise<void> => {
    const c = ws.data;
    const run = async () => {
      if (c.closed) return;
      const toneFrames = Math.max(1, Math.round(cfg.outputMs / 100));
      const silentFrames = Math.round(cfg.trailingSilenceMs / 100);
      const t0 = now(ws);
      send(ws, { type: "session.output_transcript.delta", start_ms: t0, end_ms: t0 + toneFrames * 100, delta: text });
      for (let i = 0; i < toneFrames && !c.closed; i++) {
        send(ws, { type: "session.output_audio.delta", delta: pcmFrame(true, i * FRAME_SAMPLES) });
        await sleep(100, c.abort.signal);
      }
      for (let i = 0; i < silentFrames && !c.closed; i++) {
        send(ws, { type: "session.output_audio.delta", delta: pcmFrame(false, 0) });
        await sleep(100, c.abort.signal);
      }
    };
    c.speechChain = c.speechChain.then(run);
    return c.speechChain;
  };

  const handleAppend = (ws: ServerWebSocket<Conn>, msg: Record<string, any>, ackType: string) => {
    const ack = () => {
      const t = now(ws);
      send(ws, { type: ackType, client_event_id: msg.event_id, start_ms: t, end_ms: t + 200 });
    };
    if (cfg.muteOutput) return ack();
    const content = String(msg.content ?? "");
    if (cfg.ackAfterAudio) {
      void speak(ws, content);
      setTimeout(ack, 300);
    } else {
      ack();
      void speak(ws, content);
    }
  };

  return Bun.serve<Conn>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      const data: Conn = {
        startedAt: Date.now(),
        closed: false,
        eid: 0,
        carry: Buffer.alloc(0),
        frameSamples: [],
        frameIndex: 0,
        burstStart: -1,
        lastVoiced: -1,
        silentRun: 0,
        burstCount: 0,
        speechChain: Promise.resolve(),
        usageTimer: null,
        abort: new AbortController(),
      };
      return server.upgrade(req, { data }) ? undefined : new Response("fake-live: websocket only", { status: 426 });
    },
    websocket: {
      message(ws, raw) {
        const c = ws.data;
        let msg: Record<string, any>;
        try {
          msg = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
        } catch {
          log(c, { type: "_malformed", raw: String(raw).slice(0, 200) });
          send(ws, { type: "error", error: { type: "invalid_request_error", code: "invalid_json", message: "malformed JSON" } });
          return;
        }
        log(c, msg);
        switch (msg.type) {
          case "session.start": {
            const voice = msg.session?.audio?.output?.voice;
            if (cfg.rejectVoice) {
              send(ws, { type: "error", client_event_id: msg.event_id, error: { type: "invalid_request_error", code: "invalid_value", message: "invalid voice" } });
              return;
            }
            send(ws, {
              type: "session.started",
              client_event_id: msg.event_id,
              session: {
                id: "fake-1",
                model: msg.session?.model ?? "gpt-live-1",
                audio: { format: { type: "audio/pcm", rate: RATE }, output: { voice } },
              },
            });
            c.usageTimer = setInterval(() => send(ws, { type: "session.usage.updated", usage: { seconds: Math.floor(now(ws) / 1000) } }), 1000);
            break;
          }
          case "session.input_audio.append":
            if (typeof msg.audio === "string") appendAudio(ws, msg.audio);
            break;
          case "session.instructions.append":
            handleAppend(ws, msg, "session.instructions.appended");
            break;
          case "session.commentary.append":
            handleAppend(ws, msg, "session.commentary.appended");
            break;
          case "session.thinking.append": {
            const t = now(ws);
            send(ws, { type: "session.thinking.appended", client_event_id: msg.event_id, start_ms: t, end_ms: t + 200 });
            break;
          }
          case "session.input_audio.mute":
            send(ws, { type: "session.input_audio.muted", client_event_id: msg.event_id });
            break;
          case "session.close":
            send(ws, { type: "session.closed", reason: "close_requested", client_event_id: msg.event_id, usage: { seconds: Math.floor(now(ws) / 1000) } });
            break;
        }
      },
      close(ws) {
        ws.data.closed = true;
        ws.data.abort.abort();
        if (ws.data.usageTimer) clearInterval(ws.data.usageTimer);
      },
    },
  });
}

// ---------------------------------------------------------------- self-test
function toneBurst(ms: number): Int16Array {
  const n = (ms / 1000) * RATE;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(6000 * Math.sin((2 * Math.PI * 300 * i) / RATE));
  return out;
}

async function selfTest(): Promise<void> {
  const base = configFromEnv();
  const results: string[] = [];
  const check = (cond: boolean, label: string) => {
    if (!cond) throw new Error(`self-test assertion failed: ${label}`);
    results.push(`ok ${label}`);
  };

  const connect = async (cfg: FakeLiveConfig) => {
    const server = startFakeLive(cfg);
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/v1/live/sessions`);
    const events: Record<string, any>[] = [];
    const waiters: { pred: (e: any) => boolean; res: (e: any) => void; rej: (e: Error) => void }[] = [];
    ws.onmessage = (m) => {
      const e = JSON.parse(String(m.data));
      events.push(e);
      for (const w of [...waiters]) if (w.pred(e)) (waiters.splice(waiters.indexOf(w), 1), w.res(e));
    };
    await new Promise<void>((res, rej) => ((ws.onopen = () => res()), (ws.onerror = () => rej(new Error("ws error")))));
    const waitFor = (pred: (e: any) => boolean, label: string, ms = 5000) =>
      new Promise<any>((res, rej) => {
        const hit = events.find(pred);
        if (hit) return res(hit);
        const t = setTimeout(() => rej(new Error(`timeout waiting for ${label}`)), ms);
        waiters.push({ pred, res: (e) => (clearTimeout(t), res(e)), rej });
      });
    const sendJson = (o: unknown) => ws.send(JSON.stringify(o));
    const stop = () => (ws.close(), server.stop(true));
    return { events, waitFor, sendJson, stop };
  };
  const start = { type: "session.start", event_id: "start", session: { model: "gpt-live-1", audio: { output: { voice: "cedar" } } } };

  if (base.rejectVoice) {
    const h = await connect(base);
    try {
      h.sendJson(start);
      const err = await h.waitFor((e) => e.type === "error", "error");
      check(err.error.code === "invalid_value", "reject path emits error invalid_value");
      check(!h.events.some((e) => e.type === "session.started"), "no session.started after rejection");
    } finally {
      h.stop();
    }
    console.log(results.join("\n"));
    console.log("SELF-TEST PASS (reject path: error invalid_value)");
    return;
  }

  const fast = { ...base, transcripts: ["현재 폴더의 파일 목록을 보여줘", "그만"], outputMs: 300, trailingSilenceMs: 200, ackAfterAudio: false, muteOutput: false };
  const h = await connect(fast);
  try {
    h.sendJson(start);
    const started = await h.waitFor((e) => e.type === "session.started", "session.started");
    check(started.session.id === "fake-1" && started.session.audio.output.voice === "cedar", "session.started echoes id fake-1 + requested voice");

    // request burst (500 ms) + 900 ms silence + cancel burst (400 ms) + 900 ms silence, streamed in 2,400-sample chunks
    const pcm = new Int16Array(RATE * 2.7);
    pcm.set(toneBurst(500), 0);
    pcm.set(toneBurst(400), RATE * 1.4);
    for (let o = 0; o < pcm.length; o += FRAME_SAMPLES) {
      const chunk = pcm.subarray(o, o + FRAME_SAMPLES);
      h.sendJson({ type: "session.input_audio.append", audio: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("base64") });
    }
    await h.waitFor((e) => e.type === "session.delegation.created" && e.delegation.id === "d2", "delegation d2");
    const tr = h.events.filter((e) => e.type === "session.input_transcript.delta");
    const d1i = h.events.findIndex((e) => e.type === "session.delegation.created" && e.delegation.id === "d1");
    const joined = (from: number, to: number) => h.events.slice(from, to).filter((e) => e.type === "session.input_transcript.delta").map((e) => e.delta).join("");
    check(joined(0, d1i) === "현재 폴더의 파일 목록을 보여줘", "burst 1 transcript spelled before d1");
    check(joined(d1i, h.events.length) === "그만", "burst 2 transcript spelled before d2");
    check(tr[0].start_ms === 0 && h.events[d1i].offset_ms === 500, "burst 1 timing from the burst (start 0, end 500)");
    const d2 = h.events.find((e) => e.type === "session.delegation.created" && e.delegation.id === "d2");
    check(d2?.offset_ms === 1800, "burst 2 offset_ms = 1800");

    // thinking, commentary: ack then transcript + audio
    h.sendJson({ type: "session.thinking.append", event_id: "hold", delegation_id: "d1", content: "기다려" });
    const think = await h.waitFor((e) => e.type === "session.thinking.appended", "thinking.appended");
    check(think.client_event_id === "hold", "thinking.appended echoes client_event_id");
    h.sendJson({ type: "session.commentary.append", event_id: "c1", delegation_id: "d1", content: "파일은 세 개예요." });
    await h.waitFor((e) => e.type === "session.commentary.appended", "commentary.appended");
    const spoken = await h.waitFor((e) => e.type === "session.output_transcript.delta" && e.delta === "파일은 세 개예요.", "commentary transcript");
    check(!!spoken, "commentary spoken verbatim");
    await h.waitFor((e) => e.type === "session.output_audio.delta", "output audio");

    // instructions.append default order: appended before first transcript delta
    const mark = h.events.length;
    h.sendJson({ type: "session.instructions.append", event_id: "i1", content: "그대로 말해요" });
    await h.waitFor((e) => e.type === "session.output_transcript.delta" && e.delta === "그대로 말해요", "instructions transcript");
    const seg = h.events.slice(mark).map((e) => e.type);
    check(seg.indexOf("session.instructions.appended") >= 0 && seg.indexOf("session.instructions.appended") < seg.indexOf("session.output_transcript.delta"), "default order: ack then transcript/audio");

    h.sendJson({ type: "session.input_audio.mute", event_id: "m1" });
    const muted = await h.waitFor((e) => e.type === "session.input_audio.muted", "muted");
    check(muted.client_event_id === "m1", "muted echoes client_event_id");
    await h.waitFor((e) => e.type === "session.usage.updated", "usage.updated", 3000);
    check(true, "usage.updated seen");
    h.sendJson({ type: "session.close", event_id: "close" });
    const closed = await h.waitFor((e) => e.type === "session.closed", "closed");
    check(typeof closed.usage.seconds === "number", "session.closed carries usage.seconds");
  } finally {
    h.stop();
  }

  // ack-after-audio order
  const h2 = await connect({ ...fast, ackAfterAudio: true });
  try {
    h2.sendJson(start);
    await h2.waitFor((e) => e.type === "session.started", "started");
    h2.sendJson({ type: "session.instructions.append", event_id: "i2", content: "먼저 말해요" });
    await h2.waitFor((e) => e.type === "session.instructions.appended", "late ack");
    const types = h2.events.map((e) => e.type);
    check(types.indexOf("session.output_transcript.delta") >= 0 && types.indexOf("session.output_transcript.delta") < types.indexOf("session.instructions.appended"), "OLV_FAKE_ACK_AFTER_AUDIO: transcript before .appended");
  } finally {
    h2.stop();
  }

  // mute output: ack only, no output
  const h3 = await connect({ ...fast, muteOutput: true });
  try {
    h3.sendJson(start);
    await h3.waitFor((e) => e.type === "session.started", "started");
    h3.sendJson({ type: "session.instructions.append", event_id: "i3", content: "조용" });
    await h3.waitFor((e) => e.type === "session.instructions.appended", "ack");
    await new Promise((r) => setTimeout(r, 400)); // bounded negative observation window
    check(!h3.events.some((e) => e.type === "session.output_transcript.delta" || e.type === "session.output_audio.delta"), "OLV_FAKE_MUTE_OUTPUT: ack without output");
  } finally {
    h3.stop();
  }

  console.log(results.join("\n"));
  console.log("SELF-TEST PASS");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("usage: bun fake-live-server.ts [--self-test]   (env: OLV_FAKE_TRANSCRIPTS OLV_FAKE_REJECT_VOICE OLV_FAKE_ACK_AFTER_AUDIO OLV_FAKE_MUTE_OUTPUT OLV_FAKE_OUTPUT_MS OLV_FAKE_TRAILING_SILENCE_MS OLV_FAKE_LOG)");
  } else if (args.includes("--self-test")) {
    selfTest().then(
      () => process.exit(0),
      (e) => (console.error(`SELF-TEST FAIL: ${e instanceof Error ? e.message : e}`), process.exit(1)),
    );
  } else {
    const server = startFakeLive(configFromEnv());
    console.log(JSON.stringify({ port: server.port, url: `ws://127.0.0.1:${server.port}` }));
    const quit = () => (server.stop(true), process.exit(0));
    process.on("SIGTERM", quit);
    process.on("SIGINT", quit);
  }
}
