import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { decodeFrame } from "../shared/protocol.ts";
import type { BridgeToPanel } from "../shared/protocol.ts";

const MAIN = join(import.meta.dir, "../bridge/main.ts");

type FakeLive = { url: string; received: { type: string; session?: any }[]; waitFor(type: string, ms: number): Promise<void>; emit(event: unknown): void; drop(): void; stop(): void };

function fakeLive(): FakeLive {
  const received: FakeLive["received"] = [];
  const waiters: { type: string; resolve: () => void }[] = [];
  let emit: ((event: unknown) => void) | undefined;
  let drop: (() => void) | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        const msg = JSON.parse(String(raw));
        received.push(msg);
        for (const w of waiters.filter((x) => x.type === msg.type)) w.resolve();
        if (msg.type === "session.start") {
          emit = (event) => ws.send(JSON.stringify(event));
          drop = () => ws.close();
          ws.send(JSON.stringify({ type: "session.started", client_event_id: msg.event_id, session: { id: "fake-main", ...msg.session } }));
        } else if (msg.type === "session.close") {
          ws.send(JSON.stringify({ type: "session.closed", reason: "close_requested", usage: { seconds: 1 } }));
        }
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}`,
    received,
    waitFor(type, ms) {
      if (received.some((m) => m.type === type)) return Promise.resolve();
      return bounded(new Promise<void>((resolve) => waiters.push({ type, resolve })), ms, `fake live never got ${type}`);
    },
    emit(event) {
      if (!emit) throw new Error("Live session has not started");
      emit(event);
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

type Bridge = { proc: Subprocess<"pipe", "pipe", "pipe">; stdout: string[]; nextJson(type: string, ms: number, pred?: (j: any) => boolean): Promise<any>; send(msg: unknown): void };

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function spawnBridge(env: Record<string, string>): Bridge {
  const dataDir = mkdtempSync(join(tmpdir(), "olv-main-test-"));
  const proc = Bun.spawn(["bun", MAIN], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", OLV_PORT: "0", OLV_DATA_DIR: dataDir, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  cleanups.push(() => {
    proc.kill("SIGKILL");
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
