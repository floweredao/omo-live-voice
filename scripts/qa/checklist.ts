// Real-surface checklist (plan todo 26). Costs real money against GPT-Live (~$0.05/min).
// Usage: OLV_LIVE_E2E=1 bun scripts/qa/checklist.ts [--items a,b,...] [--out results.json] [--log-dir dir]
//        bun scripts/qa/checklist.ts --fake-live [...]   (harness self-check against scripts/qa/fake-live-server.ts; no ledger lines)
// GROUP A (a b d e g l): fake-ext-host (spawns its own bridge) + fake-panel as the audio source, real GPT-Live.
// GROUP B (c f h i j k m): the INSTALLED extension inside headless `omo --mode rpc --no-session`; the extension spawns the bridge.
// Observation: a bridge-only preload (BUN_OPTIONS for A, an OLV_BUN wrapper for B) logs `OLV_TAP {json}` lines on the bridge's
// stderr for every Live message sent/received (audio appends and output audio omitted), every panel flush/PCM send, every voiced
// mic frame, and every bridge->extension line. It never logs the API key, the panel token or audio payloads.
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { questionToSpeech, INSTRUCTIONS_PREFIX } from "../../bridge/adapter.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const MAIN = process.env.OLV_MAIN_CHECKOUT ?? join(homedir(), "Documents/Projects/omo-live-voice");
const LEDGER = process.env.OLV_COST_LEDGER ?? `${MAIN}/.omo/handoff/cost-ledger.jsonl`;
const OMO = "/Applications/OmO.app/Contents/Resources/omo-runtime/darwin-arm64/omo";
const BUN = process.execPath;
const BUDGET_USD = 5.0;
const USD_PER_SEC = 0.05 / 60;
const ITEM_MS = 260_000;
const NODE = process.env.OLV_LEDGER_NODE ?? "n3-verify";

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const FAKE = args.includes("--fake-live");
if (!FAKE && process.env.OLV_LIVE_E2E !== "1") {
  console.error("refusing: set OLV_LIVE_E2E=1 (real GPT-Live) or pass --fake-live");
  process.exit(2);
}
const ITEMS = (opt("--items") ?? "a,b,d,e,g,l,c,f,h,i,j,k,m").split(",").map((s) => s.trim()).filter(Boolean);
const OUT = opt("--out");
const LOG_DIR = opt("--log-dir") ?? mkdtempSync(join(tmpdir(), "olv-checklist-logs-"));
mkdirSync(LOG_DIR, { recursive: true });

function ledgerTotal(): number {
  if (!existsSync(LEDGER)) return 0;
  let sum = 0;
  for (const line of readFileSync(LEDGER, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const usd = Number((JSON.parse(line) as { usd?: unknown }).usd);
      if (Number.isFinite(usd)) sum += usd;
    } catch {}
  }
  return sum;
}
const scrub = (s: string) => s.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***").replace(/token=[0-9a-f]{16,}/g, "token=***").replace(/"token":"[^"]+"/g, '"token":"***"');
export const norm = (s: string) => s.normalize("NFC").replace(/[\s\p{P}\p{S}]/gu, "");

/** Ordered-fragment check for (l)/(m): returns the first missing/out-of-order fragment, or null when all are in order. */
export function orderedMatch(text: string, head: string[], options: string[] = []): { missing: string | null; positions: number[] } {
  const t = norm(text);
  const positions: number[] = [];
  let cur = 0;
  for (const h of head) {
    const p = t.indexOf(norm(h), cur);
    if (p < 0) return { missing: h, positions };
    positions.push(p);
    cur = p + norm(h).length;
  }
  for (let k = 0; k < options.length; k++) {
    const marker = `${k + 1}번`;
    const label = norm(options[k]!);
    let found = -1;
    for (let p = t.indexOf(marker, cur); p >= 0; p = t.indexOf(marker, p + 1)) {
      const after = p + marker.length;
      const q = t.indexOf(label, after);
      if (q >= 0 && q - after <= 3) {
        found = q;
        break;
      }
    }
    if (found < 0) return { missing: `${marker} ${options[k]}`, positions };
    positions.push(found);
    cur = found + label.length;
  }
  return { missing: null, positions };
}

const TAP_JS = `
const T=()=>Date.now();
const W=(o)=>{try{process.stderr.write("OLV_TAP "+JSON.stringify({t:T(),...o})+"\\n")}catch{}};
const OWS=globalThis.WebSocket;
globalThis.WebSocket=class extends OWS{constructor(...a){super(...a);
 this.addEventListener("message",(m)=>{try{if(typeof m.data!=="string")return;const e=JSON.parse(m.data);const ty=String(e.type);
  if(ty==="session.output_audio.delta"||ty==="session.usage.updated")return;
  const o={k:"live_recv",type:ty};
  if(ty.endsWith("transcript.delta"))o.delta=e.delta;
  if(ty==="session.started")o.voice=e.session&&e.session.audio&&e.session.audio.output&&e.session.audio.output.voice;
  if(ty==="session.closed"){o.reason=e.reason;o.seconds=e.usage&&e.usage.seconds}
  if(ty==="session.delegation.created"){o.id=e.delegation&&e.delegation.id;o.offset_ms=e.offset_ms}
  if(ty==="error")o.code=e.error&&e.error.code;
  W(o)}catch{}});}
 send(d){try{if(typeof d==="string"){const e=JSON.parse(d);if(e.type!=="session.input_audio.append"){const o={k:"live_send",type:e.type};
  if(typeof e.content==="string")o.content=e.content;if(e.reason)o.reason=e.reason;if(e.event_id)o.event_id=e.event_id;
  if(e.type==="session.start")o.voice=e.session&&e.session.audio&&e.session.audio.output&&e.session.audio.output.voice;
  W(o)}}}catch{} return super.send(d)}};
const OSERVE=Bun.serve;
function patchWs(s){if(!s||s.__olvP)return;s.__olvP=1;const os=s.send.bind(s);
 s.send=(d,...r)=>{try{if(typeof d==="string"){if(d.indexOf('"type":"flush"')>=0)W({k:"flush_sent",interrupt_detected_at:s.__olvT0==null?null:s.__olvT0,flush_sent_at:T(),msg:JSON.parse(d)});
   else if(d.indexOf('"type":"cost"')>=0)W({k:"cost",msg:JSON.parse(d)});}
  else{W({k:"pcm_out",n:(d.byteLength||0)-8})}}catch{} return os(d,...r)}}
Bun.serve=(opts)=>{const w=opts&&opts.websocket;if(w){const om=w.message,oo=w.open;
 w.open=function(s,...r){patchWs(s);return oo?oo.call(this,s,...r):undefined};
 w.message=function(s,msg,...r){patchWs(s);let t0=null;try{if(typeof msg!=="string"){const b=msg instanceof ArrayBuffer?new Uint8Array(msg):msg;const n=(b.byteLength-8)>>1;
   if(n>0){const v=new DataView(b.buffer,b.byteOffset+8,n*2);let acc=0;for(let i=0;i<n;i++){const x=v.getInt16(i*2,true);acc+=x*x}const rms=Math.sqrt(acc/n);if(rms>=500){t0=T();W({k:"mic_voiced",rms:Math.round(rms)})}}}}catch{}
  s.__olvT0=t0;try{return om.call(this,s,msg,...r)}finally{s.__olvT0=null}}}
 return OSERVE.call(Bun,opts)};
const OW=process.stdout.write.bind(process.stdout);
process.stdout.write=(c,...r)=>{try{for(const l of String(c).split("\\n")){if(!l.trim())continue;const m=JSON.parse(l);
  W({k:"ext_out",msg:m.type==="ready"?{type:"ready",port:m.port}:m})}}catch{} return OW(c,...r)};
`;

type Tap = { t: number; k: string; [key: string]: any };
type Line = { t: number; src: string; line: string };
const stdinOf = (h: { proc: ReturnType<typeof Bun.spawn> }) => h.proc.stdin as import("bun").FileSink;
type ProcH = { name: string; proc: ReturnType<typeof Bun.spawn>; exited: boolean; code: number | null; stop?: () => Promise<void> };

class Ctx {
  readonly t0 = Date.now();
  readonly tmp = mkdtempSync(join(tmpdir(), "olv-chk-"));
  readonly log: string[] = [];
  readonly taps: Tap[] = [];
  readonly procs: ProcH[] = [];
  readonly numbers: Record<string, unknown> = {};
  readonly sessions: string[] = [];
  readonly ledger: { seconds: number; usd: number }[] = [];
  aborted = "";
  private waiters = new Set<() => void>();
  private ticker = setInterval(() => this.poke(), 100);
  constructor(readonly id: string) {
    writeFileSync(join(this.tmp, "tap.js"), TAP_JS);
  }
  get tapPath() {
    return join(this.tmp, "tap.js");
  }
  note(src: string, line: string) {
    this.log.push(`${String(Date.now() - this.t0).padStart(7)}ms ${src} ${scrub(line).slice(0, 1200)}`);
  }
  poke() {
    for (const w of [...this.waiters]) w();
  }
  until(cond: () => boolean, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (cond()) return resolve(true);
      const timer = setTimeout(() => done(false), ms);
      const w = () => {
        if (this.aborted) done(false);
        else if (cond()) done(true);
      };
      const done = (v: boolean) => {
        clearTimeout(timer);
        this.waiters.delete(w);
        resolve(v);
      };
      this.waiters.add(w);
    });
  }
  abort(why: string) {
    this.aborted ||= why;
    this.poke();
  }
  tapsOf(k: string, type?: string) {
    return this.taps.filter((x) => x.k === k && (type === undefined || x.type === type));
  }
  onStderr(src: string, l: string) {
    if (l.startsWith("OLV_TAP ")) {
      try {
        const tap = JSON.parse(l.slice(8)) as Tap;
        this.taps.push(tap);
        if (tap.k !== "pcm_out" && tap.k !== "mic_voiced") this.note(`${src}:tap`, l.slice(8));
      } catch {
        this.note(src, l);
      }
    } else this.note(src, l);
    this.poke();
  }
  spawn(name: string, cmd: string[], opts: { env?: Record<string, string | undefined>; cwd?: string; onOut?: (l: string) => void; onErr?: (l: string) => void }): ProcH {
    const proc = Bun.spawn(cmd, { cwd: opts.cwd ?? ROOT, env: (opts.env ?? process.env) as Record<string, string>, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const h: ProcH = { name, proc, exited: false, code: null };
    this.procs.push(h);
    void lines(proc.stdout as ReadableStream<Uint8Array>, (l) => {
      (opts.onOut ?? ((x) => this.note(name, x)))(l);
      this.poke();
    });
    void lines(proc.stderr as ReadableStream<Uint8Array>, (l) => (opts.onErr ?? ((x) => this.onStderr(name, x)))(l));
    void proc.exited.then((c) => {
      h.exited = true;
      h.code = c;
      this.note(name, `exited code=${c}`);
      this.poke();
    });
    return h;
  }
  async teardown() {
    for (const h of [...this.procs].reverse()) {
      if (h.exited) continue;
      try {
        if (h.stop) await h.stop();
      } catch (e) {
        this.note("teardown", `${h.name} stop failed ${(e as Error).message}`);
      }
      if (!h.exited) h.proc.kill("SIGTERM");
      if (!(await this.untilRaw(() => h.exited, 10_000))) {
        h.proc.kill("SIGKILL");
        await this.untilRaw(() => h.exited, 5_000);
      }
    }
    clearInterval(this.ticker);
  }
  untilRaw(cond: () => boolean, ms: number): Promise<boolean> {
    const saved = this.aborted;
    this.aborted = "";
    const p = this.until(cond, ms);
    this.aborted = saved;
    return p;
  }
  account() {
    const started = this.tapsOf("live_recv", "session.started");
    const closed = this.tapsOf("live_recv", "session.closed");
    for (let i = 0; i < started.length; i++) {
      const s = started[i]!;
      const next = started[i + 1]?.t ?? Infinity;
      const c = closed.find((x) => x.t >= s.t && x.t < next);
      const sec = typeof c?.seconds === "number" && c.seconds > 0 ? c.seconds : Math.ceil(((c?.t ?? Date.now()) - s.t) / 1000);
      const usd = Number((sec * USD_PER_SEC).toFixed(4));
      this.ledger.push({ seconds: sec, usd });
      if (!FAKE) appendFileSync(LEDGER, `${JSON.stringify({ ts: new Date().toISOString(), node: NODE, item: this.id, seconds: sec, usd })}\n`);
    }
  }
}

async function lines(stream: ReadableStream<Uint8Array>, onLine: (l: string) => void) {
  const dec = new TextDecoder();
  let buf = "";
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    }
  } catch {}
  if (buf) onLine(buf);
}

let fakeLive: { proc: ReturnType<typeof Bun.spawn>; url: string } | null = null;
async function liveEnv(): Promise<Record<string, string>> {
  if (!FAKE) return {};
  if (!fakeLive) {
    const proc = Bun.spawn([BUN, `${ROOT}scripts/qa/fake-live-server.ts`], { stdout: "pipe", stderr: "ignore", env: { ...process.env, OLV_FAKE_OUTPUT_MS: "20000" } });
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    const url = (JSON.parse(new TextDecoder().decode(value).split("\n")[0]!) as { url: string }).url;
    fakeLive = { proc, url };
  }
  return { OLV_LIVE_URL: fakeLive.url, OPENAI_API_KEY: "sk-fake-for-harness" };
}

type Ready = { type: "ready"; port: number; token: string; panelUrl: string };
type A = { h: ProcH; ready: Ready | null; recv: { t: number; msg: any }[]; emit: (m: object) => void };

async function startA(ctx: Ctx, env: Record<string, string> = {}): Promise<A> {
  const le = await liveEnv();
  const all = { OLV_QA: "1", BUN_OPTIONS: `--preload ${ctx.tapPath}`, OLV_DATA_DIR: join(ctx.tmp, "data"), OLV_PORT: "0", ...le, ...env };
  const a: A = { h: null as unknown as ProcH, ready: null, recv: [], emit: () => {} };
  const cmd = [BUN, `${ROOT}scripts/qa/fake-ext-host.ts`, "--cwd", ctx.tmp, ...Object.entries(all).flatMap(([k, v]) => ["--env", `${k}=${v}`])];
  const childEnv = { ...process.env };
  delete childEnv.OPENAI_API_KEY;
  a.h = ctx.spawn("ext", cmd, {
    env: childEnv,
    onOut: (l) => {
      if (l.startsWith("sent ") && l.includes('"type":"stop"')) ctx.note("ext", l);
      if (l.startsWith("{") && !a.ready) {
        try {
          a.ready = JSON.parse(l) as Ready;
          ctx.note("ext", `ready port=${a.ready.port}`);
        } catch {
          ctx.note("ext", l);
        }
      } else if (l.startsWith("recv ")) {
        try {
          a.recv.push({ t: Date.now(), msg: JSON.parse(l.slice(5)) });
        } catch {}
        ctx.note("ext", l);
      } else if (!l.startsWith("sent {\"type\":\"agent")) ctx.note("ext", l);
    },
  });
  a.emit = (m: object) => {
    stdinOf(a.h).write(`emit ${JSON.stringify(m)}\n`);
    stdinOf(a.h).flush();
    ctx.note("ext<-", JSON.stringify(m).slice(0, 300));
  };
  a.h.stop = async () => {
    stdinOf(a.h).write("quit\n");
    stdinOf(a.h).flush();
    await ctx.untilRaw(() => a.h.exited, 30_000);
  };
  if (!(await ctx.until(() => a.ready !== null || a.h.exited, 20_000)) || !a.ready) throw new Error("bridge ready not received in 20 s");
  return a;
}

type Panel = { h: ProcH; helloAt: number; envs: { t: number; e: any }[]; out: string; summary: () => any };
function startPanel(ctx: Ctx, port: number, token: string, extra: string[]): Panel {
  const out = join(ctx.tmp, `panel-${Date.now()}.json`);
  const p: Panel = { h: null as unknown as ProcH, helloAt: 0, envs: [], out, summary: () => (existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {}) };
  const url = `ws://127.0.0.1:${port}/ws?token=${token}`;
  p.h = ctx.spawn("panel", [BUN, `${ROOT}scripts/qa/fake-panel.ts`, "--url", url, "--token", token, "--out", out, ...extra], {
    onOut: (l) => {
      if (l.startsWith("envelope ")) {
        try {
          const e = JSON.parse(l.slice(9));
          p.envs.push({ t: Date.now(), e });
          if (e.type === "hello" && !p.helloAt) p.helloAt = Date.now();
          if (e.type !== "transcript" && e.type !== "cost") ctx.note("panel", l);
        } catch {
          ctx.note("panel", l);
        }
      } else ctx.note("panel", l);
    },
  });
  p.h.stop = async () => {
    p.h.proc.kill("SIGTERM");
    await ctx.untilRaw(() => p.h.exited, 5_000);
  };
  return p;
}

const liveStarted = (ctx: Ctx, n = 1) => ctx.until(() => ctx.tapsOf("live_recv", "session.started").length >= n, 20_000);
const outputTranscript = (ctx: Ctx, from = 0) =>
  ctx.tapsOf("live_recv", "session.output_transcript.delta").filter((x) => x.t >= from).map((x) => String(x.delta ?? "")).join("");
const sessionCloseSends = (ctx: Ctx) => ctx.tapsOf("live_send", "session.close");
const extStates = (ctx: Ctx) => ctx.tapsOf("ext_out").filter((x) => x.msg?.type === "state");

// (l) question fixture: 8 options of exactly 80 Korean characters each ("<two-word phrase> - <description>"),
// so questionToSpeech yields >= 2 chunks at the runtime cap (600 - prefix).
const LABELS_L = [
  "테스트 발전소 - 단위 테스트를 모두 실행하고 실패한 것만 골라서 다시 돌린 뒤 결과 보고서를 깔끔하게 정리해서 우리 팀 채널에 꼭 올려 둡니다",
  "빌드 철도 - 변경된 패키지만 차례대로 빌드하고 그 결과물은 한곳에 모아 두며 빌드에 걸린 시간도 함께 기록해서 지난번 결과와 늘 비교해 봅니다",
  "배포 연구소 - 스테이징 서버에 먼저 올려 보고 문제가 없으면 운영 서버로 보내며 배포 직후 한 시간 동안은 오류 지표를 계속 꼼꼼히 지켜봅니다",
  "문서 정원 - 바뀐 기능의 사용 설명서를 고치고 예제 코드도 새로 정리하며 오래된 화면 사진은 모두 최신 화면으로 하나씩 꼭 찍어서 바꿔 둡니다",
  "성능 실험실 - 느린 함수를 찾아서 시간을 재어 보고 가장 오래 걸리는 부분부터 고치며 개선 전과 후의 수치를 표로 잘 정리해서 꼭 남겨 둡니다",
  "보안 등대 - 의존성 취약점을 모두 검사하고 위험한 버전은 안전한 버전으로 바꾸며 비밀 값이 코드 안에 혹시 남아 있는지도 꼼꼼히 다 확인합니다",
  "캐시 창고 - 자주 쓰는 빌드 결과를 따로 저장해 두고 다음 빌드 때 그대로 다시 쓰며 오래된 캐시는 일주일마다 한 번씩 다 깨끗이 비워 둡니다",
  "릴리스 항구 - 버전 번호를 올리고 변경 기록을 꼼꼼히 적은 뒤 태그를 붙여 발표하며 사용자에게 보낼 안내 메일도 함께 써서 바로 보내 드립니다",
];
const QUESTION_L = { type: "agent.question", requestId: "chk-l", header: "빌드 방식", question: "어떤 순서로 진행할까요?", options: LABELS_L.map((label) => ({ label })) };

type Result = { ok: boolean; detail: string };
const items: Record<string, { group: "A" | "B"; title: string; run: (ctx: Ctx) => Promise<Result> }> = {};

items.a = {
  group: "A",
  title: "mute: --mute-at 1000 -> session.input_audio.muted",
  run: async (ctx) => {
    const a = await startA(ctx);
    const muteAt = opt("--mute-at") ?? "1000";
    ctx.numbers.muteAtMs = Number(muteAt);
    const p = startPanel(ctx, a.ready!.port, a.ready!.token, ["--mute-at", muteAt, "--tail-ms", String(Number(muteAt) + 5000), "--linger-ms", "1000"]);
    await ctx.until(() => ctx.tapsOf("live_recv", "session.input_audio.muted").length > 0 || p.h.exited, 15_000);
    // count duplicates until the panel finishes (mute-at + tail + linger)
    await ctx.until(() => p.h.exited, 20_000);
    const muteSends = ctx.tapsOf("live_send", "session.input_audio.mute");
    const sent = muteSends[0];
    const acked = ctx.tapsOf("live_recv", "session.input_audio.muted")[0];
    const started = ctx.tapsOf("live_recv", "session.started")[0];
    ctx.numbers.panelHelloToMuteSentMs = sent && p.helloAt ? sent.t - p.helloAt : null;
    ctx.numbers.sessionStartedAfterHelloMs = started && p.helloAt ? started.t - p.helloAt : null;
    ctx.numbers.muteAckMs = sent && acked ? acked.t - sent.t : null;
    const muteFailed = ctx.log.some((l) => l.includes("mute_failed"));
    const mutedStateAt = extStates(ctx).find((x) => x.msg.muted === true)?.t;
    const mutedState = mutedStateAt !== undefined;
    // precondition: the bridge applied the local mute BEFORE session.started (the pre-ready path under test)
    const preReady = mutedStateAt !== undefined && !!started && mutedStateAt < started.t;
    ctx.numbers.muteSendCount = muteSends.length;
    ctx.numbers.localMuteToSessionStartedMs = mutedStateAt !== undefined && started ? started.t - mutedStateAt : null;
    ctx.numbers.sessionStartedToMuteSentMs = sent && started ? sent.t - started.t : null;
    const ok = !!acked && muteSends.length === 1 && !!started && sent!.t >= started.t && preReady && !muteFailed;
    return { ok, detail: `mute sends=${muteSends.length} muted ack=${!!acked} preReady=${preReady} mute_failed_logged=${muteFailed} state.muted=${mutedState}` };
  },
};

items.b = {
  group: "A",
  title: "barge-in: inject ko-greeting.wav during output -> flush within 300 ms of the detector",
  run: async (ctx) => {
    const a = await startA(ctx);
    const injectAt = 9000;
    const p = startPanel(ctx, a.ready!.port, a.ready!.token, ["--inject-at", String(injectAt), `${ROOT}fixtures/ko-greeting.wav`, "--tail-ms", "16000", "--linger-ms", "500"]);
    if (!(await liveStarted(ctx))) throw new Error("no session.started");
    a.emit(QUESTION_L);
    const got = await ctx.until(() => ctx.tapsOf("flush_sent").some((f) => f.msg?.reason === "barge-in"), 25_000);
    const f = ctx.tapsOf("flush_sent").find((x) => x.msg?.reason === "barge-in");
    const speakingBefore = f ? extStates(ctx).filter((x) => x.t <= f.t && x.msg.output !== "interrupted").at(-1)?.msg.output : null;
    const injectT = p.helloAt + injectAt;
    ctx.numbers.detectorToFlushMs = f && f.interrupt_detected_at ? f.flush_sent_at - f.interrupt_detected_at : null;
    ctx.numbers.injectOnsetToFlushMs = f ? f.flush_sent_at - injectT : null;
    ctx.numbers.firstVoicedMicAfterInjectMs = (ctx.tapsOf("mic_voiced").find((x) => x.t >= injectT - 200)?.t ?? NaN) - injectT;
    ctx.numbers.outputStateBeforeFlush = speakingBefore;
    const ok = got && !!f && typeof f.interrupt_detected_at === "number" && f.flush_sent_at - f.interrupt_detected_at <= 300 && speakingBefore === "speaking";
    return { ok, detail: f ? `flush gen=${f.msg.generation} reason=barge-in interrupt_detected_at=${f.interrupt_detected_at} flush_sent_at=${f.flush_sent_at}` : "no barge-in flush" };
  },
};

items.d = {
  group: "A",
  title: "idle: OLV_IDLE_MS=15000 + agent.idle true -> close at 15 s +- 1 s, panel reason=idle; negative control agent.idle false -> no close",
  run: async (ctx) => {
    const a = await startA(ctx, { OLV_IDLE_MS: "15000" });
    const p = startPanel(ctx, a.ready!.port, a.ready!.token, ["--tail-ms", "40000", "--linger-ms", "500"]);
    if (!(await liveStarted(ctx))) throw new Error("no session.started");
    a.emit({ type: "agent.idle", idle: true });
    const st = ctx.tapsOf("live_recv", "session.started")[0]!;
    await ctx.until(() => sessionCloseSends(ctx).length > 0, 25_000);
    const close = sessionCloseSends(ctx)[0];
    await ctx.until(() => p.envs.some((x) => x.e.type === "state" && x.e.reason === "idle"), 5_000);
    const panelIdle = p.envs.find((x) => x.e.type === "state" && x.e.reason === "idle");
    ctx.numbers.closeAfterStartedMs = close ? close.t - st.t : null;
    ctx.numbers.panelIdleStateAfterStartedMs = panelIdle ? panelIdle.t - st.t : null;
    const posOk = !!close && Math.abs(close.t - st.t - 15_000) <= 1_000 && !!panelIdle;
    // negative control: fresh bridge, agent reported busy -> no close at 15 s
    await a.h.stop!();
    await p.h.stop!();
    const tapsBefore = ctx.taps.length;
    const a2 = await startA(ctx, { OLV_IDLE_MS: "15000" });
    // panel must outlive the 18 s busy window + the 15 s post-idle deadline, else it disconnects first
    startPanel(ctx, a2.ready!.port, a2.ready!.token, ["--tail-ms", "50000", "--linger-ms", "500"]);
    if (!(await ctx.until(() => ctx.taps.slice(tapsBefore).some((x) => x.k === "live_recv" && x.type === "session.started"), 20_000))) throw new Error("negative control: no session.started");
    const st2 = ctx.taps.slice(tapsBefore).find((x) => x.k === "live_recv" && x.type === "session.started")!;
    a2.emit({ type: "agent.idle", idle: false });
    await ctx.until(() => Date.now() - st2.t >= 18_000 || ctx.taps.slice(tapsBefore).some((x) => x.k === "live_send" && x.type === "session.close"), 25_000);
    const close2 = ctx.taps.slice(tapsBefore).find((x) => x.k === "live_send" && x.type === "session.close");
    ctx.numbers.negativeControlCloseAfterStartedMs = close2 ? close2.t - st2.t : "none within 18 s";
    const negOk = !close2;
    // release: agent.idle true -> close one idle interval later
    let releaseOk = false;
    if (negOk) {
      const idleAt = Date.now();
      a2.emit({ type: "agent.idle", idle: true });
      await ctx.until(() => ctx.taps.slice(tapsBefore).some((x) => x.k === "live_send" && x.type === "session.close"), 25_000);
      const close3 = ctx.taps.slice(tapsBefore).find((x) => x.k === "live_send" && x.type === "session.close");
      await ctx.until(() => extStates(ctx).some((x) => x.t >= idleAt && x.msg.connection === "closed"), 5_000);
      const closedReason = extStates(ctx).find((x) => x.t >= idleAt && x.msg.connection === "closed")?.msg.reason ?? null;
      ctx.numbers.idleTrueToCloseMs = close3 ? close3.t - idleAt : null;
      ctx.numbers.releaseCloseReason = closedReason;
      releaseOk = !!close3 && Math.abs(close3.t - idleAt - 15_000) <= 1_500 && closedReason === "idle";
    }
    return { ok: posOk && negOk && releaseOk, detail: `positive close=${ctx.numbers.closeAfterStartedMs}ms panel reason=idle=${!!panelIdle}; negative control close=${ctx.numbers.negativeControlCloseAfterStartedMs}; after agent.idle true close=${ctx.numbers.idleTrueToCloseMs ?? "n/a"}ms reason=${ctx.numbers.releaseCloseReason ?? "n/a"}` };
  },
};

items.e = {
  group: "A",
  title: "cap+warning: OLV_CAP_MS=40000 OLV_WARN_MS=20000 -> warning commentary at 20 s, close reason=cap at 40 s",
  run: async (ctx) => {
    const a = await startA(ctx, { OLV_CAP_MS: "40000", OLV_WARN_MS: "20000" });
    const p = startPanel(ctx, a.ready!.port, a.ready!.token, ["--tail-ms", "50000", "--linger-ms", "500"]);
    if (!(await liveStarted(ctx))) throw new Error("no session.started");
    a.emit({ type: "agent.idle", idle: true });
    const st = ctx.tapsOf("live_recv", "session.started")[0]!;
    await ctx.until(() => sessionCloseSends(ctx).length > 0, 50_000);
    const closedState = () => p.envs.find((x) => x.t >= st.t && x.e.type === "state" && x.e.connection === "closed" && x.e.reason);
    await ctx.until(() => !!closedState(), 5_000);
    const warn = ctx.tapsOf("live_send", "session.commentary.append")[0];
    const close = sessionCloseSends(ctx)[0];
    const panelClosed = closedState();
    ctx.numbers.warnAfterStartedMs = warn ? warn.t - st.t : null;
    ctx.numbers.warnContent = warn?.content ?? null;
    ctx.numbers.closeAfterStartedMs = close ? close.t - st.t : null;
    ctx.numbers.panelCloseReason = panelClosed?.e.reason ?? null;
    const ok = !!warn && Math.abs(warn.t - st.t - 20_000) <= 1_000 && !!close && Math.abs(close.t - st.t - 40_000) <= 1_000 && panelClosed?.e.reason === "cap";
    return { ok, detail: `warning at ${ctx.numbers.warnAfterStartedMs}ms, close at ${ctx.numbers.closeAfterStartedMs}ms, panel reason=${ctx.numbers.panelCloseReason}` };
  },
};

items.g = {
  group: "A",
  title: "ps -E -p <bridge pid> shows no OPENAI_API_KEY (real Keychain path)",
  run: async (ctx) => {
    if (FAKE) return { ok: true, detail: "skipped in --fake-live (needs the Keychain path)" };
    if (process.env.OPENAI_API_KEY) throw new Error("harness env has OPENAI_API_KEY; refusing");
    const a = await startA(ctx);
    const pid = Number((await Bun.$`pgrep -P ${a.h.proc.pid}`.nothrow().text()).trim().split("\n")[0]);
    const envCount = Number((await Bun.$`ps -E -p ${pid} -o command= | grep -c OPENAI_API_KEY`.nothrow().text()).trim());
    const controlCount = Number((await Bun.$`ps -E -p ${pid} -o command= | grep -c OLV_DATA_DIR`.nothrow().text()).trim());
    const envSource = ctx.log.some((l) => l.includes("key_source=env"));
    ctx.numbers.bridgePid = pid;
    ctx.numbers.psE_OPENAI_API_KEY_count = envCount;
    ctx.numbers.psE_OLV_DATA_DIR_control_count = controlCount;
    return { ok: pid > 0 && envCount === 0 && controlCount === 1 && !envSource, detail: `bridge pid=${pid} OPENAI_API_KEY count=${envCount} (control OLV_DATA_DIR count=${controlCount}) key_source=env logged=${envSource}` };
  },
};

items.l = {
  group: "A",
  title: "IS-6 spoken multi-chunk question (synthetic agent.question, 8 options)",
  run: async (ctx) => {
    for (const label of LABELS_L) if ([...label].length !== 80) throw new Error(`fixture label is not 80 chars: ${label}`);
    const chunks350 = questionToSpeech({ header: QUESTION_L.header, question: QUESTION_L.question, options: QUESTION_L.options }, 350);
    const chunks600 = questionToSpeech({ header: QUESTION_L.header, question: QUESTION_L.question, options: QUESTION_L.options }, 600 - [...INSTRUCTIONS_PREFIX].length);
    ctx.numbers.chunksAtCap350 = chunks350.length;
    ctx.numbers.chunksAtRuntimeCap = chunks600.length;
    const a = await startA(ctx);
    const p = startPanel(ctx, a.ready!.port, a.ready!.token, ["--tail-ms", "220000", "--linger-ms", "500"]);
    if (!(await liveStarted(ctx))) throw new Error("no session.started");
    a.emit({ type: "agent.idle", idle: true });
    const t0 = Date.now();
    a.emit(QUESTION_L);
    const head = [QUESTION_L.header, QUESTION_L.question];
    const done = () => orderedMatch(outputTranscript(ctx, t0), head, LABELS_L).missing === null;
    // fail fast: every chunk appended and no output transcript for 20 s means speech has finished (or stalled)
    const settled = () => {
      const appended = new Set(ctx.tapsOf("live_send", "session.instructions.append").filter((x) => x.t >= t0).map((x) => String(x.content ?? ""))).size;
      const last = ctx.tapsOf("live_recv", "session.output_transcript.delta").filter((x) => x.t >= t0).at(-1)?.t ?? t0;
      return appended >= chunks600.length && Date.now() - last > 20_000;
    };
    await ctx.until(() => done() || settled(), 180_000);
    const rawSends = ctx.tapsOf("live_send", "session.instructions.append").filter((x) => x.t >= t0);
    // a start-retry re-sends the same chunk content with a new event id: collapse it into its chunk
    const sends = rawSends.filter((s, i) => i === 0 || String(s.content ?? "") !== String(rawSends[i - 1]!.content ?? ""));
    ctx.numbers.startRetries = rawSends.length - sends.length;
    ctx.numbers.retryLog = ctx.log.filter((l) => l.includes("question_chunk_retry"));
    ctx.numbers.sendContentsMatchChunks = sends.length === chunks600.length && sends.every((s, i) => String(s.content ?? "").endsWith(chunks600[i]!));
    const lastSend = sends.at(-1);
    if (lastSend) await ctx.until(() => extStates(ctx).some((x) => x.t > lastSend.t && x.msg.output !== "speaking" && extStates(ctx).some((y) => y.t > lastSend.t && y.t < x.t && y.msg.output === "speaking")), 30_000);
    const text = outputTranscript(ctx, t0);
    const match = orderedMatch(text, head, LABELS_L);
    const states = extStates(ctx);
    void states;
    const outDeltas = ctx.tapsOf("live_recv", "session.output_transcript.delta");
    const windows = sends.map((s, i) => {
      const end = sends[i + 1]?.t ?? Date.now();
      const pcm = ctx.tapsOf("pcm_out").filter((x) => x.t >= s.t && x.t < end).reduce((n, x) => n + Number(x.n), 0);
      // the previous chunk had finished speaking: its last transcript delta came >= 600 ms (OUTPUT_END_MS) before this append
      const prevEnd = i === 0 ? null : outDeltas.filter((x) => x.t > sends[i - 1]!.t && x.t < s.t).at(-1)?.t ?? null;
      return { chunk: i + 1, sentAtMs: s.t - t0, chars: [...String(s.content ?? "")].length, afterPrevOutputEnd: i === 0 ? true : prevEnd !== null && s.t - prevEnd >= 600, prevOutputEndToSendMs: prevEnd === null ? null : s.t - prevEnd, pcmBytesToPanel: pcm };
    });
    ctx.numbers.chunkWindows = windows;
    ctx.numbers.panelTotalPcmBytes = null;
    await p.h.stop!();
    ctx.numbers.panelTotalPcmBytes = p.summary().receivedPcmBytes ?? null;
    ctx.numbers.transcript = text;
    ctx.numbers.missingFragment = match.missing;
    const timedOut = ctx.log.some((l) => l.includes("question_chunk_timeout"));
    ctx.numbers.questionChunkTimeout = timedOut;
    const ok = chunks600.length >= 2 && sends.length === chunks600.length && ctx.numbers.sendContentsMatchChunks === true && !timedOut && windows.every((w) => w.afterPrevOutputEnd && w.pcmBytesToPanel > 48_000) && match.missing === null && Number(ctx.numbers.panelTotalPcmBytes) >= windows.reduce((n, w) => n + w.pcmBytesToPanel, 0) * 0.95;
    return { ok, detail: `chunks sent=${sends.length} (cap350=${chunks350.length}, runtime=${chunks600.length}); missing=${match.missing ?? "none"}; windows=${JSON.stringify(windows)}` };
  },
};

type B = { h: ProcH; frames: { t: number; f: any }[]; send: (o: object) => void; data: string; capture: string; extLog: () => string; seq: number };
let rpcSeq = 0;
async function startB(ctx: Ctx, name: string, env: Record<string, string> = {}, data = join(ctx.tmp, "data")): Promise<B> {
  const le = await liveEnv();
  const wrapper = join(ctx.tmp, "bun-tap.sh");
  if (!existsSync(wrapper)) {
    writeFileSync(wrapper, `#!/bin/sh\nexec "${BUN}" --preload "${ctx.tapPath}" "$@"\n`);
    chmodSync(wrapper, 0o755);
    const opener = join(ctx.tmp, "open.sh");
    writeFileSync(opener, `#!/bin/sh\nprintf '%s\\n' "$1" >> "$OLV_URL_CAPTURE"\n`);
    chmodSync(opener, 0o755);
  }
  const capture = join(ctx.tmp, `urls-${name}.txt`);
  const work = join(ctx.tmp, `work-${name}`);
  mkdirSync(work, { recursive: true });
  const childEnv: Record<string, string | undefined> = { ...process.env, OLV_QA: "1", OLV_BUN: wrapper, OLV_OPEN_CMD: join(ctx.tmp, "open.sh"), OLV_URL_CAPTURE: capture, OLV_DATA_DIR: data, OLV_PORT: "0", ...le, ...env };
  delete childEnv.SENPI_RPC_CLIENT_CAPABILITIES;
  delete childEnv.OMO_RPC_CLIENT_CAPABILITIES;
  if (!FAKE) delete childEnv.OPENAI_API_KEY;
  const b: B = { h: null as unknown as ProcH, frames: [], send: () => {}, data, capture, seq: 0, extLog: () => "" };
  b.h = ctx.spawn(`omo-${name}`, [OMO, "--mode", "rpc", "--no-session"], {
    cwd: work,
    env: childEnv,
    onOut: (l) => {
      try {
        const f = JSON.parse(l);
        b.frames.push({ t: Date.now(), f });
        const ty = f.type;
        if (ty === "message_update" || ty === "session_status") return;
        ctx.note(`rpc-${name}`, JSON.stringify(f).slice(0, 400));
      } catch {
        ctx.note(`rpc-${name}`, l);
      }
    },
  });
  b.send = (o) => {
    stdinOf(b.h).write(`${JSON.stringify(o)}\n`);
    stdinOf(b.h).flush();
    ctx.note(`rpc-${name}<-`, JSON.stringify(o).slice(0, 300));
  };
  b.extLog = () => {
    const dir = join(data, "logs");
    return existsSync(dir) ? readdirSync(dir).sort().map((f) => readFileSync(join(dir, f), "utf8")).join("") : "";
  };
  b.h.stop = async () => {
    if (b.h.exited) return;
    if (/spawn pid=/.test(b.extLog()) && !/child_exit/.test(b.extLog().split("spawn pid=").at(-1) ?? "")) {
      await prompt(ctx, b, "/voice stop", 15_000).catch(() => undefined);
      await ctx.untilRaw(() => /child_exit/.test(b.extLog().split("spawn pid=").at(-1) ?? ""), 10_000);
    }
    b.h.proc.kill("SIGTERM");
    await ctx.untilRaw(() => b.h.exited, 10_000);
  };
  return b;
}
async function prompt(ctx: Ctx, b: B, message: string, ms = 60_000): Promise<any> {
  const id = `chk-${++rpcSeq}`;
  const at = b.frames.length;
  b.send({ id, type: "prompt", message });
  const ok = await ctx.until(() => b.frames.slice(at).some((x) => x.f.type === "response" && x.f.id === id), ms);
  if (!ok) throw new Error(`no response to prompt ${message.slice(0, 30)}`);
  return b.frames.slice(at).find((x) => x.f.type === "response" && x.f.id === id)!.f;
}
function panelFromCapture(b: B, n = 1): { port: number; token: string } | null {
  if (!existsSync(b.capture)) return null;
  const urls = readFileSync(b.capture, "utf8").split("\n").filter(Boolean);
  const u = urls[n - 1];
  if (!u) return null;
  const url = new URL(u);
  return { port: Number(url.port), token: url.searchParams.get("token") ?? "" };
}
async function voiceOn(ctx: Ctx, b: B): Promise<{ port: number; token: string }> {
  const r = await prompt(ctx, b, "/voice");
  if (r.success === false) throw new Error(`/voice failed: ${JSON.stringify(r).slice(0, 200)}`);
  if (!(await ctx.until(() => panelFromCapture(b) !== null, 20_000))) throw new Error("panel URL not captured from OLV_OPEN_CMD");
  return panelFromCapture(b)!;
}
const extTs = (b: B, re: RegExp): number[] => [...b.extLog().matchAll(re)].map((m) => Number(m[1]));
const bridgeCount = async () => Number((await Bun.$`pgrep -f bridge/main.ts | wc -l`.nothrow().text()).trim());
const userMessageFrame = (b: B, needle: string, after = 0) =>
  b.frames.find((x) => x.t >= after && x.f.type === "message_start" && x.f.message?.role === "user" && JSON.stringify(x.f.message.content ?? "").includes(needle));
const COUNT_PROMPT = "1부터 300까지 한 줄에 하나씩 느리게 세어 줘.";

items.c = {
  group: "B",
  title: "cancel while the real agent is busy (ko-cancel.wav)",
  run: async (ctx) => {
    const b = await startB(ctx, "c");
    const panel = await voiceOn(ctx, b);
    const at = b.frames.length;
    b.send({ id: `chk-${++rpcSeq}`, type: "prompt", message: COUNT_PROMPT });
    if (!(await ctx.until(() => b.frames.slice(at).some((x) => x.f.type === "agent_start"), 60_000))) throw new Error("no agent_start");
    // optional stronger variant: inject only once the agent is visibly streaming its count
    const streaming = () => b.frames.slice(at).some((x) => x.f.type === "message_update" && x.f.assistantMessageEvent?.type === "text_delta");
    if (process.env.OLV_CHK_C_AFTER_TEXT === "1" && !(await ctx.until(streaming, 60_000))) throw new Error("agent never streamed text");
    ctx.numbers.injectAfterTextStarted = streaming();
    const pc = startPanel(ctx, panel.port, panel.token, ["--inject-at", "3000", `${ROOT}fixtures/ko-cancel.wav`, "--tail-ms", "15000", "--linger-ms", "500"]);
    const cancelUtt = () => ctx.tapsOf("ext_out").find((x) => x.msg?.type === "utterance" && x.msg.kind === "cancel");
    await ctx.until(() => !!cancelUtt(), 40_000);
    const u = cancelUtt();
    // the bridge emits the utterance before the extension logs it: wait for the extension's receipt line
    const abortRe = u ? new RegExp(`utterance_received ${u.msg.id} (\\d+)`, "g") : null;
    if (abortRe) await ctx.until(() => extTs(b, abortRe).length > 0, 5_000);
    const abortTs = abortRe ? extTs(b, abortRe)[0] : undefined;
    await ctx.until(() => !!abortTs && b.frames.some((x) => x.t >= abortTs && x.f.type === "agent_end"), 15_000);
    const end = abortTs ? b.frames.find((x) => x.t >= abortTs && x.f.type === "agent_end") : undefined;
    const text = b.frames.slice(at).filter((x) => x.f.type === "message_update" && x.f.assistantMessageEvent?.type === "text_delta").map((x) => x.f.assistantMessageEvent.delta).join("");
    // count duplicate cancels until the panel (inject + 15 s tail) has finished
    await ctx.until(() => pc.h.exited, 30_000);
    const cancelCount = ctx.tapsOf("ext_out").filter((x) => x.msg?.type === "utterance" && x.msg.kind === "cancel").length;
    ctx.numbers.cancelUtterance = u?.msg ?? null;
    ctx.numbers.cancelUtteranceCount = cancelCount;
    ctx.numbers.agentEndStopReason =
      ((end?.f.messages ?? []) as any[]).filter((m) => m.role === "assistant").at(-1)?.stopReason ??
      b.frames.filter((x) => abortTs !== undefined && x.t >= abortTs && x.f.type === "message_end" && x.f.message?.role === "assistant").at(-1)?.f.message.stopReason ??
      null;
    ctx.numbers.abortToAgentEndMs = end && abortTs ? end.t - abortTs : null;
    ctx.numbers.assistantTextTail = text.slice(-120);
    const ok = !!u && cancelCount === 1 && !!abortTs && !!end && end.t - abortTs <= 5_000 && ctx.numbers.agentEndStopReason === "aborted" && !/(^|\D)300(\D|$)/.test(text);
    return { ok, detail: `utterance kind=cancel text=${JSON.stringify(u?.msg.text ?? null)} count=${cancelCount}; abort(utterance_received)->agent_end=${ctx.numbers.abortToAgentEndMs}ms stopReason=${ctx.numbers.agentEndStopReason}; text contains 300=${/(^|\D)300(\D|$)/.test(text)}` };
  },
};

items.f = {
  group: "B",
  title: "second /voice in another session is refused",
  run: async (ctx) => {
    const shared = join(ctx.tmp, "data");
    const b1 = await startB(ctx, "f1", {}, shared);
    const b2 = await startB(ctx, "f2", {}, shared);
    await voiceOn(ctx, b1);
    await ctx.until(() => /ready port=/.test(b1.extLog()), 15_000);
    const at = b2.frames.length;
    await prompt(ctx, b2, "/voice");
    await ctx.until(() => b2.frames.slice(at).some((x) => x.f.method === "notify" && String(x.f.message).includes("이미 다른 세션")), 15_000);
    const refusal = b2.frames.slice(at).find((x) => x.f.method === "notify" && String(x.f.message).includes("이미 다른 세션"));
    ctx.numbers.bridgesWhileBothOn = await bridgeCount();
    const at1 = b1.frames.length;
    await prompt(ctx, b1, "/voice stop");
    await ctx.until(() => b1.frames.slice(at1).some((x) => x.f.method === "notify" && x.f.message === "음성 종료"), 15_000);
    const stopped = b1.frames.slice(at1).some((x) => x.f.method === "notify" && x.f.message === "음성 종료");
    await ctx.until(() => /child_exit/.test(b1.extLog()), 10_000);
    ctx.numbers.bridgesAfterStop = await bridgeCount();
    ctx.numbers.refusal = refusal?.f.message ?? null;
    return { ok: !!refusal && stopped && ctx.numbers.bridgesWhileBothOn === 1 && ctx.numbers.bridgesAfterStop === 0, detail: `second notify=${JSON.stringify(refusal?.f.message ?? null)}; bridges while both on=${ctx.numbers.bridgesWhileBothOn}; first /voice stop -> 음성 종료=${stopped}, bridges after=${ctx.numbers.bridgesAfterStop}` };
  },
};

items.h = {
  group: "B",
  title: "SIGKILL the omo RPC process while voice is open -> bridge exits within 3 s with session.close sent",
  run: async (ctx) => {
    const b = await startB(ctx, "h");
    const panel = await voiceOn(ctx, b);
    startPanel(ctx, panel.port, panel.token, ["--tail-ms", "30000", "--linger-ms", "500"]);
    if (!(await liveStarted(ctx))) throw new Error("no session.started");
    const pid = Number(/spawn pid=(\d+)/.exec(b.extLog())?.[1]);
    const killAt = Date.now();
    b.h.proc.kill("SIGKILL");
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await ctx.until(() => !alive(), 10_000);
    const exitMs = Date.now() - killAt;
    const close = sessionCloseSends(ctx).find((x) => x.t >= killAt);
    await ctx.until(() => ctx.tapsOf("live_recv", "session.closed").length > 0, 2_000);
    ctx.numbers.bridgePid = pid;
    ctx.numbers.killToBridgeExitMs = exitMs;
    ctx.numbers.killToSessionCloseSentMs = close ? close.t - killAt : null;
    ctx.numbers.lockLeft = existsSync(join(b.data, "active.json"));
    return { ok: pid > 0 && !alive() && exitMs <= 3_000 && !!close, detail: `bridge pid=${pid} exit after ${exitMs}ms; session.close sent after ${ctx.numbers.killToSessionCloseSentMs}ms; stale lock left=${ctx.numbers.lockLeft}` };
  },
};

items.i = {
  group: "B",
  title: "IS-2 idle latency: delegation.created -> input_admitted idle <= 2000 ms",
  run: async (ctx) => {
    const b = await startB(ctx, "i");
    const panel = await voiceOn(ctx, b);
    startPanel(ctx, panel.port, panel.token, ["--inject-at", "3000", `${ROOT}fixtures/ko-list-files.wav`, "--tail-ms", "6000", "--linger-ms", "60000"]);
    await ctx.until(() => /input_admitted \S+ \d+ \S+/.test(b.extLog()), 45_000);
    const del = ctx.tapsOf("live_recv", "session.delegation.created")[0];
    const adm = /input_admitted (\S+) (\d+) (\S+)/.exec(b.extLog());
    const admT = adm ? Number(adm[2]) : NaN;
    const utt = ctx.tapsOf("ext_out").find((x) => x.msg?.type === "utterance" && x.msg.kind === "message");
    await ctx.until(() => !!userMessageFrame(b, "파일", del?.t ?? 0), 10_000);
    const vis = userMessageFrame(b, "파일", del?.t ?? 0);
    ctx.numbers.utterance = utt?.msg.text ?? null;
    ctx.numbers.delegationToInputAdmittedMs = del && adm ? admT - del.t : null;
    ctx.numbers.delegationToUserMessageVisibleMs = del && vis ? vis.t - del.t : null;
    ctx.numbers.admittedAs = adm?.[3] ?? null;
    await ctx.until(() => b.frames.some((x) => x.t > admT && x.f.type === "agent_end"), 90_000);
    const ok = !!del && !!adm && adm[3] === "idle" && admT - del.t <= 2_000 && !!vis;
    return { ok, detail: `utterance=${JSON.stringify(ctx.numbers.utterance)}; delegation.created->input_admitted(${adm?.[3]})=${ctx.numbers.delegationToInputAdmittedMs}ms; ->user message_start=${ctx.numbers.delegationToUserMessageVisibleMs}ms` };
  },
};

items.j = {
  group: "B",
  title: "IS-2 busy latency: delegation.created -> input_admitted steer <= 2000 ms (visible time recorded)",
  run: async (ctx) => {
    const b = await startB(ctx, "j");
    const panel = await voiceOn(ctx, b);
    const at = b.frames.length;
    b.send({ id: `chk-${++rpcSeq}`, type: "prompt", message: COUNT_PROMPT });
    if (!(await ctx.until(() => b.frames.slice(at).some((x) => x.f.type === "agent_start"), 60_000))) throw new Error("no agent_start");
    startPanel(ctx, panel.port, panel.token, ["--inject-at", "3000", `${ROOT}fixtures/ko-list-files.wav`, "--tail-ms", "6000", "--linger-ms", "60000"]);
    await ctx.until(() => /input_admitted \S+ \d+ \S+/.test(b.extLog()) || ctx.log.some((l) => l.includes("utterance_dropped_busy")), 45_000);
    const del = ctx.tapsOf("live_recv", "session.delegation.created")[0];
    const adm = /input_admitted (\S+) (\d+) (\S+)/.exec(b.extLog());
    const admT = adm ? Number(adm[2]) : NaN;
    const dropped = ctx.log.some((l) => l.includes("utterance_dropped_busy"));
    await ctx.until(() => !!userMessageFrame(b, "파일", del?.t ?? 0), 30_000);
    const vis = userMessageFrame(b, "파일", del?.t ?? 0);
    ctx.numbers.delegationToInputAdmittedMs = del && adm ? admT - del.t : null;
    ctx.numbers.admittedAs = adm?.[3] ?? null;
    ctx.numbers.delegationToUserMessageVisibleMs = del && vis ? vis.t - del.t : null;
    ctx.numbers.utteranceDroppedBusy = dropped;
    b.send({ id: `chk-${++rpcSeq}`, type: "abort" });
    await ctx.until(() => b.frames.some((x) => x.t > Date.now() - 100 && x.f.type === "agent_end"), 15_000);
    const ok = !!del && !!adm && adm[3] === "steer" && admT - del.t <= 2_000;
    return { ok, detail: `delegation.created->input_admitted(${adm?.[3] ?? "none"})=${ctx.numbers.delegationToInputAdmittedMs}ms; visible user message after ${ctx.numbers.delegationToUserMessageVisibleMs}ms (recorded); utterance_dropped_busy=${dropped}` };
  },
};

items.k = {
  group: "B",
  title: "one bridge per /voice lifetime: idle close -> /voice resume -> second session.start; stop -> 0",
  run: async (ctx) => {
    const base = await bridgeCount();
    if (base !== 0) throw new Error(`precondition: ${base} bridge processes already running`);
    const b = await startB(ctx, "k", { OLV_IDLE_MS: "15000" });
    const panel = await voiceOn(ctx, b);
    const p = startPanel(ctx, panel.port, panel.token, ["--tail-ms", "75000", "--linger-ms", "500"]);
    const counts: number[] = [];
    if (!(await liveStarted(ctx))) throw new Error("no session.started");
    counts.push(await bridgeCount());
    await ctx.until(() => sessionCloseSends(ctx).length > 0, 30_000);
    await ctx.until(() => p.envs.some((x) => x.e.type === "state" && x.e.reason === "idle"), 5_000);
    counts.push(await bridgeCount());
    const costBefore = ctx.tapsOf("cost").at(-1)?.msg.cumulativeMs ?? null;
    const resumeAt = Date.now();
    const at = b.frames.length;
    await prompt(ctx, b, "/voice");
    const resumed = await ctx.until(() => b.frames.slice(at).some((x) => x.f.method === "notify" && x.f.message === "음성 재개"), 10_000);
    await liveStarted(ctx, 2);
    counts.push(await bridgeCount());
    const starts = ctx.tapsOf("live_send", "session.start").length;
    const resumeSent = ctx.tapsOf("ext_out").filter((x) => x.msg?.type === "ready").length;
    const at2 = b.frames.length;
    await prompt(ctx, b, "/voice stop");
    await ctx.until(() => b.frames.slice(at2).some((x) => x.f.method === "notify" && x.f.message === "음성 종료"), 15_000);
    await ctx.until(() => /child_exit/.test(b.extLog()), 10_000);
    const costAfter = ctx.tapsOf("cost").filter((x) => x.t > resumeAt).at(-1)?.msg.cumulativeMs ?? null;
    const after = await bridgeCount();
    const spawns = (b.extLog().match(/spawn pid=/g) ?? []).length;
    Object.assign(ctx.numbers, { pgrepCounts: counts, pgrepAfterStop: after, sessionStartSends: starts, readyAnnouncements: resumeSent, resumeNotify: resumed, costBefore, costAfter, extSpawns: spawns });
    const ok = counts.every((c) => c === 1) && after === 0 && starts === 2 && resumed && spawns === 1 && costBefore !== null && costAfter !== null && costAfter >= costBefore;
    return { ok, detail: `pgrep counts=${counts.join(",")} after stop=${after}; session.start sends=${starts}; 음성 재개=${resumed}; spawns=${spawns}; cumulativeMs ${costBefore} -> ${costAfter}` };
  },
};

items.m = {
  group: "B",
  title: "REAL ask-user event: ask_user_question -> agent.question -> spoken header + 3 labels in order",
  run: async (ctx) => {
    const b = await startB(ctx, "m");
    const panel = await voiceOn(ctx, b);
    const p = startPanel(ctx, panel.port, panel.token, ["--tail-ms", "120000", "--linger-ms", "500"]);
    if (!(await liveStarted(ctx))) throw new Error("no session.started");
    const t0 = Date.now();
    const at = b.frames.length;
    b.send({ id: `chk-${++rpcSeq}`, type: "prompt", message: "ask_user_question 도구로 '빌드 방식'을 묻는 질문을 선택지 3개(테스트 발전소, 빌드 철도, 배포 연구소)로 내게. 다른 말은 하지 마." });
    const labels = ["테스트 발전소", "빌드 철도", "배포 연구소"];
    const dialog = () => b.frames.slice(at).find((x) => x.f.type === "extension_ui_request" && (x.f.method === "question" || x.f.method === "select"));
    await ctx.until(() => !!dialog(), 90_000);
    await ctx.until(() => orderedMatch(outputTranscript(ctx, t0), ["빌드 방식", ...labels]).missing === null, 60_000);
    const panelQ = p.envs.find((x) => x.e.type === "agent" && x.e.status === "question");
    const instr = ctx.tapsOf("live_send", "session.instructions.append").filter((x) => x.t >= t0);
    const text = outputTranscript(ctx, t0);
    const match = orderedMatch(text, ["빌드 방식", ...labels]);
    const d = dialog();
    if (d) b.send({ type: "extension_ui_response", id: d.f.id, cancelled: true });
    await ctx.until(() => b.frames.slice(at).some((x) => x.f.type === "agent_end"), 60_000);
    Object.assign(ctx.numbers, { dialogMethod: d?.f.method ?? null, panelAgentQuestion: panelQ?.e.question ?? null, instructionChunks: instr.map((x) => x.content), transcript: text, missingFragment: match.missing, agentEnded: b.frames.slice(at).some((x) => x.f.type === "agent_end") });
    const ok = !!d && !!panelQ && instr.length >= 1 && match.missing === null;
    return { ok, detail: `dialog=${d?.f.method ?? "none"}; panel agent.question=${!!panelQ}; instructions.append chunks=${instr.length}; missing=${match.missing ?? "none"}; agent_end after cancel=${ctx.numbers.agentEnded}` };
  },
};

type Row = { item: string; group: string; title: string; ok: boolean; detail: string; numbers: Record<string, unknown>; ledger: { seconds: number; usd: number }[]; ms: number; log: string; error?: string };
const rows: Row[] = [];
for (const id of ITEMS) {
  const def = items[id];
  if (!def) {
    console.error(`unknown item ${id}`);
    continue;
  }
  const total = ledgerTotal();
  if (!FAKE && total >= BUDGET_USD) {
    rows.push({ item: id, group: def.group, title: def.title, ok: false, detail: `budget: ledger ${total.toFixed(4)} >= ${BUDGET_USD}`, numbers: {}, ledger: [], ms: 0, log: "" });
    break;
  }
  const ctx = new Ctx(id);
  const started = Date.now();
  const deadline = setTimeout(() => ctx.abort(`item exceeded ${ITEM_MS / 1000} s`), ITEM_MS);
  let res: Result = { ok: false, detail: "not run" };
  let error: string | undefined;
  try {
    res = await def.run(ctx);
  } catch (e) {
    error = (e as Error).message;
    res = { ok: false, detail: `error: ${error}` };
  } finally {
    clearTimeout(deadline);
    await ctx.teardown();
    ctx.account();
  }
  if (ctx.aborted) {
    res.ok = false;
    res.detail += ` (aborted: ${ctx.aborted})`;
  }
  const logFile = join(LOG_DIR, `item-${id}.log`);
  writeFileSync(logFile, `${ctx.log.join("\n")}\n`);
  rmSync(ctx.tmp, { recursive: true, force: true });
  const row: Row = { item: id, group: def.group, title: def.title, ok: res.ok, detail: res.detail, numbers: ctx.numbers, ledger: ctx.ledger, ms: Date.now() - started, log: logFile, ...(error ? { error } : {}) };
  rows.push(row);
  console.log(`${res.ok ? "PASS" : "FAIL"} (${id}) [${def.group}] ${res.detail} | ledger=${JSON.stringify(ctx.ledger)} | ${row.ms}ms`);
}
const fl = fakeLive as { proc: ReturnType<typeof Bun.spawn> } | null;
if (fl) {
  fl.proc.kill();
  await fl.proc.exited;
}
if (OUT) writeFileSync(OUT, JSON.stringify({ fake: FAKE, ledgerTotal: ledgerTotal(), rows }, null, 2));
process.exit(rows.length > 0 && rows.every((r) => r.ok) ? 0 : 1);
