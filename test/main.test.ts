import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

const MAIN = join(import.meta.dir, "../bridge/main.ts");

type FakeLive = { url: string; received: { type: string; session?: any }[]; waitFor(type: string, ms: number): Promise<void>; stop(): void };

function fakeLive(): FakeLive {
  const received: FakeLive["received"] = [];
  const waiters: { type: string; resolve: () => void }[] = [];
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
});
