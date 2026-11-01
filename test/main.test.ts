import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { decodeFrame, encodeFrame } from "../shared/protocol.ts";
import type { BridgeToPanel } from "../shared/protocol.ts";
import { INSTRUCTIONS_PREFIX, questionToSpeech } from "../bridge/adapter.ts";
import { COMMENTARY_CAP_CHARS } from "../bridge/config.ts";

const MAIN = join(import.meta.dir, "../bridge/main.ts");

type FakeLive = { url: string; received: { type: string; session?: any; content?: string; event_id?: string }[]; waitFor(type: string, ms: number, from?: number): Promise<void>; emit(event: unknown): void; sync(): Promise<void>; drop(): void; stop(): void };

function fakeLive(autoStart = true): FakeLive {
  const received: FakeLive["received"] = [];
  const waiters: { type: string; resolve: () => void }[] = [];
  let emit: ((event: unknown) => void) | undefined;
  let drop: (() => void) | undefined;
  let ping: (() => void) | undefined;
  let pong: (() => void) | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      pong() { pong?.(); },
      message(ws, raw) {
        const msg = JSON.parse(String(raw));
        received.push(msg);
        for (const w of waiters.filter((x) => x.type === msg.type)) w.resolve();
        if (msg.type === "session.start") {
          emit = (event) => ws.send(JSON.stringify(event));
          drop = () => ws.close();
          ping = () => ws.ping();
          if (autoStart) ws.send(JSON.stringify({ type: "session.started", client_event_id: msg.event_id, session: { id: "fake-main", ...msg.session } }));
        } else if (msg.type === "session.commentary.append") {
          // A real appended ack confirms receipt, not that speech has started or ended.
          ws.send(JSON.stringify({ type: "session.commentary.appended", client_event_id: msg.event_id, start_ms: 0, end_ms: 200 }));
        } else if (msg.type === "session.input_audio.mute" || msg.type === "session.input_audio.unmute") {
          ws.send(JSON.stringify({ type: msg.type === "session.input_audio.mute" ? "session.input_audio.muted" : "session.input_audio.unmuted", client_event_id: msg.event_id }));
        } else if (msg.type === "session.close") {
          ws.send(JSON.stringify({ type: "session.closed", reason: "close_requested", usage: { seconds: 1 } }));
        }
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}`,
    received,
    waitFor(type, ms, from = 0) {
      if (received.slice(from).some((m) => m.type === type)) return Promise.resolve();
      return bounded(new Promise<void>((resolve) => waiters.push({ type, resolve })), ms, `fake live never got ${type}`);
    },
    emit(event) {
      if (!emit) throw new Error("Live session has not started");
      emit(event);
    },
    sync() {
      return bounded(new Promise<void>((resolve) => {
        pong = resolve;
        ping?.();
      }), 2000, "Live socket pong");
    },
    drop() {
      if (!drop) throw new Error("Live session has not started");
      drop();
    },
    stop: () => server.stop(true),
  };
}

function bounded<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout: ${what}`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

type Bridge = { dataDir: string; proc: Subprocess<"pipe", "pipe", "pipe">; stdout: string[]; nextJson(type: string, ms: number, pred?: (j: any) => boolean): Promise<any>; send(msg: unknown): void };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function spawnBridge(env: Record<string, string>): Bridge {
  const dataDir = mkdtempSync(join(tmpdir(), "olv-main-test-"));
  const proc = Bun.spawn(["bun", MAIN], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", OLV_PORT: "0", OLV_DATA_DIR: dataDir, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  cleanups.push(async () => {
    proc.kill("SIGKILL");
    await proc.exited;
    rmSync(dataDir, { recursive: true, force: true });
  });
  const stdout: string[] = [];
  const listeners: ((line: string) => void)[] = [];
  (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        stdout.push(line);
        for (const l of [...listeners]) l(line);
        nl = buf.indexOf("\n");
      }
    }
  })();
  return {
    dataDir,
    proc,
    stdout,
    nextJson(type, ms, pred = () => true) {
      const match = (line: string) => {
        try {
          const j = JSON.parse(line);
          return j.type === type && pred(j) ? j : null;
        } catch {
          return null;
        }
      };
      for (const line of stdout) if (match(line)) return Promise.resolve(match(line));
      return bounded(
        new Promise((resolve) => {
          const l = (line: string) => {
            const j = match(line);
            if (j) {
              listeners.splice(listeners.indexOf(l), 1);
              resolve(j);
            }
          };
          listeners.push(l);
        }),
        ms,
        `bridge never printed ${type}`,
      );
    },
    send(msg) {
      proc.stdin.write(`${JSON.stringify(msg)}\n`);
      proc.stdin.flush();
    },
  };
}

const HELLO = { type: "hello", sessionId: "s1", sessionFile: null, cwd: "/tmp", title: null, qa: false };

async function regressionBridge(autoStart = true, idleMs = "200000") {
  const live = fakeLive(autoStart);
  cleanups.push(live.stop);
  const bridge = spawnBridge({ OLV_LIVE_URL: live.url, OPENAI_API_KEY: "sk-test", OLV_FAKE_CLOCK: "1", OLV_IDLE_MS: idleMs });
  bridge.send(HELLO);
  const ready = await bridge.nextJson("ready", 5000);
  const ws = new WebSocket(`ws://127.0.0.1:${ready.port}/ws?token=${ready.token}`, {
    headers: { Origin: `http://127.0.0.1:${ready.port}` },
  } as unknown as string[]);
  cleanups.push(() => ws.close());
  const messages: BridgeToPanel[] = [];
  const listeners = new Set<(msg: BridgeToPanel) => void>();
  ws.addEventListener("message", (e) => {
    if (typeof e.data !== "string") return;
    const msg: BridgeToPanel = JSON.parse(e.data);
    messages.push(msg);
    for (const listener of listeners) listener(msg);
  });
  const nextPanel = (pred: (msg: BridgeToPanel) => boolean) => bounded(new Promise<BridgeToPanel>((resolve) => {
    const listener = (msg: BridgeToPanel) => {
      if (!pred(msg)) return;
      listeners.delete(listener);
      resolve(msg);
    };
    listeners.add(listener);
  }), 2000, "regression panel event");
  let seq = 0;
  let barrierId = 0;
  const send = (msg: object) => ws.send(JSON.stringify({ v: 1, seq: ++seq, ...msg }));
  // The existing unknown-event diagnostic is an ordered stdin round-trip barrier.
  const barrier = async () => {
    const type = `test-barrier-${++barrierId}`;
    const ack = bridge.nextJson("log", 2000, (m) => m.msg === `ext_unknown_type ${type}`);
    bridge.send({ type });
    await ack;
  };
  const clock = async (now: number) => {
    bridge.send({ type: "qa.clock", now });
    await barrier();
  };
  const delta = async (text: string, start_ms: number, end_ms: number) => {
    const seen = nextPanel((m) => m.type === "transcript" && m.speaker === "user" && !m.final && m.text.endsWith(text));
    live.emit({ type: "session.input_transcript.delta", delta: text, start_ms, end_ms });
    await seen;
  };
  const output = async (text: string, voiced = false) => {
    const seen = nextPanel((m) => m.type === "transcript" && m.speaker === "assistant" && !m.final && m.text.endsWith(text));
    const pcm = Buffer.alloc(4800);
    if (voiced) for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
    live.emit({ type: "session.output_audio.delta", delta: pcm.toString("base64") });
    live.emit({ type: "session.output_transcript.delta", delta: text, start_ms: 0, end_ms: 200 });
    await seen;
  };
  // Round-trip the Live socket after stdin clock changes, so negative append assertions
  // cannot win a race against messages still queued on the fake server's socket.
  const syncLive = () => live.sync();
  await bounded(new Promise((resolve) => ws.addEventListener("open", resolve, { once: true })), 3000, "regression panel open");
  const opened = autoStart ? nextPanel((m) => m.type === "state" && m.connection === "open") : null;
  send({ type: "hello", token: ready.token, capabilities: { audioWorklet: true, setSinkId: false }, sampleRate: 24000 });
  await live.waitFor("session.start", 2000);
  if (opened) await opened;
  // A voiced mic frame, then mute/unmute: panel messages are ordered, so the state echo proves the frame was processed.
  const speak = async () => {
    const pcm = new Int16Array(2400).fill(3000);
    ws.send(encodeFrame(1, 0, pcm));
    const muted = nextPanel((m) => m.type === "state" && m.muted);
    send({ type: "control", action: "mute" });
    await muted;
    const unmuted = nextPanel((m) => m.type === "state" && !m.muted);
    send({ type: "control", action: "unmute" });
    await unmuted;
  };
  return { live, bridge, messages, nextPanel, send, barrier, clock, delta, output, syncLive, speak };
}

const CHUNK_QUESTION = {
  type: "agent.question", requestId: "chunks", header: "빌드 방식", question: "어떤 순서로 진행할까요?",
  options: Array.from({ length: 8 }, (_, i) => ({ label: `${i + 1} ${"가".repeat(78)}` })),
};

describe("P6 bridge regressions", () => {
  for (const agent of ["submitting", "working"] as const) {
    test(`forwards a second delegation exactly once while ${agent}`, async () => {
      // Given: a voice message starts the run before the follow-up arrives.
      const h = await regressionBridge();
      await h.delta("목록 보여줘", 0, 1000);
      const first = h.bridge.nextJson("utterance", 2000);
      h.live.emit({ type: "session.delegation.created", offset_ms: 1000, delegation: { id: "first" } });
      await h.syncLive();
      await h.clock(600);
      expect(await first).toMatchObject({ kind: "message", text: "목록 보여줘" });
      if (agent === "working") {
        h.bridge.send({ type: "agent.idle", idle: false });
        h.bridge.send({ type: "agent.tool.start", name: "count" });
        await h.barrier();
      }
      expect(await h.bridge.nextJson("state", 2000, (m) => m.agent === agent)).toMatchObject({ agent });
      // When: another delegation settles while the run is still busy.
      await h.delta("테스트도 돌려줘", 2000, 3000);
      const second = h.bridge.nextJson("utterance", 2000, (m) => m.text === "테스트도 돌려줘");
      h.live.emit({ type: "session.delegation.created", offset_ms: 3000, delegation: { id: "second" } });
      await h.syncLive();
      await h.clock(1200);
      // Then: the extension link gets one message without regressing the agent axis.
      expect(await second).toMatchObject({ kind: "message", text: "테스트도 돌려줘" });
      await h.clock(1300);
      await h.syncLive();
      const records = h.bridge.stdout.map((line) => JSON.parse(line));
      expect(records.filter((m) => m.type === "utterance" && m.text === "테스트도 돌려줘")).toHaveLength(1);
      expect(records.filter((m) => m.type === "state").at(-1)).toMatchObject({ agent });
      h.bridge.send({ type: "stop" });
      expect(await bounded(h.bridge.proc.exited, 3000, "busy steer exit")).toBe(0);
    });
  }

  test("reports an unforwarded message while cancellation is pending", async () => {
    // Given: an agent cancellation has not yet been acknowledged.
    const h = await regressionBridge();
    h.bridge.send({ type: "agent.idle", idle: false });
    await h.barrier();
    await h.delta("그만", 0, 200);
    const cancel = h.bridge.nextJson("utterance", 2000, (m) => m.kind === "cancel");
    await h.clock(600);
    await cancel;
    // When: another delegated message settles before cancellation completes.
    await h.delta("테스트도 돌려줘", 2000, 3000);
    const notice = h.nextPanel((m) => m.type === "error" && m.code === "utterance_not_forwarded");
    const warning = h.bridge.nextJson("log", 2000, (m) =>
      m.level === "warn" && m.msg === "utterance_not_forwarded agent=cancelling connection=open");
    h.live.emit({ type: "session.delegation.created", offset_ms: 3000, delegation: { id: "cancelling-follow-up" } });
    await h.syncLive();
    await h.clock(1200);
    // Then: cancellation semantics stay intact, but the undelivered request is visible.
    expect(await notice).toMatchObject({ recoverable: true });
    await warning;
    expect(h.bridge.stdout.map((line) => JSON.parse(line)).filter((m) => m.type === "utterance")).toHaveLength(1);
    h.bridge.send({ type: "stop" });
    expect(await bounded(h.bridge.proc.exited, 3000, "cancelling message exit")).toBe(0);
  });

  test("ignores malformed devices envelopes and keeps answering panel controls", async () => {
    // Given: an authenticated panel has persisted valid device labels.
    const h = await regressionBridge();
    const valid = {
      type: "devices",
      inputs: [{ id: "mic", label: "Microphone" }],
      outputs: [{ id: "speaker", label: "Speaker" }],
      selected: { input: "mic", output: "speaker" },
    };
    h.send(valid);
    const saved = h.nextPanel((m) => m.type === "state" && m.muted);
    h.send({ type: "control", action: "mute" });
    await saved;
    const settings = readFileSync(join(h.bridge.dataDir, "settings.json"), "utf8");
    const malformed = [
      { inputs: "x", outputs: 5 },
      { inputs: null },
      { outputs: {} },
      { inputs: [null] },
      { outputs: [{ id: "speaker", label: 5 }] },
      { inputs: [{ label: "missing id" }] },
      { selected: null },
      { selected: { input: 5 } },
      { selected: [] },
    ];
    // When: malformed list and element shapes arrive on the same panel socket.
    for (const [i, bad] of malformed.entries()) {
      const from = h.bridge.stdout.length;
      const warned = h.bridge.nextJson("log", 2000, (m) =>
        m.level === "warn" && m.msg === "devices_invalid" &&
        h.bridge.stdout.slice(from).some((line) => JSON.parse(line).msg === "devices_invalid"));
      h.send({ ...valid, ...bad });
      expect(await warned).toMatchObject({ level: "warn", msg: "devices_invalid" });
      // Then: an ordered panel round trip still answers and saved settings survive.
      const muted = i % 2 !== 0;
      const answered = h.nextPanel((m) => m.type === "state" && m.muted === muted);
      h.send({ type: "control", action: muted ? "mute" : "unmute" });
      expect(await answered).toMatchObject({ connection: "open", muted });
      expect(readFileSync(join(h.bridge.dataDir, "settings.json"), "utf8")).toBe(settings);
    }
    expect(h.bridge.stdout.map((line) => JSON.parse(line)).filter((m) => m.msg === "devices_invalid")).toHaveLength(malformed.length);
    h.bridge.send({ type: "stop" });
    expect(await bounded(h.bridge.proc.exited, 3000, "malformed devices exit")).toBe(0);
  });
});

describe("P3 question chunks", () => {
  test("transcript deltas hold the next chunk until both streams are quiet", async () => {
    // Given: the current chunk has voiced PCM, followed by continuing transcript deltas.
    const h = await regressionBridge();
    const first = h.live.waitFor("session.commentary.append", 2000);
    h.bridge.send(CHUNK_QUESTION);
    await first;
    await h.output("first", true);
    // When: PCM goes quiet, but transcript words continue every 200 ms.
    for (const t of [200, 400, 600, 800, 1000]) {
      await h.clock(t);
      await h.output(`word-${t}`);
    }
    await h.syncLive();
    // Then: neither PCM silence nor an appended ack can advance this chunk.
    expect(h.live.received.filter((m) => m.type === "session.commentary.append")).toHaveLength(1);
    await h.clock(1599);
    await h.syncLive();
    expect(h.live.received.filter((m) => m.type === "session.commentary.append")).toHaveLength(1);
    const next = h.live.waitFor("session.commentary.append", 2000, h.live.received.length);
    await h.clock(1600);
    await next;
    expect(h.live.received.filter((m) => m.type === "session.commentary.append")).toHaveLength(2);
  });

  test("acknowledged no-speech chunk is retried once with a new id then times out", async () => {
    // Given: Live acknowledges every append but emits only silent PCM.
    const h = await regressionBridge();
    const first = h.live.waitFor("session.commentary.append", 2000);
    h.bridge.send(CHUNK_QUESTION);
    await first;
    h.live.emit({ type: "session.output_audio.delta", delta: Buffer.alloc(4800).toString("base64") });
    // When: the short start window expires.
    await h.clock(3999);
    await h.syncLive();
    expect(h.live.received.filter((m) => m.type === "session.commentary.append")).toHaveLength(1);
    const retry = h.live.waitFor("session.commentary.append", 2000, h.live.received.length);
    await h.clock(4000);
    await retry;
    const appends = () => h.live.received.filter((m) => m.type === "session.commentary.append");
    expect(appends()).toHaveLength(2);
    expect(appends()[1]?.content).toBe(appends()[0]?.content);
    expect(appends()[1]?.event_id).not.toBe(appends()[0]?.event_id);
    await h.clock(8000);
    await h.syncLive();
    expect(appends()).toHaveLength(2);
    await h.clock(14999);
    expect(h.messages.some((m) => m.type === "error" && m.code === "question_speech_timeout")).toBe(false);
    const timeout = h.nextPanel((m) => m.type === "error" && m.code === "question_speech_timeout");
    await h.clock(15000);
    // Then: the existing failure is surfaced, and no third retry or next chunk appears.
    expect(await timeout).toMatchObject({ recoverable: true });
    await h.clock(30000);
    await h.syncLive();
    expect(appends()).toHaveLength(2);
    expect(h.messages.filter((m) => m.type === "error" && m.code === "question_speech_timeout")).toHaveLength(1);
  });

  test("all 8x80 option chunks are appended in order without speech overlap", async () => {
    // Given: packing supplied options with the header yields two runtime chunks.
    const h = await regressionBridge();
    expect(CHUNK_QUESTION.options.map((o) => [...o.label].length)).toEqual(Array(8).fill(80));
    const chunks = questionToSpeech(CHUNK_QUESTION, COMMENTARY_CAP_CHARS - [...INSTRUCTIONS_PREFIX].length);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain(CHUNK_QUESTION.options[0]!.label);
    const first = h.live.waitFor("session.commentary.append", 2000);
    h.bridge.send(CHUNK_QUESTION);
    await first;
    const appends = () => h.live.received.filter((m) => m.type === "session.commentary.append");
    // When: each chunk has a PCM gap with continuing transcript, then the reverse.
    for (const [i, chunk] of chunks.entries()) {
      const t = i * 2000;
      await h.clock(t);
      await h.output(`chunk-${i}-start`, true);
      await h.clock(t + 400);
      await h.output(`chunk-${i}-middle`);
      await h.clock(t + 800);
      await h.output(`chunk-${i}-end`);
      await h.syncLive();
      expect(appends()).toHaveLength(i + 1);
      expect(appends()[i]?.content).toBe(INSTRUCTIONS_PREFIX + chunk);
      await h.clock(t + 1200);
      // Transcript has stopped, but this voiced frame must extend the same gate.
      const pcm = Buffer.alloc(4800);
      for (let j = 0; j < pcm.length; j += 2) pcm.writeInt16LE(1000, j);
      h.live.emit({ type: "session.output_audio.delta", delta: pcm.toString("base64") });
      // Input transcript provides an event barrier without another output delta.
      await h.delta(`input-${i}`, i * 1000, i * 1000 + 200);
      await h.clock(t + 1799);
      await h.syncLive();
      expect(appends()).toHaveLength(i + 1);
      const next = i + 1 < chunks.length ? h.live.waitFor("session.commentary.append", 2000, h.live.received.length) : null;
      await h.clock(t + 1800);
      if (next) await next;
    }
    // Then: each complete chunk is sent exactly once in source order, with no timeout.
    await h.clock(30000);
    await h.syncLive();
    expect(appends().map((m) => m.content)).toEqual(chunks.map((c) => INSTRUCTIONS_PREFIX + c));
    expect(h.messages.some((m) => m.type === "error" && m.code === "question_speech_timeout")).toBe(false);
  });

  test("retry speech completes before the next chunk and transcript-only startup cancels retry", async () => {
    // Given: the first attempt is acknowledged without speech.
    const h = await regressionBridge();
    const first = h.live.waitFor("session.commentary.append", 2000);
    h.bridge.send(CHUNK_QUESTION);
    await first;
    const retry = h.live.waitFor("session.commentary.append", 2000, h.live.received.length);
    await h.clock(4000);
    await retry;
    // When: the retry starts with transcript only; PCM later extends its completion.
    await h.output("retry-start");
    await h.clock(4400);
    await h.output("retry-end", true);
    await h.clock(4999);
    await h.syncLive();
    expect(h.live.received.filter((m) => m.type === "session.commentary.append")).toHaveLength(2);
    const next = h.live.waitFor("session.commentary.append", 2000, h.live.received.length);
    await h.clock(5000);
    await next;
    // Then: transcript-only progress also prevents another startup retry.
    for (let t = 5000; t <= 9500; t += 500) {
      await h.clock(t);
      await h.output(`transcript-only-${t}`);
    }
    await h.syncLive();
    expect(h.live.received.filter((m) => m.type === "session.commentary.append")).toHaveLength(3);
    expect(h.messages.some((m) => m.type === "error" && m.code === "question_speech_timeout")).toBe(false);
  });

  test("repeated close and drop resume discard old retry and completion deadlines", async () => {
    // Given: repeated questions alternate between unstarted and progressing speech.
    const h = await regressionBridge();
    for (const [i, mode] of ["close", "drop", "close", "drop"].entries()) {
      const t = i * 20000;
      await h.clock(t);
      const first = h.live.waitFor("session.commentary.append", 2000, h.live.received.length);
      h.bridge.send({ ...CHUNK_QUESTION, requestId: `cancel-${i}` });
      await first;
      if (mode === "drop") await h.output(`interrupted-${i}`, true);
      const count = h.live.received.filter((m) => m.type === "session.commentary.append").length;
      // When: question closure or transport loss invalidates its timers.
      if (mode === "close") {
        h.bridge.send({ type: "agent.question.closed", requestId: `cancel-${i}` });
        await h.barrier();
      } else {
        const closed = h.nextPanel((m) => m.type === "state" && m.connection === "closed");
        h.live.drop();
        await closed;
        const reopened = h.nextPanel((m) => m.type === "state" && m.connection === "open");
        h.bridge.send({ type: "resume" });
        await reopened;
        h.bridge.send({ type: "agent.question.closed", requestId: `cancel-${i}` });
        await h.barrier();
      }
      await h.clock(t + 16000);
      await h.syncLive();
      // Then: stale callbacks neither retry nor append a next chunk on the new session.
      expect(h.live.received.filter((m) => m.type === "session.commentary.append")).toHaveLength(count);
      expect(h.messages.some((m) => m.type === "error" && m.code === "question_speech_timeout")).toBe(false);
    }
  });
});

describe("P3 regressions", () => {
  test("(a) remembers mute while connecting and reapplies desired state after resume", async () => {
    // Given: the handshake is held while the panel mutes.
    const h = await regressionBridge(false);
    const muted = h.nextPanel((m) => m.type === "state" && m.muted);
    h.send({ type: "control", action: "mute" });
    await muted;
    const sentMute = h.live.waitFor("session.input_audio.mute", 2000);
    // When: Live becomes ready.
    h.live.emit({ type: "session.started", session: { id: "delayed", audio: { output: { voice: "cedar" } } } });
    await sentMute;
    // Then: both this socket and a resumed socket receive the desired state.
    expect(h.live.received.filter((m) => m.type === "session.input_audio.mute")).toHaveLength(1);
    const closed = h.nextPanel((m) => m.type === "state" && m.connection === "closed");
    h.live.drop();
    await closed;
    const from = h.live.received.length;
    const restarted = h.live.waitFor("session.start", 2000, from);
    h.bridge.send({ type: "resume" });
    await restarted;
    const resumedMute = h.live.waitFor("session.input_audio.mute", 2000, from);
    h.live.emit({ type: "session.started", session: { id: "resumed", audio: { output: { voice: "cedar" } } } });
    await resumedMute;
    const unmuted = h.live.waitFor("session.input_audio.unmute", 2000, from);
    h.send({ type: "control", action: "unmute" });
    await unmuted;
    h.bridge.send({ type: "stop" });
    expect(await bounded(h.bridge.proc.exited, 3000, "regression exit")).toBe(0);
  });

  test("(c) standalone completed transcript cancels without delegation exactly once", async () => {
    // Given: a voice-initiated busy run (independent of defect d).
    const h = await regressionBridge();
    await h.delta("목록 보여줘", 0, 1000);
    const submitting = h.bridge.nextJson("utterance", 2000);
    const delegated = h.nextPanel((m) => m.type === "state" && m.agent === "idle");
    h.live.emit({ type: "session.delegation.created", offset_ms: 1000, delegation: { id: "first" } });
    await delegated;
    await h.clock(600);
    await submitting;
    h.bridge.send({ type: "agent.tool.start", name: "count" });
    await h.barrier();
    // When: a cancel turn completes, but GPT-Live creates no delegation.
    await h.delta("그만", 2000, 2200);
    const cancel = h.bridge.nextJson("utterance", 2000, (m) => m.kind === "cancel");
    await h.clock(1200);
    expect(await cancel).toMatchObject({ text: "그만", kind: "cancel" });
    // Then: even a delegation arriving after agent completion cannot submit it again.
    h.bridge.send({ type: "agent.end", text: "" });
    await h.barrier();
    h.live.emit({ type: "session.delegation.created", offset_ms: 2200, delegation: { id: "late-cancel" } });
    await h.delta("그만 하고 테스트 돌려줘", 4000, 5000);
    const normal = h.bridge.nextJson("utterance", 2000, (m) => m.text === "그만 하고 테스트 돌려줘");
    const nextTurn = h.nextPanel((m) => m.type === "state" && m.agent === "idle");
    h.live.emit({ type: "session.delegation.created", offset_ms: 5000, delegation: { id: "normal" } });
    await nextTurn;
    await h.clock(1800);
    expect(await normal).toMatchObject({ kind: "message" });
    const utterances = h.bridge.stdout.map((l) => JSON.parse(l)).filter((m) => m.type === "utterance");
    expect(utterances.filter((m) => m.kind === "cancel")).toHaveLength(1);
    expect(utterances.filter((m) => m.text === "그만" && m.kind === "message")).toHaveLength(0);
    h.bridge.send({ type: "stop" });
    expect(await bounded(h.bridge.proc.exited, 3000, "regression exit")).toBe(0);
  });

  test("(c) streamed cancel prefix in a longer sentence stays a normal message", async () => {
    // Given
    const h = await regressionBridge();
    h.bridge.send({ type: "agent.idle", idle: false });
    await h.barrier();
    // When: the remaining words arrive before transcript quiescence.
    await h.delta("그만", 0, 200);
    await h.clock(599);
    expect(h.bridge.stdout.some((l) => JSON.parse(l).type === "utterance")).toBe(false);
    await h.delta(" 하고 테스트 돌려줘", 200, 1000);
    await h.clock(1199);
    // Then: a full sentence is not a cancellation.
    expect(h.bridge.stdout.some((l) => JSON.parse(l).type === "utterance")).toBe(false);
    h.bridge.send({ type: "agent.end", text: "" });
    await h.barrier();
    h.live.emit({ type: "session.delegation.created", offset_ms: 1000, delegation: { id: "sentence" } });
    // The prior agent.end also emits agent=idle, possibly still in the panel socket.
    // An echo from the SAME Live socket proves delegation armed settle before time moves.
    await h.output("delegation-barrier");
    const message = h.bridge.nextJson("utterance", 2000);
    await h.clock(1799);
    expect(await message).toMatchObject({ kind: "message", text: "그만 하고 테스트 돌려줘" });
    h.bridge.send({ type: "stop" });
    expect(await bounded(h.bridge.proc.exited, 3000, "regression exit")).toBe(0);
  });

  test("(c) malformed deltas cannot cancel and cancellation works again after resume", async () => {
    // Given
    const h = await regressionBridge();
    h.bridge.send({ type: "agent.idle", idle: false });
    await h.barrier();
    let firstId = "";
    // When: malformed frames precede a valid cancellation on each socket.
    for (let round = 0; round < 2; round++) {
      h.live.emit({ type: "session.input_transcript.delta", delta: { text: "stop" }, start_ms: 0, end_ms: 200 });
      h.live.emit({ type: "session.input_transcript.delta", delta: "stop", start_ms: 200, end_ms: "invalid" });
      await h.delta("stop!", 0, 200);
      const cancel = h.bridge.nextJson("utterance", 2000, (m) => m.kind === "cancel" && m.id !== firstId);
      await h.clock((round + 1) * 600);
      const event = await cancel;
      // Then: exactly one cancel per completed turn, including on a fresh audio clock.
      expect(event).toMatchObject({ text: "stop!", kind: "cancel" });
      firstId = event.id;
      h.bridge.send({ type: "agent.idle", idle: true });
      await h.barrier();
      if (round === 0) {
        const closed = h.nextPanel((m) => m.type === "state" && m.connection === "closed");
        h.live.drop();
        await closed;
        const reopened = h.nextPanel((m) => m.type === "state" && m.connection === "open");
        h.bridge.send({ type: "resume" });
        await reopened;
        h.bridge.send({ type: "agent.idle", idle: false });
        await h.barrier();
      }
    }
    expect(h.bridge.stdout.map((l) => JSON.parse(l)).filter((m) => m.type === "utterance")).toHaveLength(2);
    h.bridge.send({ type: "stop" });
    expect(await bounded(h.bridge.proc.exited, 3000, "regression exit")).toBe(0);
  });

  test("(c) a dropped socket discards its unfinished cancel turn", async () => {
    // Given
    const h = await regressionBridge();
    h.bridge.send({ type: "agent.idle", idle: false });
    await h.barrier();
    await h.delta("그만", 0, 200);
    // When: the socket drops before the transcript turn is complete.
    const closed = h.nextPanel((m) => m.type === "state" && m.connection === "closed");
    h.live.drop();
    await closed;
    await h.clock(600);
    // Then: a stale completion callback cannot abort the still-running agent.
    expect(h.bridge.stdout.map((l) => JSON.parse(l)).filter((m) => m.type === "utterance")).toHaveLength(0);
    h.bridge.send({ type: "stop" });
    expect(await bounded(h.bridge.proc.exited, 3000, "regression exit")).toBe(0);
  });

  for (const busy of [{ type: "agent.idle", idle: false }, { type: "agent.tool.start", name: "count" }]) {
    test(`(d) ${busy.type} from idle holds the socket until authoritative idle`, async () => {
      // Given: no voice delegation precedes externally initiated agent work.
      const h = await regressionBridge(true, "2000");
      await h.clock(1500);
      h.bridge.send(busy);
      await h.barrier();
      // When: fake time crosses the old deadline while the agent is busy.
      await h.clock(10000);
      // Then: idle countdown starts only after the agent returns to idle.
      expect(h.live.received.filter((m) => m.type === "session.close")).toHaveLength(0);
      h.bridge.send({ type: "agent.idle", idle: true });
      await h.barrier();
      await h.clock(11999);
      expect(h.live.received.filter((m) => m.type === "session.close")).toHaveLength(0);
      const closed = h.nextPanel((m) => m.type === "state" && m.connection === "closed");
      await h.clock(12000);
      expect(await closed).toMatchObject({ reason: "idle" });
      h.bridge.send({ type: "stop" });
      expect(await bounded(h.bridge.proc.exited, 3000, "regression exit")).toBe(0);
    });
  }

  test("(l) progressing question speech survives the original 15 second deadline", async () => {
    // Given: a long question whose first chunk is still being voiced at 15 seconds.
    const h = await regressionBridge();
    const append = h.live.waitFor("session.commentary.append", 2000);
    h.bridge.send({ type: "agent.question", requestId: "long", header: "h", question: "긴 질문 ".repeat(200), options: [{ label: "예" }] });
    await append;
    const pcm = Buffer.alloc(4800);
    for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
    const progress = async (n: number) => {
      const seen = h.nextPanel((m) => m.type === "transcript" && m.speaker === "assistant" && m.text.endsWith(`${n},`));
      h.live.emit({ type: "session.output_audio.delta", delta: pcm.toString("base64") });
      h.live.emit({ type: "session.output_transcript.delta", delta: `${n},`, start_ms: n, end_ms: n + 100 });
      await seen;
    };
    await progress(0);
    // When: speech keeps progressing, without a silence long enough to end the chunk.
    for (let t = 500; t <= 14500; t += 500) {
      await h.clock(t);
      await progress(t);
    }
    await h.clock(15001);
    // Then: no timeout; the next chunk waits for this one's actual speech end.
    expect(h.bridge.stdout.some((l) => l.includes("question_chunk_timeout"))).toBe(false);
    expect(h.live.received.filter((m) => m.type === "session.commentary.append")).toHaveLength(1);
    await progress(15001);
    const from = h.live.received.length;
    const nextChunk = h.live.waitFor("session.commentary.append", 2000, from);
    await h.clock(15601);
    await nextChunk;
    expect(h.messages.some((m) => m.type === "error" && m.code === "question_speech_timeout")).toBe(false);
    await h.clock(30600);
    h.live.emit({ type: "session.output_audio.delta", delta: Buffer.alloc(4800).toString("base64") });
    const timeout = h.nextPanel((m) => m.type === "error" && m.code === "question_speech_timeout");
    await h.clock(30601);
    expect(await timeout).toMatchObject({ recoverable: true });
    h.bridge.send({ type: "stop" });
    expect(await bounded(h.bridge.proc.exited, 3000, "regression exit")).toBe(0);
  });
});

describe("P4 bridge polish", () => {
  const starts = (h: { live: FakeLive }) => h.live.received.filter((m) => m.type === "session.start");

  test("drop while the user is active reconnects exactly once with history, then reports live_unavailable", async () => {
    // Given: the user has spoken and both sides have transcript lines.
    const h = await regressionBridge();
    await h.speak();
    await h.delta("안녕하세요", 0, 500);
    await h.output("반가워요");
    const from = h.live.received.length;
    const closed = h.nextPanel((m) => m.type === "state" && m.connection === "closed" && m.reason === "live_dropped");
    const connecting = h.nextPanel((m) => m.type === "state" && m.connection === "connecting");
    const reopened = h.nextPanel((m) => m.type === "state" && m.connection === "open");
    const restarted = h.live.waitFor("session.start", 2000, from);
    // When: the socket drops without session.closed.
    h.live.drop();
    // Then: closed(live_dropped), connecting, then a fresh session seeded with the history.
    await closed;
    await connecting;
    await restarted;
    await reopened;
    expect(starts(h)).toHaveLength(2);
    const seeded = h.live.received.slice(from).find((m) => m.type === "session.start")!;
    expect(seeded.session.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "안녕하세요" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "반가워요" }] },
    ]);
    expect(seeded.session.audio.output.voice).toBe("cedar");
    expect(starts(h)[0]!.session.input).toEqual([]);
    // When: the reconnected socket also drops.
    const unavailable = h.nextPanel((m) => m.type === "error" && m.code === "live_unavailable");
    const closedAgain = h.nextPanel((m) => m.type === "state" && m.connection === "closed");
    h.live.drop();
    // Then: no further reconnect.
    expect(await unavailable).toMatchObject({ recoverable: true });
    await closedAgain;
    await h.barrier();
    expect(starts(h)).toHaveLength(2);
    expect(h.bridge.stdout.join("\n")).toContain("live_dropped active=true reconnect=true");
    h.bridge.send({ type: "stop" });
    expect(await bounded(h.bridge.proc.exited, 3000, "exit")).toBe(0);
  });

  test("a drop after more than 30 s without speech does not reconnect", async () => {
    const h = await regressionBridge();
    await h.speak();
    await h.clock(30_001);
    const closed = h.nextPanel((m) => m.type === "state" && m.connection === "closed" && m.reason === "live_dropped");
    h.live.drop();
    await closed;
    await h.barrier();
    expect(starts(h)).toHaveLength(1);
    expect(h.messages.some((m) => m.type === "error" && m.code === "live_dropped")).toBe(true);
    h.bridge.send({ type: "stop" });
    expect(await bounded(h.bridge.proc.exited, 3000, "exit")).toBe(0);
  });

  test("a guard idle close never reconnects", async () => {
    const h = await regressionBridge(true, "2000");
    await h.speak();
    await h.clock(700);
    const closed = h.nextPanel((m) => m.type === "state" && m.connection === "closed");
    await h.clock(5000);
    expect(await closed).toMatchObject({ reason: "idle" });
    await h.barrier();
    expect(starts(h)).toHaveLength(1);
    expect(h.messages.filter((m) => m.type === "state" && m.connection === "connecting")).toHaveLength(1);
    h.bridge.send({ type: "stop" });
    expect(await bounded(h.bridge.proc.exited, 3000, "exit")).toBe(0);
  });

  test("GPT-Live error events become panel error envelopes with a Korean message", async () => {
    const h = await regressionBridge();
    for (const [code, type] of [
      ["invalid_request_error", "invalid_request_error"],
      ["rate_limit_exceeded", "rate_limit_error"],
      ["server_error", "server_error"],
      ["moderation_blocked", "invalid_request_error"],
    ] as const) {
      const seen = h.nextPanel((m) => m.type === "error" && m.code === code);
      h.live.emit({ type: "error", error: { type, code, message: "details" } });
      const msg = (await seen) as Extract<BridgeToPanel, { type: "error" }>;
      expect(msg.message).toMatch(/[가-힣]/);
      expect(msg.message).not.toContain(code);
      expect(msg.recoverable).toBe(true);
    }
    h.bridge.send({ type: "stop" });
    expect(await bounded(h.bridge.proc.exited, 3000, "exit")).toBe(0);
  });

  test("the log file is JSONL, redacted, and holds the final usage", async () => {
    const h = await regressionBridge();
    h.bridge.send({ type: "sk-probe-secret-123" });
    await h.barrier();
    h.bridge.send({ type: "stop" });
    expect(await bounded(h.bridge.proc.exited, 3000, "exit")).toBe(0);
    const dir = join(h.bridge.dataDir, "logs");
    const files = readdirSync(dir).filter((n) => n.endsWith(".log"));
    expect(files).toHaveLength(1);
    const text = readFileSync(join(dir, files[0]!), "utf8");
    const records = text.trim().split("\n").map((l) => JSON.parse(l));
    expect(records.every((r) => typeof r.ts === "string" && typeof r.level === "string")).toBe(true);
    expect(text).not.toContain("sk-");
    expect(text).toContain("[redacted]");
    expect(records.some((r) => String(r.msg).startsWith("final_usage seconds=1"))).toBe(true);
    expect(h.bridge.stdout.join("\n")).not.toContain("sk-");
  });

  test("the panel stop control ends the session like /voice stop", async () => {
    const h = await regressionBridge();
    const closed = h.nextPanel((m) => m.type === "state" && m.connection === "closed");
    h.send({ type: "control", action: "stop" });
    expect(await closed).toMatchObject({ reason: "stop" });
    expect(await bounded(h.bridge.proc.exited, 3000, "exit after panel stop")).toBe(0);
    expect(h.live.received.some((m) => m.type === "session.close")).toBe(true);
    const exits = h.bridge.stdout.map((l) => JSON.parse(l)).filter((m) => m.type === "exit");
    expect(exits).toEqual([{ type: "exit", reason: "stop" }]);
  });
});

describe("bridge/main.ts process", () => {
  test("hello -> ready within 5 s, stop -> exit 0 within 3 s, no key on stdout, Live untouched without a panel", async () => {
    const live = fakeLive();
    cleanups.push(live.stop);
    const bridge = spawnBridge({ OLV_LIVE_URL: live.url, OPENAI_API_KEY: "sk-test" });
    bridge.send(HELLO);
    const ready = await bridge.nextJson("ready", 5000);
    expect(ready.port).toBeGreaterThan(0);
    expect(ready.panelUrl).toBe(`http://127.0.0.1:${ready.port}/?token=${ready.token}`);
    expect(live.received).toHaveLength(0);
    bridge.send({ type: "stop" });
    expect(await bounded(bridge.proc.exited, 3000, "bridge exit after stop")).toBe(0);
    expect(bridge.stdout.join("\n")).not.toContain("sk-");
  });

  test("first panel hello opens the cedar Live session; stop closes it before exit", async () => {
    const live = fakeLive();
    cleanups.push(live.stop);
    const bridge = spawnBridge({ OLV_LIVE_URL: live.url, OPENAI_API_KEY: "sk-test" });
    bridge.send(HELLO);
    const ready = await bridge.nextJson("ready", 5000);
    const ws = new WebSocket(`ws://127.0.0.1:${ready.port}/ws?token=${ready.token}`, {
      headers: { Origin: `http://127.0.0.1:${ready.port}` },
    } as unknown as string[]);
    cleanups.push(() => ws.close());
    const panelMsgs: any[] = [];
    ws.addEventListener("message", (m) => typeof m.data === "string" && panelMsgs.push(JSON.parse(m.data)));
    await bounded(new Promise((r) => ws.addEventListener("open", r)), 3000, "panel ws open");
    ws.send(JSON.stringify({ v: 1, type: "hello", seq: 1, token: ready.token, capabilities: { audioWorklet: true, setSinkId: false }, sampleRate: 24000 }));
    await live.waitFor("session.start", 5000);
    const starts = live.received.filter((m) => m.type === "session.start");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.session.audio.output.voice).toBe("cedar");
    const open = await bridge.nextJson("state", 5000, (s) => s.connection === "open");
    expect(open.muted).toBe(false);
    expect(panelMsgs.some((m) => m.type === "hello" && m.format?.rate === 24000)).toBe(true);
    bridge.send({ type: "stop" });
    await live.waitFor("session.close", 2000);
    expect(await bounded(bridge.proc.exited, 3000, "bridge exit after stop")).toBe(0);
    expect(bridge.stdout.join("\n")).not.toContain("sk-");
  });

  test("stdin EOF before hello exits 0 within 3 s without printing ready", async () => {
    const bridge = spawnBridge({ OLV_LIVE_URL: "ws://127.0.0.1:1", OPENAI_API_KEY: "sk-test" });
    bridge.proc.stdin.end();
    expect(await bounded(bridge.proc.exited, 3000, "bridge exit on EOF")).toBe(0);
    expect(bridge.stdout.some((l) => l.includes('"ready"'))).toBe(false);
  });

  for (const start of ["fresh start", "idle resume", "drop resume"] as const) {
    test(`frame generation drains playback after ${start}`, async () => {
      // Given: a real bridge and a panel that reports the generation from its PCM header.
      const live = fakeLive();
      cleanups.push(live.stop);
      const bridge = spawnBridge({
        OLV_LIVE_URL: live.url, OPENAI_API_KEY: "sk-test", OLV_FAKE_CLOCK: "1", OLV_IDLE_MS: "2000",
      });
      bridge.send(HELLO);
      const ready = await bridge.nextJson("ready", 5000);
      const ws = new WebSocket(`ws://127.0.0.1:${ready.port}/ws?token=${ready.token}`, {
        headers: { Origin: `http://127.0.0.1:${ready.port}` },
      } as unknown as string[]);
      ws.binaryType = "arraybuffer";
      cleanups.push(() => ws.close());
      let seq = 0;
      const send = (msg: object) => ws.send(JSON.stringify({ v: 1, seq: ++seq, ...msg }));
      const nextPanel = (pred: (msg: BridgeToPanel) => boolean, label: string) => {
        const waiting = new Promise<BridgeToPanel>((resolve) => {
          const onMessage = (event: MessageEvent) => {
            if (typeof event.data !== "string") return;
            const msg: BridgeToPanel = JSON.parse(event.data);
            if (pred(msg)) {
              ws.removeEventListener("message", onMessage);
              resolve(msg);
            }
          };
          ws.addEventListener("message", onMessage);
          cleanups.push(() => ws.removeEventListener("message", onMessage));
        });
        return bounded(waiting, 2000, `${start}: ${label}`);
      };
      await bounded(new Promise((resolve) => ws.addEventListener("open", resolve, { once: true })), 3000, "panel open");
      const opened = nextPanel((m) => m.type === "state" && m.connection === "open", "initial open");
      send({ type: "hello", token: ready.token, capabilities: { audioWorklet: true, setSinkId: false }, sampleRate: 24000 });
      await opened;
      let clock = 0;
      if (start !== "fresh start") {
        const closed = nextPanel((m) => m.type === "state" && m.connection === "closed", "closed before resume");
        if (start === "idle resume") {
          clock = 2000;
          bridge.send({ type: "qa.clock", now: clock });
        } else {
          live.drop();
        }
        expect(await closed).toMatchObject({ reason: start === "idle resume" ? "idle" : "live_dropped" });
        const reopened = nextPanel((m) => m.type === "state" && m.connection === "open", "resumed open");
        bridge.send({ type: "resume" });
        await reopened;
      }

      // When: voiced PCM ends, then the panel reports its actual frame fully consumed.
      const frameReceived = bounded(new Promise<ReturnType<typeof decodeFrame>>((resolve) => {
        ws.addEventListener("message", (event) => {
          if (event.data instanceof ArrayBuffer) resolve(decodeFrame(event.data));
        });
      }), 2000, "PCM frame");
      const speaking = nextPanel((m) => m.type === "state" && m.output === "speaking", "output start");
      const pcm = Buffer.alloc(4800);
      for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
      live.emit({ type: "session.output_audio.delta", delta: pcm.toString("base64") });
      const [frame] = await Promise.all([frameReceived, speaking]);
      send({ type: "playback", generation: frame.generation, consumedSamples: 0, bufferedSamples: frame.pcm.length });
      const ended = nextPanel((m) => m.type === "state" && m.output === "speaking", "output ended awaiting drain");
      bridge.send({ type: "qa.clock", now: clock + 600 });
      await ended;
      const drained = nextPanel((m) => m.type === "state" && m.output === "idle", `buffer.drained generation=${frame.generation}`);
      send({ type: "playback", generation: frame.generation, consumedSamples: frame.pcm.length, bufferedSamples: 0 });

      // Then: only buffer.drained can make output idle; fake time never reaches the fallback.
      expect(await drained).toMatchObject({ connection: "open", output: "idle" });
      expect(frame.generation).toBe(start === "fresh start" ? 1 : 3);
      expect(frame.sequence).toBe(0);
      const idleClosed = nextPanel((m) => m.type === "state" && m.connection === "closed", "idle guard close");
      bridge.send({ type: "qa.clock", now: clock + 2000 });
      expect(await idleClosed).toMatchObject({ reason: "idle" });
      bridge.send({ type: "stop" });
      expect(await bounded(bridge.proc.exited, 3000, "bridge exit")).toBe(0);
    }, 15_000);
  }
});
