import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFrame } from "../shared/protocol.ts";
import { createToken, startServer, type Logger, type PanelConn, type PanelServer } from "../bridge/server.ts";

const TOKEN = "a".repeat(64);
const wsKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
let panelDir = "";
const servers: PanelServer[] = [];
const sockets: WebSocket[] = [];

beforeAll(() => {
  panelDir = mkdtempSync(join(tmpdir(), "olv-server-test-"));
  writeFileSync(join(panelDir, "index.html"), "<!doctype html><title>panel</title><script src=\"/assets/app.js\"></script>");
  mkdirSync(join(panelDir, "worklets"));
  writeFileSync(join(panelDir, "app.js"), "console.log('panel');");
  writeFileSync(join(panelDir, "worklets", "capture.worklet.js"), "// worklet");
});
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const s of servers.splice(0)) await s.close();
});
afterAll(() => rmSync(panelDir, { recursive: true, force: true }));

const logs: [string, string][] = [];
const log: Logger = (level, msg) => void logs.push([level, msg]);

async function start(onPanel: (c: PanelConn) => void = () => {}, port = 0, allowedOrigins: string[] = []) {
  const s = await startServer({ panelDir, token: TOKEN, allowedOrigins, onPanel, port, log });
  servers.push(s);
  return s;
}

function withTimeout<T>(p: Promise<T>, what: string, ms = 2000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms))]);
}

type Probe = { ws: WebSocket; messages: any[]; next(): Promise<any>; closed: Promise<{ code: number; reason: string }> };

async function connect(port: number, origin = `http://127.0.0.1:${port}`): Promise<Probe> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`, { headers: { Origin: origin } } as any);
  ws.binaryType = "arraybuffer";
  sockets.push(ws);
  const messages: any[] = [];
  const waiters: ((m: any) => void)[] = [];
  ws.addEventListener("message", (ev) => {
    const m = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
    const w = waiters.shift();
    if (w) w(m);
    else messages.push(m);
  });
  const closed = new Promise<{ code: number; reason: string }>((res) => ws.addEventListener("close", (ev) => res({ code: ev.code, reason: ev.reason })));
  await withTimeout(new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res(), { once: true });
    ws.addEventListener("error", () => rej(new Error("ws error")), { once: true });
  }), "open");
  const next = () => withTimeout(messages.length ? Promise.resolve(messages.shift()) : new Promise<any>((res) => waiters.push(res)), "message");
  return { ws, messages, next, closed };
}

const hello = (seq = 1) =>
  JSON.stringify({ v: 1, type: "hello", seq, token: TOKEN, capabilities: { audioWorklet: true, setSinkId: true }, sampleRate: 24000 });

function rawUpgrade(port: number, query: string, origin: string) {
  return fetch(`http://127.0.0.1:${port}/ws${query}`, {
    headers: {
      Origin: origin,
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": wsKey(),
    },
  });
}

test("GET / serves the panel without embedding the token; assets are served", async () => {
  const s = await start();
  expect(s.url).toBe(`http://127.0.0.1:${s.port}/?token=${TOKEN}`);
  const res = await fetch(s.url);
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("<title>panel</title>");
  expect(body).not.toContain(TOKEN);
  const asset = await fetch(`http://127.0.0.1:${s.port}/assets/app.js`);
  expect(asset.status).toBe(200);
  expect(await asset.text()).toBe("console.log('panel');");
  expect((await fetch(`http://127.0.0.1:${s.port}/assets/worklets/capture.worklet.js`)).status).toBe(200);
  expect((await fetch(`http://127.0.0.1:${s.port}/assets/..%2F..%2Fetc%2Fpasswd`)).status).not.toBe(200);
});

test("/ws without token -> 401 unauthorized", async () => {
  const s = await start();
  const res = await rawUpgrade(s.port, "", `http://127.0.0.1:${s.port}`);
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "unauthorized" });
  const wrong = await rawUpgrade(s.port, "?token=nope", `http://127.0.0.1:${s.port}`);
  expect(wrong.status).toBe(401);
});

test("/ws with token but foreign or missing Origin -> 401", async () => {
  const s = await start();
  const evil = await rawUpgrade(s.port, `?token=${TOKEN}`, "https://evil.example");
  expect(evil.status).toBe(401);
  expect(await evil.json()).toEqual({ error: "unauthorized" });
  const noOrigin = await fetch(`http://127.0.0.1:${s.port}/ws?token=${TOKEN}`, {
    headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": wsKey() },
  });
  expect(noOrigin.status).toBe(401);
});

test("/ws with token and own Origin upgrades (101) and hello binds the panel", async () => {
  let bound: PanelConn | null = null;
  const gotPanel = Promise.withResolvers<void>();
  const s = await start((c) => {
    bound = c;
    gotPanel.resolve();
  });
  const p = await connect(s.port);
  p.ws.send(hello());
  await withTimeout(gotPanel.promise, "onPanel");
  expect(bound!.hello.sampleRate).toBe(24000);
  expect(s.broadcast({ type: "flush", generation: 2, reason: "barge-in" })).toBe(true);
  const msg = await p.next();
  expect(msg).toMatchObject({ v: 1, type: "flush", generation: 2, reason: "barge-in" });
  expect(typeof msg.seq).toBe("number");
  expect(s.sendPcm(3, 7, new Int16Array([1, -1]))).toBe(true);
  const frame = new DataView(await p.next());
  expect([frame.getUint32(0, true), frame.getUint32(4, true), frame.getInt16(8, true), frame.getInt16(10, true)]).toEqual([3, 7, 1, -1]);
});

test("allowedOrigins admits an extra origin", async () => {
  const s = await start(() => {}, 0, ["https://app.example"]);
  const p = await connect(s.port, "https://app.example");
  expect(p.ws.readyState).toBe(WebSocket.OPEN);
});

test("second hello from another socket -> error panel_taken and closed", async () => {
  const s = await start();
  const first = await connect(s.port);
  first.ws.send(hello());
  const second = await connect(s.port);
  second.ws.send(hello());
  expect(await second.next()).toMatchObject({ v: 1, type: "error", code: "panel_taken", recoverable: false });
  const c = await withTimeout(second.closed, "second close");
  expect(c.code).toBe(4409);
  expect(first.ws.readyState).toBe(WebSocket.OPEN);
});

test("controller leaving frees the slot for a new panel", async () => {
  const binds = [Promise.withResolvers<PanelConn>(), Promise.withResolvers<PanelConn>()];
  let n = 0;
  const s = await start((c) => binds[n++]!.resolve(c));
  const first = await connect(s.port);
  first.ws.send(hello());
  const conn1 = await withTimeout(binds[0]!.promise, "first bind");
  const closed = Promise.withResolvers<void>();
  conn1.onClose(() => closed.resolve());
  first.ws.close();
  await withTimeout(closed.promise, "controller close");
  expect(s.broadcast({ type: "flush", generation: 1, reason: "stop" })).toBe(false);
  const second = await connect(s.port);
  second.ws.send(hello());
  await withTimeout(binds[1]!.promise, "rebind");
  expect(s.broadcast({ type: "flush", generation: 1, reason: "stop" })).toBe(true);
  expect(await second.next()).toMatchObject({ type: "flush" });
});

test("a 9-byte binary frame -> error envelope (connection stays open)", async () => {
  const s = await start();
  const p = await connect(s.port);
  p.ws.send(hello());
  p.ws.send(new Uint8Array(9));
  const err = await p.next();
  expect(err).toMatchObject({ v: 1, type: "error", code: "bad_frame", recoverable: true });
  expect(err.message).toContain("odd payload");
  expect(p.ws.readyState).toBe(WebSocket.OPEN);
});

test("valid mic frames reach onPcm; envelopes reach onMessage", async () => {
  const pcm = Promise.withResolvers<{ generation: number; sequence: number; pcm: Int16Array }>();
  const msg = Promise.withResolvers<any>();
  const s = await start((c) => {
    c.onPcm((f) => pcm.resolve(f));
    c.onMessage((m) => msg.resolve(m));
  });
  const p = await connect(s.port);
  p.ws.send(hello());
  p.ws.send(encodeFrame(5, 9, new Int16Array([100, 200, 300])));
  p.ws.send(JSON.stringify({ v: 1, type: "control", seq: 2, action: "mute" }));
  const f = await withTimeout(pcm.promise, "pcm");
  expect([f.generation, f.sequence, Array.from(f.pcm)]).toEqual([5, 9, [100, 200, 300]]);
  expect(await withTimeout(msg.promise, "msg")).toMatchObject({ type: "control", action: "mute" });
});

test("three malformed frames -> close 1008", async () => {
  const s = await start();
  const p = await connect(s.port);
  p.ws.send("not json");
  p.ws.send(JSON.stringify({ v: 2, type: "hello", seq: 1 }));
  p.ws.send(new Uint8Array(3));
  const errs = [await p.next(), await p.next(), await p.next()];
  expect(errs.map((e) => e.code)).toEqual(["bad_envelope", "bad_envelope", "bad_frame"]);
  expect(errs.map((e) => e.recoverable)).toEqual([true, true, false]);
  expect((await withTimeout(p.closed, "close 1008")).code).toBe(1008);
});

test("hello with a wrong token is refused with 1008", async () => {
  const bound = { called: false };
  const s = await start(() => (bound.called = true));
  const p = await connect(s.port);
  p.ws.send(JSON.stringify({ v: 1, type: "hello", seq: 1, token: "x", capabilities: {}, sampleRate: 24000 }));
  expect(await p.next()).toMatchObject({ type: "error", code: "unauthorized" });
  expect((await withTimeout(p.closed, "close")).code).toBe(1008);
  expect(bound.called).toBe(false);
});

test("EADDRINUSE on the requested port falls back to an ephemeral port with warn port_fallback", async () => {
  const blocker = await start();
  logs.length = 0;
  const s = await start(() => {}, blocker.port);
  expect(s.port).not.toBe(blocker.port);
  expect(logs).toContainEqual(["warn", "port_fallback"]);
  expect(logs.filter(([l]) => l === "info").some(([, m]) => m.includes(TOKEN))).toBe(false);
});

test("createToken: 64 hex chars from getRandomValues, or OLV_TEST_TOKEN with warn test_token", () => {
  const a = createToken({}, log);
  const b = createToken({}, log);
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(a).not.toBe(b);
  logs.length = 0;
  expect(createToken({ OLV_TEST_TOKEN: "qa-token" }, log)).toBe("qa-token");
  expect(logs).toEqual([["warn", "test_token"]]);
});
