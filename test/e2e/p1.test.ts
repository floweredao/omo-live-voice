// P1 end-to-end: bridge/main.ts against fake GPT-Live, fake extension host and fake panel (plan todo 16).
// Every wait subscribes to an event stream and is bounded; the only timed waits are behaviors whose
// subject is time itself (the 500 ms "fast completion" agent and the fixed WAV/inject schedule).
//
// Topology: fake-live-server <- tap (this process) <- bridge (spawned by fake-ext-host) <- fake-panel.
// The tap is a transparent WebSocket relay: fake-live's OLV_FAKE_LOG records only INBOUND messages, so
// outbound timing (delegation.created, output audio deltas, transcripts) is timestamped here.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { COMMENTARY_CAP_CHARS } from "../../bridge/config.ts";

const wsKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");

const R = join(import.meta.dir, "../..");
const FAKE_LIVE = join(R, "scripts/qa/fake-live-server.ts");
const FAKE_EXT = join(R, "scripts/qa/fake-ext-host.ts");
const FAKE_PANEL = join(R, "scripts/qa/fake-panel.ts");
const WAV_LIST = join(R, "fixtures/ko-list-files.wav");
const WAV_CANCEL = join(R, "fixtures/ko-cancel.wav");
const FAKE_SECURITY = join(R, "test/fixtures/fake-security.sh");
const BUN = process.execPath;
const BASE_ENV = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp" };

class Stream<T> {
  items: T[] = [];
  private subs = new Set<(x: T) => void>();
  push(x: T): void {
    this.items.push(x);
    for (const s of [...this.subs]) s(x);
  }
  wait(pred: (x: T) => boolean, ms: number, label: string, from = 0): Promise<T> {
    for (let i = from; i < this.items.length; i++) if (pred(this.items[i]!)) return Promise.resolve(this.items[i]!);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.subs.delete(sub);
        reject(new Error(`timeout ${ms} ms: ${label}`));
      }, ms);
      const sub = (x: T) => {
        if (!pred(x)) return;
        clearTimeout(timer);
        this.subs.delete(sub);
        resolve(x);
      };
      this.subs.add(sub);
    });
  }
}

function bounded<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<T>((_, rej) => (timer = setTimeout(() => rej(new Error(`timeout ${ms} ms: ${label}`)), ms)))]).finally(() => clearTimeout(timer));
}

function lines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): void {
  void (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
    }
    if (buf) onLine(buf);
  })();
}

const procs: Subprocess[] = [];
const servers: { stop(force?: boolean): void }[] = [];
const dirs: string[] = [];
afterAll(() => {
  for (const p of procs) if (p.exitCode === null && !p.killed) p.kill("SIGKILL");
  for (const s of servers) s.stop(true);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const cps = (s: string) => [...s].length;

type LogEntry = { ts: string; t_ms: number; type: string; event: Record<string, any> };
type TapEvent = { t: number; dir: "in" | "out"; conn: number; type: string; ev: Record<string, any>; voiced?: boolean; bytes?: number };

interface Live {
  proc: Subprocess<"ignore", "pipe", "pipe">;
  logPath: string;
  tapUrl: string;
  tap: Stream<TapEvent>;
  redirectTo(url: string): void;
  log(): LogEntry[];
}

function voicedPcm(b64: string): { voiced: boolean; bytes: number } {
  const buf = Buffer.from(b64, "base64");
  let sum = 0;
  const n = buf.length >> 1;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(i * 2);
    sum += v * v;
  }
  return { voiced: n > 0 && Math.sqrt(sum / n) >= 300, bytes: buf.length };
}

async function startLive(dir: string, env: Record<string, string> = {}): Promise<Live> {
  const logPath = join(dir, "fake-live.jsonl");
  const proc = Bun.spawn([BUN, FAKE_LIVE], { env: { ...BASE_ENV, OLV_FAKE_LOG: logPath, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  procs.push(proc);
  const first = new Stream<string>();
  lines(proc.stdout, (l) => first.push(l));
  const { url } = JSON.parse(await first.wait(() => true, 5000, "fake-live port line")) as { url: string };
  let upstreamUrl = url;

  const tap = new Stream<TapEvent>();
  let connSeq = 0;
  type D = { conn: number; up: WebSocket; queue: (string | Buffer)[] };
  const relay = Bun.serve<D>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const u = new URL(req.url);
      const auth = req.headers.get("authorization");
      const up = new WebSocket(`${upstreamUrl}${u.pathname}${u.search}`, { headers: auth ? { Authorization: auth } : {} } as unknown as string[]);
      return srv.upgrade(req, { data: { conn: ++connSeq, up, queue: [] } }) ? undefined : new Response("tap: ws only", { status: 426 });
    },
    websocket: {
      open(ws) {
        const { up, conn } = ws.data;
        up.onopen = () => {
          for (const m of ws.data.queue) up.send(m);
          ws.data.queue = [];
        };
        up.onmessage = (m) => {
          const raw = String(m.data);
          const ev = JSON.parse(raw) as Record<string, any>;
          const rec: TapEvent = { t: Date.now(), dir: "out", conn, type: String(ev.type), ev };
          if (ev.type === "session.output_audio.delta" && typeof ev.delta === "string") {
            Object.assign(rec, voicedPcm(ev.delta));
            rec.ev = { type: ev.type };
          }
          ws.send(raw);
          tap.push(rec);
        };
        up.onclose = () => ws.close();
      },
      message(ws, raw) {
        const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
        let ev: Record<string, any> = {};
        try {
          ev = JSON.parse(text);
        } catch {
          ev = { type: "_unparsable" };
        }
        if (typeof ev.audio === "string") ev = { type: ev.type, _audio_bytes: Buffer.from(ev.audio, "base64").length };
        tap.push({ t: Date.now(), dir: "in", conn: ws.data.conn, type: String(ev.type), ev });
        if (ws.data.up.readyState === WebSocket.OPEN) ws.data.up.send(raw);
        else ws.data.queue.push(raw as string);
      },
      close(ws) {
        ws.data.up.close();
      },
    },
  });
  servers.push(relay);
  return {
    proc,
    logPath,
    tapUrl: `ws://127.0.0.1:${relay.port}`,
    tap,
    redirectTo(url) {
      upstreamUrl = url;
    },
    log: () =>
      existsSync(logPath)
        ? readFileSync(logPath, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as LogEntry)
        : [],
  };
}

type ExtLine = { t: number; kind: "ready" | "recv" | "sent" | "child-exit" | "other"; msg: Record<string, any> };
type BridgeLog = { t: number; level: string; msg: string };

interface Ext {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  ready: { port: number; token: string; panelUrl: string };
  out: Stream<ExtLine>;
  err: Stream<BridgeLog>;
  emit(msg: unknown): void;
  bridgePid(): Promise<number>;
  quit(): Promise<void>;
}

async function startExt(dir: string, bridgeEnv: Record<string, string>): Promise<Ext> {
  const args = [BUN, FAKE_EXT, "--cwd", dir];
  for (const [k, v] of Object.entries({ OLV_PORT: "0", OLV_DATA_DIR: join(dir, "data"), ...bridgeEnv })) args.push("--env", `${k}=${v}`);
  const proc = Bun.spawn(args, { env: { ...BASE_ENV }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  procs.push(proc);
  const out = new Stream<ExtLine>();
  const err = new Stream<BridgeLog>();
  lines(proc.stdout, (line) => {
    const t = Date.now();
    const sp = line.indexOf(" ");
    const head = sp < 0 ? line : line.slice(0, sp);
    const rest = sp < 0 ? "" : line.slice(sp + 1);
    try {
      if (head === "recv" || head === "sent") out.push({ t, kind: head, msg: JSON.parse(rest) });
      else if (head === "child-exit") out.push({ t, kind: "child-exit", msg: { code: Number(rest) } });
      else if (line.startsWith("{")) out.push({ t, kind: "ready", msg: JSON.parse(line) });
      else out.push({ t, kind: "other", msg: { line } });
    } catch {
      out.push({ t, kind: "other", msg: { line } });
    }
  });
  lines(proc.stderr, (line) => {
    const t = Date.now();
    try {
      const j = JSON.parse(line) as { level?: string; msg?: string };
      err.push({ t, level: String(j.level ?? "?"), msg: String(j.msg ?? line) });
    } catch {
      err.push({ t, level: "raw", msg: line });
    }
  });
  const readyLine = await out.wait((l) => l.kind === "ready" && l.msg.type === "ready", 10_000, "bridge ready via fake-ext");
  const ready = readyLine.msg as Ext["ready"];
  let pid = 0;
  return {
    proc,
    ready,
    out,
    err,
    emit(msg) {
      proc.stdin.write(`emit ${JSON.stringify(msg)}\n`);
      proc.stdin.flush();
    },
    async bridgePid() {
      if (pid) return pid;
      const txt = (await Bun.$`pgrep -P ${proc.pid}`.nothrow().text()).trim();
      pid = Number(txt.split("\n")[0]);
      return pid;
    },
    async quit() {
      if (proc.exitCode !== null) return;
      proc.stdin.write("quit\n");
      proc.stdin.flush();
      await bounded(proc.exited, 6000, "fake-ext quit");
    },
  };
}

const recv = (type: string, pred: (m: Record<string, any>) => boolean = () => true) => (l: ExtLine) => l.kind === "recv" && l.msg.type === type && pred(l.msg);

type PanelSummary = {
  opened: boolean;
  rejected: boolean;
  receivedPcmBytes: number;
  flushes: { generation: number; reason: string }[];
  envelopeTypes: Record<string, number>;
  envelopes: Record<string, any>[];
};

interface Panel {
  proc: Subprocess<"ignore", "pipe", "pipe">;
  envelopes: Stream<Record<string, any>>;
  finish(): Promise<PanelSummary>;
}

function startPanel(dir: string, ext: Ext, extra: string[], name = "panel"): Panel {
  const outPath = join(dir, `${name}.json`);
  const url = `ws://127.0.0.1:${ext.ready.port}/ws?token=${ext.ready.token}`;
  const proc = Bun.spawn([BUN, FAKE_PANEL, "--url", url, "--token", ext.ready.token, "--out", outPath, ...extra], {
    env: { ...BASE_ENV },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  procs.push(proc);
  const envelopes = new Stream<Record<string, any>>();
  lines(proc.stdout, (line) => {
    if (!line.startsWith("envelope ")) return;
    envelopes.push(JSON.parse(line.slice("envelope ".length)) as Record<string, any>);
  });
  return {
    proc,
    envelopes,
    async finish() {
      if (proc.exitCode === null) proc.kill("SIGTERM");
      await bounded(proc.exited, 5000, "fake-panel exit");
      if (!existsSync(outPath)) throw new Error(`fake-panel exited without writing ${outPath}`);
      return JSON.parse(readFileSync(outPath, "utf8")) as PanelSummary;
    },
  };
}

const envs = (s: PanelSummary, type: string) => s.envelopes.filter((e) => e.type === type);

function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "olv-e2e-"));
  dirs.push(d);
  return d;
}

const LONG_TEXT = (() => {
  let t = "파일은 세 개예요. ```ls -la``` 추가로 더 설명하면 ";
  const filler = "각 파일은 설정과 테스트와 문서를 담고 있어요. ";
  while (cps(t) < 600) t += filler;
  return [...t].slice(0, 600).join("");
})();

const LABELS = Array.from({ length: 8 }, (_, i) => {
  let s = `선택지${i + 1} `;
  while (cps(s) < 80) s += `가나다라마바사 `;
  return [...s].slice(0, 79).join("") + String.fromCharCode(0x41 + i);
});

const QUESTION = { type: "agent.question", requestId: "q-long", header: "옵션 선택", question: "어떤 방식으로 진행할까요?", options: LABELS.map((label) => ({ label })) };

type Base = { dir: string; live: Live; ext: Ext; panel: Panel };

async function boot(liveEnv: Record<string, string>, bridgeEnv: Record<string, string>, panelArgs: string[] | null): Promise<Base> {
  const dir = newDir();
  const live = await startLive(dir, liveEnv);
  const ext = await startExt(dir, { OLV_LIVE_URL: live.tapUrl, OPENAI_API_KEY: "sk-test", OLV_IDLE_MS: "200000", ...bridgeEnv });
  const panel = panelArgs ? startPanel(dir, ext, panelArgs) : (null as unknown as Panel);
  return { dir, live, ext, panel };
}

async function teardown(b: Base): Promise<void> {
  await b.ext.quit().catch(() => b.ext.proc.kill("SIGKILL"));
  b.live.proc.kill("SIGTERM");
  await bounded(b.live.proc.exited, 3000, "fake-live exit");
}

const memo = <T>(fn: () => Promise<T>) => {
  let p: Promise<T> | null = null;
  return () => (p ??= fn());
};

const runA = memo(async () => {
  const b = await boot({}, {}, ["--wav", WAV_LIST, "--linger-ms", "60000"]);
  const { live, ext } = b;
  const utt = await ext.out.wait(recv("utterance", (m) => m.kind === "message"), 15_000, "utterance kind=message");
  ext.emit({ type: "agent.tool.start", name: "bash" });
  const deleg = await live.tap.wait((e) => e.type === "session.delegation.created", 1000, "delegation.created (tap)");
  const thinking = await live.tap.wait((e) => e.dir === "in" && e.type === "session.thinking.append", 5000, "session.thinking.append (HOLD)");
  await live.tap.wait((e) => e.type === "session.thinking.appended", 2000, "thinking.appended");
  const endAt = Date.now();
  ext.emit({ type: "agent.end", text: LONG_TEXT });
  const commentary = await live.tap.wait((e) => e.dir === "in" && e.type === "session.commentary.append", 15_000, "session.commentary.append");
  const speaking = await ext.out.wait(recv("state", (m) => m.output === "speaking"), 15_000, "output=speaking", 0);
  const idleIdx = ext.out.items.indexOf(speaking);
  await ext.out.wait(recv("state", (m) => m.output === "idle"), 15_000, "output=idle after commentary", idleIdx + 1);
  const summary = await b.panel.finish();
  const log = live.log();
  await teardown(b);
  return { utt, deleg, thinking, endAt, commentary, summary, log };
});

const run12 = memo(async () => {
  const b = await boot({ OLV_FAKE_OUTPUT_MS: "2000", OLV_FAKE_TRAILING_SILENCE_MS: "20000" }, { OLV_IDLE_MS: "3000" }, ["--wav", WAV_LIST, "--linger-ms", "60000"]);
  const { live, ext } = b;
  await ext.out.wait(recv("utterance", (m) => m.kind === "message"), 15_000, "utterance");
  ext.emit({ type: "agent.end", text: "파일은 세 개예요." });
  await live.tap.wait((e) => e.dir === "in" && e.type === "session.commentary.append", 5000, "commentary.append");
  const firstTone = await live.tap.wait((e) => e.type === "session.output_audio.delta" && e.voiced === true, 5000, "first voiced delta");
  const toneIdx = live.tap.items.indexOf(firstTone);
  const firstSilent = await live.tap.wait((e) => e.type === "session.output_audio.delta" && e.voiced === false, 5000, "first silent delta after tone", toneIdx);
  const lastVoiced = live.tap.items.slice(toneIdx, live.tap.items.indexOf(firstSilent)).filter((e) => e.voiced).at(-1)!;
  const outIdle = await ext.out.wait(recv("state", (m) => m.output === "idle" && m.connection === "open"), 5000, "output=idle", ext.out.items.findIndex((l) => l.kind === "recv" && l.msg.output === "speaking") + 1);
  const closed = await ext.out.wait(recv("state", (m) => m.connection === "closed" && m.reason === "idle"), 10_000, "connection=closed reason=idle");
  const closeIn = await live.tap.wait((e) => e.dir === "in" && e.type === "session.close", 2000, "session.close (tap)");
  const dropLog = await ext.err.wait((l) => /silent_dropped total=\d+/.test(l.msg), 3000, "bridge log silent_dropped");
  const silentBeforeClose = live.tap.items.filter((e) => e.type === "session.output_audio.delta" && e.voiced === false && e.t <= closeIn.t && e.t >= closeIn.t - 300).length;
  const pidBefore = await ext.bridgePid();
  const readyCount = ext.out.items.filter((l) => l.kind === "recv" && l.msg.type === "ready").length;
  const resumeIdx = ext.out.items.length;
  ext.emit({ type: "resume" });
  const reReady = await ext.out.wait(recv("ready"), 5000, "re-sent ready", resumeIdx);
  await ext.out.wait(recv("state", (m) => m.connection === "open"), 5000, "re-opened", resumeIdx);
  const conn2 = live.tap.items.filter((e) => e.type === "session.started").at(-1)!.conn;
  const usage2 = await live.tap.wait((e) => e.conn === conn2 && e.type === "session.usage.updated", 3000, "usage on resumed session");
  await live.tap.wait((e) => e.conn === conn2 && e.type === "session.usage.updated" && e !== usage2, 3000, "2nd usage on resumed session");
  const pidAfter = Number((await Bun.$`pgrep -P ${ext.proc.pid} -f bridge/main.ts`.nothrow().text()).trim().split("\n")[0]);
  const ownBridges = (await Bun.$`pgrep -P ${ext.proc.pid} -f bridge/main.ts`.nothrow().text()).trim().split("\n").filter(Boolean).length;
  const globalBridges = (await Bun.$`pgrep -f bridge/main.ts`.nothrow().text()).trim().split("\n").filter(Boolean).length;
  const summary = await b.panel.finish();
  const log = live.log();
  await teardown(b);
  return { firstTone, lastVoiced, outIdle, closed, closeIn, dropLog, silentBeforeClose, readyCount, reReady, pidBefore, pidAfter, ownBridges, globalBridges, summary, log };
});

async function runQuestion(liveEnv: Record<string, string>, waitDone: "all" | "timeout") {
  const b = await boot(liveEnv, {}, ["--wav", WAV_LIST, "--linger-ms", "60000"]);
  const { live, ext } = b;
  await ext.out.wait(recv("utterance", (m) => m.kind === "message"), 15_000, "utterance");
  const timeoutLogPromise =
    waitDone === "timeout" ? ext.err.wait((l) => l.msg.includes("question_chunk_timeout"), 20_000, "question_chunk_timeout log") : null;
  const timeoutPanelErrorPromise =
    waitDone === "timeout"
      ? b.panel.envelopes.wait((e) => e.type === "error" && e.code === "question_speech_timeout", 20_000, "panel error question_speech_timeout")
      : null;
  const qAt = Date.now();
  ext.emit(QUESTION);
  let timeoutLog: BridgeLog | null = null;
  let timeoutPanelError: Record<string, any> | null = null;
  if (waitDone === "timeout") {
    [timeoutLog, timeoutPanelError] = await Promise.all([timeoutLogPromise!, timeoutPanelErrorPromise!]);
  } else {
    for (let n = 1; ; n++) {
      const append = await live.tap.wait((e) => e.dir === "in" && e.type === "session.instructions.append" && e.ev.event_id?.endsWith(`-${n}`), 20_000, `instructions.append #${n}`);
      const ai = live.tap.items.indexOf(append);
      await live.tap.wait((e) => e.type === "session.output_audio.delta" && e.voiced === true, 15_000, `chunk ${n} voiced`, ai);
      const next = live.tap.wait((e) => e.dir === "in" && e.type === "session.instructions.append" && e.ev.event_id?.endsWith(`-${n + 1}`), 8_000, "next chunk", ai).catch(() => null);
      if (!(await next)) break;
    }
  }
  const summary = await b.panel.finish();
  const log = live.log();
  const tap = [...live.tap.items];
  const errs = [...ext.err.items];
  await teardown(b);
  return { qAt, timeoutLog, timeoutPanelError, summary, log, tap, errs };
}

const runQ = memo(() => runQuestion({}, "all"));
const runQAckAfter = memo(() => runQuestion({ OLV_FAKE_ACK_AFTER_AUDIO: "1" }, "all"));

function assertChunks(r: Awaited<ReturnType<typeof runQuestion>>) {
  const appends = r.log.filter((e) => e.type === "session.instructions.append");
  expect(appends.length).toBeGreaterThanOrEqual(3);
  const contents = appends.map((e) => String(e.event.content));
  for (const c of contents) expect(cps(c)).toBeLessThanOrEqual(COMMENTARY_CAP_CHARS);
  const inOrder = (hay: string) => {
    let at = 0;
    for (const l of LABELS) {
      const i = hay.indexOf(l, at);
      if (i < 0) return false;
      at = i + l.length;
    }
    return true;
  };
  expect(inOrder(contents.join(" "))).toBe(true);
  const outTr = r.tap.filter((e) => e.type === "session.output_transcript.delta").map((e) => String(e.ev.delta));
  expect(inOrder(outTr.join(" "))).toBe(true);
  const panelTr = envs(r.summary, "transcript").filter((e) => e.speaker === "assistant").map((e) => String(e.text));
  expect(inOrder(panelTr.join(" "))).toBe(true);
  // ordering: append n+1 only after chunk n's last voiced delta + 600 ms (tap clock)
  const tapAppends = r.tap.filter((e) => e.dir === "in" && e.type === "session.instructions.append");
  expect(tapAppends.length).toBe(appends.length);
  const gaps: number[] = [];
  for (let n = 0; n + 1 < tapAppends.length; n++) {
    const a = tapAppends[n]!;
    const b = tapAppends[n + 1]!;
    const tr = r.tap.find((e) => e.type === "session.output_transcript.delta" && e.ev.delta === a.ev.content)!;
    expect(tr).toBeDefined();
    const ti = r.tap.indexOf(tr);
    const nextTr = r.tap.find((e, i) => i > ti && e.type === "session.output_transcript.delta");
    const end = nextTr ? r.tap.indexOf(nextTr) : r.tap.length;
    const lastVoiced = r.tap.slice(ti, end).filter((e) => e.type === "session.output_audio.delta" && e.voiced).at(-1);
    expect(lastVoiced).toBeDefined();
    gaps.push(b.t - lastVoiced!.t);
    expect(b.t).toBeGreaterThanOrEqual(lastVoiced!.t + 600);
  }
  return { chunks: appends.length, gaps };
}

describe("P1 e2e: bridge vs fake GPT-Live / extension / panel", () => {
  test("(QA) live_dropped closes both links within 2 s and resumes after two SIGKILL drops", async () => {
    const b = await boot({}, { OLV_FAKE_CLOCK: "1", OLV_IDLE_MS: "200" }, null);
    const ws = new WebSocket(`ws://127.0.0.1:${b.ext.ready.port}/ws?token=${b.ext.ready.token}`, {
      headers: { Origin: `http://127.0.0.1:${b.ext.ready.port}` },
    } as unknown as string[]);
    const messages = new Stream<{ t: number; msg: Record<string, unknown> }>();
    ws.addEventListener("message", (m) => {
      if (typeof m.data === "string") messages.push({ t: Date.now(), msg: JSON.parse(m.data) });
    });
    let current = b.live;
    try {
      await bounded(new Promise((resolve) => ws.addEventListener("open", resolve, { once: true })), 3000, "panel open");
      ws.send(JSON.stringify({ v: 1, type: "hello", seq: 1, token: b.ext.ready.token, capabilities: { audioWorklet: true, setSinkId: false }, sampleRate: 24000 }));
      await b.ext.out.wait(recv("state", (m) => m.connection === "open"), 5000, "initial open");
      for (const [round, action] of ["ext", "panel"].entries()) {
        const extFrom = b.ext.out.items.length;
        const panelFrom = messages.items.length;
        const tapFrom = b.live.tap.items.length;
        const dropped = (m: Record<string, unknown>) => m.connection === "closed" && m.reason === "live_dropped";
        const closedExt = b.ext.out.wait(recv("state", dropped), 2000, "ext closed reason=live_dropped", extFrom);
        const closedPanel = messages.wait((e) => e.msg.type === "state" && dropped(e.msg), 2000, "panel closed reason=live_dropped", panelFrom);
        const errorPanel = messages.wait((e) => e.msg.type === "error" && e.msg.code === "live_dropped", 2000, "panel live_dropped error", panelFrom);
        const observed = Promise.all([closedExt, closedPanel, errorPanel]);
        const killedAt = Date.now();
        current.proc.kill("SIGKILL");
        const [extClosed, panelClosed, error] = await observed;
        expect(extClosed.t - killedAt).toBeLessThanOrEqual(2000);
        expect(panelClosed.t - killedAt).toBeLessThanOrEqual(2000);
        expect(error.msg.recoverable).toBe(true);
        expect(extClosed.msg).toMatchObject({ input: "quiet", output: "idle" });
        await bounded(current.proc.exited, 3000, "killed fake-live exit");
        // Advance past idle, handshake, and cap deadlines while disconnected.
        b.ext.emit({ type: "qa.clock", now: (round + 1) * 4_000_000 });
        current = await startLive(newDir());
        b.live.redirectTo(current.tapUrl);
        const reopened = b.ext.out.wait(recv("state", (m) => m.connection === "open"), 5000, "open after drop resume", extFrom);
        const panelOpen = messages.wait((e) => e.msg.type === "state" && e.msg.connection === "open", 5000, "panel resumed open", panelFrom);
        if (action === "ext") b.ext.emit({ type: "resume" });
        else ws.send(JSON.stringify({ v: 1, type: "control", seq: round + 2, action: "resume" }));
        await Promise.all([reopened, panelOpen]);
        expect(current.log().filter((e) => e.type === "session.start")).toHaveLength(1);
        const starts = b.live.tap.items.slice(tapFrom).filter((e) => e.dir === "in");
        expect(starts.map((e) => e.type)).toEqual(["session.start"]);
        expect(b.ext.out.items.slice(extFrom).filter(recv("state", dropped))).toHaveLength(1);
        console.log(`QA drop=${round + 1} ext_ms=${extClosed.t - killedAt} panel_ms=${panelClosed.t - killedAt} resume=${action} starts=1 dead_socket_sends=0`);
      }
    } finally {
      ws.close();
      await b.ext.quit();
      current.proc.kill("SIGTERM");
      await bounded(current.proc.exited, 3000, "replacement fake-live exit");
    }
  }, 30_000);

  test("(1) utterance kind=message reaches the extension with 파일목록", async () => {
    const a = await runA();
    expect(a.utt.msg.kind).toBe("message");
    expect(String(a.utt.msg.text).replace(/\s+/g, "")).toContain("파일목록");
  }, 60_000);

  test("(2) HOLD: one thinking.append ~2.5 s after delegation, then one capped commentary without backticks", async () => {
    const a = await runA();
    const holdMs = a.thinking.t - a.deleg.t;
    expect(holdMs).toBeGreaterThanOrEqual(2400);
    expect(holdMs).toBeLessThanOrEqual(5000);
    const thinking = a.log.filter((e) => e.type === "session.thinking.append");
    const commentary = a.log.filter((e) => e.type === "session.commentary.append");
    expect(thinking).toHaveLength(1);
    expect(commentary).toHaveLength(1);
    expect(a.log.indexOf(thinking[0]!)).toBeLessThan(a.log.indexOf(commentary[0]!));
    const content = String(commentary[0]!.event.content);
    expect(content).not.toContain("`");
    expect(cps(content)).toBeLessThanOrEqual(COMMENTARY_CAP_CHARS);
    expect(content.endsWith("코드는 화면에 있어요.")).toBe(true);
    expect(commentary[0]!.event.delegation_id).toBe("d1");
  }, 60_000);

  test("(2b) fast completion: agent.end 500 ms after utterance cancels the HOLD (0 thinking, 1 commentary)", async () => {
    const b = await boot({}, {}, ["--wav", WAV_LIST, "--linger-ms", "60000"]);
    const { live, ext } = b;
    await ext.out.wait(recv("utterance", (m) => m.kind === "message"), 15_000, "utterance");
    const deleg = live.tap.items.find((e) => e.type === "session.delegation.created")!;
    await new Promise((r) => setTimeout(r, 500)); // the agent's completion latency is the behavior under test
    ext.emit({ type: "agent.end", text: "파일은 세 개예요." });
    await live.tap.wait((e) => e.type === "session.commentary.appended", 5000, "commentary.appended");
    const sp = await ext.out.wait(recv("state", (m) => m.output === "speaking"), 5000, "speaking");
    const idle = await ext.out.wait(recv("state", (m) => m.output === "idle"), 8000, "idle after speech", ext.out.items.indexOf(sp) + 1);
    // the observation window closes after the HOLD deadline (delegation + 2,500 ms) has passed
    expect(idle.t - deleg.t).toBeGreaterThan(2700);
    await b.panel.finish();
    const log = live.log();
    await teardown(b);
    expect(log.filter((e) => e.type === "session.thinking.append")).toHaveLength(0);
    expect(log.filter((e) => e.type === "session.commentary.append")).toHaveLength(1);
  }, 60_000);

  test("(2c) long question: >= 3 sequenced instructions chunks, each after the previous chunk's speech + 600 ms", async () => {
    const r = await runQ();
    const { chunks, gaps } = assertChunks(r);
    console.log(`2c chunks=${chunks} gaps_ms=${gaps.join(",")}`);
    expect(r.errs.some((l) => l.msg.includes("question_chunk_timeout"))).toBe(false);
  }, 90_000);

  test("(2d) OLV_FAKE_ACK_AFTER_AUDIO=1: identical chunking, no question_chunk_timeout", async () => {
    const r = await runQAckAfter();
    const base = await runQ();
    const { chunks, gaps } = assertChunks(r);
    console.log(`2d chunks=${chunks} gaps_ms=${gaps.join(",")}`);
    expect(r.log.filter((e) => e.type === "session.instructions.append").map((e) => e.event.content)).toEqual(
      base.log.filter((e) => e.type === "session.instructions.append").map((e) => e.event.content),
    );
    expect(r.errs.some((l) => l.msg.includes("question_chunk_timeout"))).toBe(false);
  }, 120_000);

  test("(2e) OLV_FAKE_MUTE_OUTPUT=1: 15 s chunk timeout, panel error question_speech_timeout, exactly one append", async () => {
    const r = await runQuestion({ OLV_FAKE_MUTE_OUTPUT: "1" }, "timeout");
    const appends = r.tap.filter((e) => e.dir === "in" && e.type === "session.instructions.append");
    expect(r.timeoutLog!.t - appends[0]!.t).toBeGreaterThanOrEqual(14_900);
    expect(r.log.filter((e) => e.type === "session.instructions.append")).toHaveLength(1);
    expect(r.timeoutPanelError).toMatchObject({ type: "error", code: "question_speech_timeout", recoverable: true });
    expect(envs(r.summary, "error").some((e) => e.code === "question_speech_timeout")).toBe(true);
  }, 60_000);

  test("(3) panel received >= 48,000 PCM bytes and an assistant transcript", async () => {
    const a = await runA();
    expect(a.summary.receivedPcmBytes).toBeGreaterThanOrEqual(48_000);
    expect(envs(a.summary, "transcript").some((e) => e.speaker === "assistant")).toBe(true);
  }, 60_000);

  test("(4) barge-in '그만' during output: d2, flush, utterance kind=cancel, no message for it", async () => {
    const b = await boot({ OLV_FAKE_TRANSCRIPTS: JSON.stringify(["현재 폴더의 파일 목록을 보여줘", "그만"]) }, {}, [
      "--wav", WAV_LIST, "--inject-at", "4500", WAV_CANCEL, "--linger-ms", "60000",
    ]);
    const { live, ext } = b;
    await ext.out.wait(recv("utterance", (m) => m.kind === "message"), 15_000, "first utterance");
    ext.emit({ type: "agent.question", requestId: "q-short", header: "확인", question: "진행할까요?", options: [{ label: "예" }, { label: "아니요" }] });
    const d2 = await live.tap.wait((e) => e.type === "session.delegation.created" && e.ev.delegation?.id === "d2", 15_000, "delegation d2");
    const d1i = live.tap.items.findIndex((e) => e.type === "session.delegation.created" && e.ev.delegation?.id === "d1");
    const tr2 = live.tap.items.slice(d1i, live.tap.items.indexOf(d2)).filter((e) => e.type === "session.input_transcript.delta").map((e) => e.ev.delta).join("");
    const cancel = await ext.out.wait(recv("utterance", (m) => m.kind === "cancel"), 15_000, "utterance kind=cancel");
    await ext.out.wait(recv("state", (m) => m.agent === "cancelling"), 3000, "agent=cancelling");
    const summary = await b.panel.finish();
    const utts = ext.out.items.filter((l) => l.kind === "recv" && l.msg.type === "utterance");
    await teardown(b);
    expect(tr2).toBe("그만");
    expect(summary.flushes.some((f) => f.reason === "barge-in")).toBe(true);
    expect(String(cancel.msg.text)).toContain("그만");
    expect(utts.filter((l) => l.msg.kind === "message")).toHaveLength(1);
    expect(utts.filter((l) => l.msg.kind === "cancel")).toHaveLength(1);
  }, 60_000);

  test("(5) --mute-at 500: session.input_audio.mute sent, appends stop", async () => {
    const b = await boot({}, {}, ["--wav", WAV_LIST, "--mute-at", "500", "--linger-ms", "1500"]);
    const { live, ext } = b;
    await live.tap.wait((e) => e.type === "session.input_audio.muted", 5000, "muted ack");
    // the observation window runs from mute to session.close (sent when the panel's own exit disconnects it)
    await bounded(b.panel.proc.exited, 15_000, "panel exit");
    await live.tap.wait((e) => e.dir === "in" && e.type === "session.close", 3000, "session.close");
    const log = live.log();
    await b.panel.finish();
    await teardown(b);
    const mute = log.find((e) => e.type === "session.input_audio.mute")!;
    const close = log.find((e) => e.type === "session.close")!;
    expect(mute).toBeDefined();
    expect(close.t_ms - mute.t_ms).toBeGreaterThanOrEqual(1000);
    const after = log.filter((e) => e.type === "session.input_audio.append" && e.t_ms > mute.t_ms + 150);
    expect(after).toHaveLength(0);
    expect(log.filter((e) => e.type === "session.input_audio.append" && e.t_ms <= mute.t_ms).length).toBeGreaterThan(0);
    void ext;
  }, 60_000);

  test("(6) OLV_IDLE_MS=200 without audio: session.close within 2 s, panel state closed reason=idle", async () => {
    const b = await boot({}, { OLV_IDLE_MS: "200" }, ["--tail-ms", "0", "--linger-ms", "60000"]);
    const { live, ext } = b;
    await ext.out.wait(recv("state", (m) => m.connection === "closed" && m.reason === "idle"), 5000, "closed idle (ext)");
    await live.tap.wait((e) => e.type === "session.closed", 3000, "session.closed");
    const summary = await b.panel.finish();
    const log = live.log();
    await teardown(b);
    const start = log.find((e) => e.type === "session.start")!;
    const close = log.find((e) => e.type === "session.close")!;
    expect(close.t_ms - start.t_ms).toBeLessThanOrEqual(2000);
    expect(envs(summary, "state").some((e) => e.connection === "closed" && e.reason === "idle")).toBe(true);
  }, 30_000);

  test("(7) wrong token is refused with 401", async () => {
    const b = await boot({}, {}, null);
    const res = await fetch(`http://127.0.0.1:${b.ext.ready.port}/ws?token=wrong`, {
      headers: { Origin: `http://127.0.0.1:${b.ext.ready.port}`, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": wsKey() },
    });
    const bad = Bun.spawn([BUN, FAKE_PANEL, "--url", `ws://127.0.0.1:${b.ext.ready.port}/ws?token=wrong`, "--token", "wrong", "--expect-reject"], { env: { ...BASE_ENV }, stdout: "pipe", stderr: "pipe" });
    procs.push(bad);
    const code = await bounded(bad.exited, 5000, "expect-reject panel");
    const log = b.live.log();
    await teardown(b);
    expect(res.status).toBe(401);
    expect(code).toBe(0);
    expect(log.filter((e) => e.type === "session.start")).toHaveLength(0);
  }, 30_000);

  test("(8) OLV_FAKE_REJECT_VOICE=1: live_start_failed to panel, exit cedar_rejected, non-zero, one cedar start, no retry", async () => {
    const b = await boot({ OLV_FAKE_REJECT_VOICE: "1" }, {}, ["--linger-ms", "60000"]);
    const { live, ext } = b;
    const exit = await ext.out.wait(recv("exit"), 10_000, "exit message");
    const childExit = await ext.out.wait((l) => l.kind === "child-exit", 5000, "child-exit");
    const hostCode = await bounded(ext.proc.exited, 5000, "fake-ext exit");
    const summary = await b.panel.finish();
    const log = live.log();
    live.proc.kill("SIGTERM");
    await bounded(live.proc.exited, 3000, "fake-live exit");
    expect(exit.msg.reason).toBe("cedar_rejected");
    expect(childExit.msg.code).not.toBe(0);
    expect(hostCode).not.toBe(0);
    expect(envs(summary, "error").some((e) => e.code === "live_start_failed")).toBe(true);
    const starts = log.filter((e) => e.type === "session.start");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.event.session.audio.output.voice).toBe("cedar");
  }, 30_000);

  test("(9) closing the extension host's stdin closes Live within 2 s and the bridge exits within 3 s", async () => {
    const b = await boot({}, {}, ["--linger-ms", "60000"]);
    const { live, ext } = b;
    await ext.out.wait(recv("state", (m) => m.connection === "open"), 5000, "open");
    const pid = await ext.bridgePid();
    expect(pid).toBeGreaterThan(0);
    const t0 = Date.now();
    ext.proc.stdin.end();
    const close = await live.tap.wait((e) => e.dir === "in" && e.type === "session.close", 2000, "session.close after stdin close");
    await bounded(ext.proc.exited, 3000, "host+bridge exit");
    const exitMs = Date.now() - t0;
    const alive = (await Bun.$`kill -0 ${pid}`.nothrow().quiet()).exitCode === 0;
    await b.panel.finish();
    live.proc.kill("SIGTERM");
    await bounded(live.proc.exited, 3000, "fake-live exit");
    expect(close.t - t0).toBeLessThanOrEqual(2000);
    expect(exitMs).toBeLessThanOrEqual(3000);
    expect(alive).toBe(false);
  }, 30_000);

  test("(10) key from OLV_SECURITY_BIN: no OPENAI_API_KEY and no sk- in the bridge's environment", async () => {
    const dir = newDir();
    const live = await startLive(dir);
    const ext = await startExt(dir, { OLV_LIVE_URL: live.tapUrl, OLV_IDLE_MS: "200000", OLV_SECURITY_BIN: FAKE_SECURITY });
    const panel = startPanel(dir, ext, ["--linger-ms", "60000"]);
    await ext.out.wait(recv("state", (m) => m.connection === "open"), 5000, "open with keychain key");
    const pid = await ext.bridgePid();
    const ps = await Bun.$`ps -E -p ${pid}`.nothrow().text();
    await panel.finish();
    await teardown({ dir, live, ext, panel });
    expect(ps).toContain("OLV_SECURITY_BIN="); // ps -E really printed the environment
    expect(ps).not.toContain("OPENAI_API_KEY");
    expect(ps).not.toContain("sk-");
  }, 30_000);

  test("(11) latency: delegation.created -> extension utterance <= 1,500 ms", async () => {
    const a = await runA();
    const ms = a.utt.t - a.deleg.t;
    console.log(`11 latency_ms=${ms}`);
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThanOrEqual(1500);
  }, 60_000);

  test("(12) playback returns to idle: <= 600 ms trailing silence forwarded, output=idle <= 1.5 s, idle close during silence", async () => {
    const r = await run12();
    const toneBytes = (2000 / 100) * 4800;
    console.log(`12 panelPcm=${r.summary.receivedPcmBytes} idle_after_last_voiced_ms=${r.outIdle.t - r.lastVoiced.t} ${r.dropLog.msg}`);
    expect(r.summary.receivedPcmBytes).toBeGreaterThanOrEqual(toneBytes - 4800);
    expect(r.summary.receivedPcmBytes).toBeLessThanOrEqual(toneBytes + 600 * 48 + 4800);
    expect(Number(/total=(\d+)/.exec(r.dropLog.msg)![1])).toBeGreaterThan(0);
    expect(r.outIdle.t - r.lastVoiced.t).toBeLessThanOrEqual(1500);
    expect(r.silentBeforeClose).toBeGreaterThan(0);
    expect(r.closeIn.t - r.firstTone.t).toBeLessThan(20_000);
  }, 90_000);

  test("(13) resume after idle close: second session.start, ready re-sent, cumulativeMs continues, one bridge", async () => {
    const r = await run12();
    const starts = r.log.filter((e) => e.type === "session.start");
    expect(starts).toHaveLength(2);
    expect(starts.every((s) => s.event.session.audio.output.voice === "cedar")).toBe(true);
    expect(r.reReady.msg.port).toBeGreaterThan(0);
    const env = r.summary.envelopes;
    const closedAt = env.findIndex((e) => e.type === "state" && e.connection === "closed" && e.reason === "idle");
    const reopenAt = env.findIndex((e, i) => i > closedAt && e.type === "state" && e.connection === "open");
    const before = env.slice(0, reopenAt).filter((e) => e.type === "cost").at(-1)!;
    const after = env.slice(reopenAt).filter((e) => e.type === "cost");
    console.log(`13 cumulativeMs before=${before?.cumulativeMs} after=${after.map((c) => c.cumulativeMs).join(",")} pid=${r.pidBefore}->${r.pidAfter} ownBridges=${r.ownBridges} globalBridges=${r.globalBridges}`);
    expect(before.cumulativeMs).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(0);
    expect(after[0]!.cumulativeMs).toBeGreaterThanOrEqual(before.cumulativeMs);
    expect(r.ownBridges).toBe(1);
    expect(r.pidAfter).toBe(r.pidBefore);
  }, 90_000);
});
