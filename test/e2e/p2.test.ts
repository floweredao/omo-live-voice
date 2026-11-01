// P2 end-to-end (plan todo 21): the real panel in an OWNED headless Chromium with fake media, plus the real
// /voice extension inside a headless `omo --mode rpc`, both against fake GPT-Live.
//
// Topology (panel tests): fake-live-server <- tap (this process) <- bridge (spawned by fake-ext-host) <- Chromium panel.
// The tap timestamps every Live event in both directions. A page init script records the bridge's `flush` envelopes and
// every write to window.__olv.stats, and fires an `olv-stats` event on each write, so page waits are event-driven
// (MutationObserver + that event) and bounded. There are no fixed sleeps.
//
// Browser: OLV_E2E_CHROME, else a Chrome/Chromium install, else Chrome for Testing under $TMPDIR/olv-e2e-browser, run
// with --headless=new. The profile is a fresh mkdtemp `olv-e2e-profile-*` (never the user's profile).
// chrome-headless-shell is not used: it has no permission manager, so a denied mic rejects with NotSupportedError
// instead of NotAllowedError and the denial path (test 9) cannot be exercised.
// `--disable-features=AudioServiceSandbox` is required on macOS: with the sandbox on, the audio service cannot read the
// --use-file-for-fake-audio-capture file and the fake mic is digital silence (measured: peak 0 vs 0.61 without it).
// `%noloop` plays the WAV once instead of looping it, so later steps are not disturbed by repeated utterances.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

const R = join(import.meta.dir, "../..");
const H = process.env.OLV_E2E_SHOT_DIR ?? join(tmpdir(), "olv-e2e-shots");
const FAKE_LIVE = join(R, "scripts/qa/fake-live-server.ts");
const FAKE_EXT = join(R, "scripts/qa/fake-ext-host.ts");
const FAKE_PANEL = join(R, "scripts/qa/fake-panel.ts");
const WAV_LIST = join(R, "fixtures/ko-list-files.wav");
const WAV_CANCEL = join(R, "fixtures/ko-cancel.wav");
const OMO = "/Applications/OmO.app/Contents/Resources/omo-runtime/darwin-arm64/omo";
const BROWSER_SKILL = "/Applications/OmO.app/Contents/Resources/omo-runtime/darwin-arm64/plugin/skills/browser";
const BUN = process.execPath;
const TMP = tmpdir();
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
const browsers: { close(): Promise<void> }[] = [];
const tempDir = (prefix: string) => {
  const d = mkdtempSync(join(TMP, prefix));
  dirs.push(d);
  return d;
};

afterAll(async () => {
  for (const b of browsers) await b.close().catch(() => undefined);
  for (const p of procs) if (p.exitCode === null && !p.killed) p.kill("SIGKILL");
  for (const s of servers) s.stop(true);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

type TapEvent = { t: number; dir: "in" | "out"; conn: number; type: string; ev: Record<string, any>; voiced?: boolean };

interface Live {
  tapUrl: string;
  tap: Stream<TapEvent>;
}

function voiced(b64: string): boolean {
  const buf = Buffer.from(b64, "base64");
  const n = buf.length >> 1;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(i * 2);
    sum += v * v;
  }
  return n > 0 && Math.sqrt(sum / n) >= 300;
}

async function startLive(dir: string, env: Record<string, string> = {}): Promise<Live> {
  const proc = Bun.spawn([BUN, FAKE_LIVE], { env: { ...BASE_ENV, OLV_FAKE_LOG: join(dir, "fake-live.jsonl"), ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  procs.push(proc);
  const first = new Stream<string>();
  lines(proc.stdout, (l) => first.push(l));
  const { url } = JSON.parse(await first.wait(() => true, 5000, "fake-live port line")) as { url: string };
  const tap = new Stream<TapEvent>();
  let connSeq = 0;
  type D = { conn: number; up: WebSocket; queue: (string | Buffer)[] };
  const relay = Bun.serve<D>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const u = new URL(req.url);
      const auth = req.headers.get("authorization");
      const up = new WebSocket(`${url}${u.pathname}${u.search}`, { headers: auth ? { Authorization: auth } : {} } as unknown as string[]);
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
            rec.voiced = voiced(ev.delta);
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
        if (typeof ev.audio === "string") ev = { type: ev.type };
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
  return { tapUrl: `ws://127.0.0.1:${relay.port}`, tap };
}

type ExtLine = { t: number; kind: "ready" | "recv" | "sent" | "other"; msg: Record<string, any> };

interface Ext {
  ready: { port: number; token: string; panelUrl: string };
  out: Stream<ExtLine>;
  emit(msg: unknown): void;
  quit(): Promise<void>;
}

async function startExt(dir: string, bridgeEnv: Record<string, string>): Promise<Ext> {
  const args = [BUN, FAKE_EXT, "--cwd", dir];
  for (const [k, v] of Object.entries({ OLV_PORT: "0", OLV_DATA_DIR: join(dir, "data"), OPENAI_API_KEY: "sk-test", OLV_QA: "1", ...bridgeEnv })) args.push("--env", `${k}=${v}`);
  const proc = Bun.spawn(args, { env: { ...BASE_ENV }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  procs.push(proc);
  const out = new Stream<ExtLine>();
  lines(proc.stdout, (line) => {
    const t = Date.now();
    const sp = line.indexOf(" ");
    const head = sp < 0 ? line : line.slice(0, sp);
    try {
      if (head === "recv" || head === "sent") out.push({ t, kind: head, msg: JSON.parse(line.slice(sp + 1)) });
      else if (line.startsWith("{")) out.push({ t, kind: "ready", msg: JSON.parse(line) });
      else out.push({ t, kind: "other", msg: { line } });
    } catch {
      out.push({ t, kind: "other", msg: { line } });
    }
  });
  lines(proc.stderr, () => undefined);
  const ready = (await out.wait((l) => l.kind === "ready" && l.msg.type === "ready", 10_000, "bridge ready via fake-ext")).msg as Ext["ready"];
  return {
    ready,
    out,
    emit(msg) {
      proc.stdin.write(`emit ${JSON.stringify(msg)}\n`);
      proc.stdin.flush();
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

type Page = {
  goto(url: string, opts?: unknown): Promise<unknown>;
  click(selector: string): Promise<unknown>;
  evaluate(src: string): Promise<any>;
  screenshot(opts?: unknown): Promise<Uint8Array>;
  resolveSessionId(): Promise<string>;
  cdp: { send(method: string, params: unknown, sessionId?: string): Promise<any> };
};
type Browser = { newTab(url: string): Promise<Page>; close(): Promise<void> };
let OW: any;

function chromePath(): string {
  const candidates = [
    process.env.OLV_E2E_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    join(TMP, "olv-e2e-browser/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
  ].filter((c): c is string => !!c);
  const hit = candidates.find((c) => existsSync(c));
  if (!hit) throw new Error(`no Chromium found; set OLV_E2E_CHROME (tried ${candidates.join(", ")})`);
  return hit;
}

const INIT_SCRIPT = `(() => {
  const rec = (window.__olvRec = { flush: [], stats: [] });
  const Orig = window.WebSocket;
  window.WebSocket = class extends Orig {
    constructor(...a) {
      super(...a);
      this.addEventListener("message", (ev) => {
        if (typeof ev.data !== "string") return;
        try { const m = JSON.parse(ev.data); if (m.type === "flush") rec.flush.push({ t: Date.now(), generation: m.generation, reason: m.reason }); } catch {}
      });
    }
  };
  let olv;
  Object.defineProperty(window, "__olv", {
    configurable: true,
    get() { return olv; },
    set(v) {
      olv = v;
      const st = v && v.stats;
      if (!st) return;
      for (const key of ["consumed", "buffered", "lastFlushAck"]) {
        let val = st[key];
        Object.defineProperty(st, key, {
          enumerable: true,
          get() { return val; },
          set(x) { val = x; rec.stats.push({ t: Date.now(), key, v: x }); window.dispatchEvent(new Event("olv-stats")); },
        });
      }
    },
  });
})();`;

async function launch(opts: { fakeUi: boolean }): Promise<Browser> {
  const profile = tempDir("olv-e2e-profile-");
  const args = [
    "--headless=new",
    "--no-first-run",
    `--user-data-dir=${profile}`,
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${WAV_LIST}%noloop`,
    "--disable-features=AudioServiceSandbox",
    "--autoplay-policy=no-user-gesture-required",
    opts.fakeUi ? "--use-fake-ui-for-media-stream" : "--deny-permission-prompts",
  ];
  const browser = (await OW.connectPipe({ browserPath: chromePath(), browserArgs: args, storageRoot: profile, dialogPolicy: { accept: true } })) as Browser;
  browsers.push(browser);
  return browser;
}

async function openPanel(browser: Browser, url: string, denyMic = false): Promise<Page> {
  const page = await browser.newTab("about:blank");
  if (denyMic) await page.cdp.send("Browser.setPermission", { permission: { name: "microphone" }, setting: "denied", origin: new URL(url).origin });
  await page.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INIT_SCRIPT }, await page.resolveSessionId());
  await page.goto(url);
  await page.click("body");
  return page;
}

async function waitPage<T = unknown>(page: Page, expr: string, ms: number, label: string): Promise<T> {
  const src = `new Promise((resolve) => {
    const read = () => { try { return (${expr}); } catch (e) { return undefined; } };
    let done = false;
    const finish = (r) => { if (done) return; done = true; mo.disconnect(); window.removeEventListener("olv-stats", check); clearTimeout(timer); resolve(JSON.stringify(r)); };
    const check = () => { const v = read(); if (v) finish({ ok: true, v }); };
    const mo = new MutationObserver(check);
    mo.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    window.addEventListener("olv-stats", check);
    const timer = setTimeout(() => finish({ ok: false, v: read() ?? null }), ${ms});
    check();
  })`;
  const r = JSON.parse(await page.evaluate(src)) as { ok: boolean; v: T };
  if (!r.ok) throw new Error(`timeout ${ms} ms: ${label} (last=${JSON.stringify(r.v)})`);
  return r.v;
}

const text = (id: string) => `(document.querySelector('[data-testid=${id}]')?.textContent ?? '')`;
const visible = (id: string) => `(document.querySelector('[data-testid=${id}]') && !document.querySelector('[data-testid=${id}]').hidden)`;

let panelDir = "";

beforeAll(async () => {
  ({ omowright: OW } = await (await import(join(BROWSER_SKILL, "scripts/omowright.mjs"))).loadOmowright());
  const build = Bun.spawn([BUN, "scripts/build-panel.ts"], { cwd: R, stdout: "pipe", stderr: "pipe" });
  expect(await build.exited).toBe(0);
  panelDir = join(tempDir("olv-e2e-panel-"), "panel");
  cpSync(join(R, "panel/dist"), panelDir, { recursive: true });
  mkdirSync(join(panelDir, "qa"));
  for (const f of [WAV_LIST, WAV_CANCEL]) cpSync(f, join(panelDir, "qa", f.split("/").pop()!));
}, 60_000);

describe("panel against fake GPT-Live", () => {
  let live: Live;
  let ext: Ext;
  let page: Page;

  beforeAll(async () => {
    const dir = tempDir("olv-e2e-a-");
    live = await startLive(dir);
    ext = await startExt(dir, { OLV_LIVE_URL: live.tapUrl, OLV_PANEL_DIR: panelDir });
    page = await openPanel(await launch({ fakeUi: true }), ext.ready.panelUrl);
  }, 30_000);
  afterAll(async () => {
    await ext?.quit();
  });

  test("(1) state badge shows 듣는 중 within 5 s", async () => {
    await waitPage(page, `${text("state")}.includes('듣는 중')`, 5000, "state 듣는 중");
  }, 10_000);

  test("(2) fake-mic speech becomes a user caption with 파일 and reaches the extension", async () => {
    const utt = ext.out.wait(recv("utterance", (m) => m.kind === "message" && String(m.text).includes("파일")), 15_000, "ext utterance");
    await waitPage(page, `${text("user-caption")}.includes('파일')`, 15_000, "user caption 파일");
    expect((await utt).msg.text).toContain("파일");
  }, 20_000);

  test("(3) agent.tool.start bash shows 에이전트 작업 중: bash", async () => {
    ext.emit({ type: "agent.tool.start", name: "bash" });
    await waitPage(page, `${text("agent-state")}.includes('에이전트 작업 중: bash')`, 5000, "agent badge bash");
  }, 10_000);

  test("(4)+(7) agent.end is spoken: assistant caption, > 24,000 samples played, screenshots", async () => {
    ext.emit({ type: "agent.tool.end", name: "bash", ok: true });
    ext.emit({ type: "agent.end", text: "파일은 세 개예요." });
    await waitPage(page, `[...document.querySelectorAll('[data-testid=assistant-caption] .utterance-text')].some((n) => n.textContent.trim().length > 0)`, 10_000, "assistant caption");
    const consumed = await waitPage<number>(page, `window.__olv.stats.consumed > 24000 && window.__olv.stats.consumed`, 10_000, "consumed > 24000");
    expect(consumed).toBeGreaterThan(24_000);
    mkdirSync(H, { recursive: true });
    for (const [w, h] of [[1280, 800], [360, 720]] as const) {
      await OW.repinViewport(page, { width: w, height: h });
      const path = join(H, `e2e-${w}.png`);
      await Bun.write(path, await page.screenshot());
      expect(statSync(path).size).toBeGreaterThan(20_000);
    }
    await OW.repinViewport(page, { width: 1280, height: 800 });
  }, 30_000);

  test("(5) mute click sends session.input_audio.mute within 2 s and shows 일시정지 · 무음", async () => {
    const muted = live.tap.wait((e) => e.dir === "in" && e.type === "session.input_audio.mute", 2000, "fake-live mute");
    await page.click("[data-testid=mute]");
    await muted;
    const badge = await waitPage<string>(page, `${text("state")}.includes('일시정지') && ${text("state")}.includes('무음') && ${text("state")}`, 2000, "muted badge");
    expect(badge).toContain("무음");
  }, 10_000);
});

test("(6) interruption: injected speech flushes playback within 200 ms and cancels delegation d2", async () => {
  const dir = tempDir("olv-e2e-b-");
  const live = await startLive(dir, { OLV_FAKE_OUTPUT_MS: "10000", OLV_FAKE_TRANSCRIPTS: JSON.stringify(["현재 폴더의 파일 목록을 보여줘", "그만"]) });
  const ext = await startExt(dir, { OLV_LIVE_URL: live.tapUrl, OLV_PANEL_DIR: panelDir });
  try {
    const first = ext.out.wait(recv("utterance", (m) => m.kind === "message"), 15_000, "first utterance");
    const page = await openPanel(await launch({ fakeUi: true }), ext.ready.panelUrl);
    await first;
    ext.emit({ type: "agent.tool.start", name: "bash" });
    ext.emit({ type: "agent.question", requestId: "q1", header: "확인", question: "어느 폴더를 볼까요?", options: [{ label: "현재 폴더" }, { label: "상위 폴더" }] });
    await waitPage(page, `window.__olv.stats.consumed > 2400`, 10_000, "consumed > 2400");
    const d2 = live.tap.wait((e) => e.dir === "out" && e.type === "session.delegation.created" && e.ev.delegation?.id === "d2", 10_000, "delegation d2");
    const cancel = ext.out.wait(recv("utterance", (m) => m.kind === "cancel"), 10_000, "ext cancel utterance");
    await page.evaluate(`window.__olv.qa.inject('/assets/qa/ko-cancel.wav')`);
    const flush = await waitPage<{ t: number; generation: number }>(page, `window.__olvRec.flush[0]`, 5000, "bridge flush envelope");
    const drained = await waitPage<{ t: number }>(page, `window.__olvRec.stats.find((s) => s.key === 'buffered' && s.v === 0 && s.t >= ${flush.t})`, 2000, "buffered 0 after flush");
    console.log(`e2e(6) flush gen=${flush.generation} buffered0_after_ms=${drained.t - flush.t}`);
    expect(drained.t - flush.t).toBeLessThanOrEqual(200);
    const [d2Ev, cancelEv] = await Promise.all([d2, cancel]);
    expect(cancelEv.t).toBeGreaterThanOrEqual(d2Ev.t);
    expect(cancelEv.msg.text).toContain("그만");
  } finally {
    await ext.quit();
  }
}, 60_000);

test("(8b) the real worklet drains after the tone and the idle guard closes while the fake keeps sending silence", async () => {
  const dir = tempDir("olv-e2e-c-");
  const live = await startLive(dir, { OLV_FAKE_OUTPUT_MS: "2000", OLV_FAKE_TRAILING_SILENCE_MS: "20000" });
  const ext = await startExt(dir, { OLV_LIVE_URL: live.tapUrl, OLV_PANEL_DIR: panelDir, OLV_IDLE_MS: "3000" });
  try {
    const first = ext.out.wait(recv("utterance", (m) => m.kind === "message"), 15_000, "first utterance");
    const page = await openPanel(await launch({ fakeUi: true }), ext.ready.panelUrl);
    await first;
    const from = live.tap.items.length;
    ext.emit({ type: "agent.end", text: "파일은 세 개예요." });
    await live.tap.wait((e) => e.dir === "out" && e.type === "session.output_audio.delta" && e.voiced === true, 10_000, "tone starts", from);
    const toneEnd = await live.tap.wait((e) => e.dir === "out" && e.type === "session.output_audio.delta" && e.voiced === false, 10_000, "tone ends", from);
    const drained = await waitPage<{ t: number }>(page, `window.__olvRec.stats.find((s) => s.key === 'buffered' && s.v === 0 && s.t >= ${toneEnd.t})`, 1500, "worklet drained within 1.5 s");
    console.log(`e2e(8b) buffered0_after_tone_ms=${drained.t - toneEnd.t}`);
    expect(drained.t - toneEnd.t).toBeLessThanOrEqual(1500);
    await waitPage(page, `${text("state")}.includes('일시정지')`, 6000, "idle-closed badge within 6 s");
    const silentAfterTone = live.tap.items.filter((e) => e.t >= toneEnd.t && e.type === "session.output_audio.delta" && e.voiced === false).length;
    expect(silentAfterTone).toBeGreaterThan(5);
    expect(live.tap.items.some((e) => e.dir === "in" && e.type === "session.close")).toBe(true);
  } finally {
    await ext.quit();
  }
}, 60_000);

test("(8) headless omo rpc: /voice -> setStatus, spoken WAV -> user message + assistant reply, /voice stop -> bridge gone, lock removed", async () => {
  const dir = tempDir("olv-e2e-d-");
  const dataDir = join(dir, "data");
  const live = await startLive(dir);
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  const token = "e2e".padEnd(64, "0");
  const omo = Bun.spawn([OMO, "--mode", "rpc", "--no-session", "--no-extensions", "-e", join(R, "extension/index.ts")], {
    cwd: dir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: `${join(process.env.HOME ?? "", ".bun/bin")}:${process.env.PATH ?? ""}`,
      OLV_LIVE_URL: live.tapUrl,
      OPENAI_API_KEY: "sk-test",
      OLV_QA: "1",
      OLV_OPEN_CMD: "true",
      OLV_DATA_DIR: dataDir,
      OLV_PORT: String(port),
      OLV_TEST_TOKEN: token,
      OLV_PANEL_DIR: panelDir,
    },
  });
  procs.push(omo);
  const frames = new Stream<Record<string, any>>();
  lines(omo.stdout, (l) => {
    try {
      frames.push(JSON.parse(l) as Record<string, any>);
    } catch {
      frames.push({ type: "_non_json", line: l });
    }
  });
  lines(omo.stderr, () => undefined);
  const send = (o: object) => {
    omo.stdin.write(`${JSON.stringify(o)}\n`);
    omo.stdin.flush();
  };
  const msgText = (m: any): string => (typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((c: any) => c?.text ?? "").join("") : "");
  try {
    const status = frames.wait((f) => f.type === "extension_ui_request" && f.method === "setStatus" && f.statusKey === "voice" && !!f.statusText, 60_000, "setStatus");
    const readyNotify = frames.wait((f) => f.type === "extension_ui_request" && f.method === "notify" && String(f.message).includes("음성 모드 켜짐"), 60_000, "ready notify");
    send({ id: "p1", type: "prompt", message: "/voice" });
    await status;
    await readyNotify;
    const lock = JSON.parse(readFileSync(join(dataDir, "active.json"), "utf8")) as { pid: number };
    expect(lock.pid).toBeGreaterThan(0);

    const userMsg = frames.wait((f) => f.type === "message_start" && f.message?.role === "user" && msgText(f.message).includes("파일"), 30_000, "user message with the phrase");
    const reply = frames.wait((f) => f.type === "message_end" && f.message?.role === "assistant" && msgText(f.message).trim().length > 0, 150_000, "assistant reply");
    const panel = Bun.spawn([BUN, FAKE_PANEL, "--url", `ws://127.0.0.1:${port}/ws?token=${token}`, "--token", token, "--wav", WAV_LIST, "--out", join(dir, "panel.json")], {
      env: { ...BASE_ENV },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    procs.push(panel);
    const userText = msgText((await userMsg).message);
    const replyText = msgText((await reply).message);
    console.log(`e2e(8) user=${JSON.stringify(userText.slice(0, 120))} assistant=${JSON.stringify(replyText.slice(0, 200))}`);
    expect(userText).toContain("파일");
    expect(replyText.trim().length).toBeGreaterThan(0);
    panel.kill("SIGTERM");
    await bounded(panel.exited, 5000, "fake-panel exit");

    const stopped = frames.wait((f) => f.type === "extension_ui_request" && f.method === "notify" && f.message === "음성 종료", 30_000, "stop notify");
    send({ id: "p2", type: "prompt", message: "/voice stop" });
    await stopped;
    let alive = true;
    try {
      process.kill(lock.pid, 0);
    } catch {
      alive = false;
    }
    console.log(`e2e(8) bridge_pid=${lock.pid} alive_after_stop=${alive} lock_exists=${existsSync(join(dataDir, "active.json"))}`);
    expect(alive).toBe(false);
    expect(existsSync(join(dataDir, "active.json"))).toBe(false);
  } finally {
    omo.kill("SIGTERM");
    await bounded(omo.exited, 10_000, "omo exit").catch(() => omo.kill("SIGKILL"));
  }
}, 240_000);

test("(9) without --use-fake-ui-for-media-stream the denied mic shows 마이크 권한 in [data-testid=error]", async () => {
  const dir = tempDir("olv-e2e-e-");
  const live = await startLive(dir);
  const ext = await startExt(dir, { OLV_LIVE_URL: live.tapUrl, OLV_PANEL_DIR: panelDir });
  try {
    const page = await openPanel(await launch({ fakeUi: false }), ext.ready.panelUrl, true);
    await waitPage(page, `${visible("error")} && ${text("error")}.includes('마이크 권한')`, 10_000, "mic permission error");
  } finally {
    await ext.quit();
  }
}, 30_000);

