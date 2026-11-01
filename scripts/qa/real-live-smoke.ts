// Gated real GPT-Live smoke: WAV in -> utterance out -> cedar audio back. Costs real money (~$0.05/min).
// Usage: OLV_LIVE_E2E=1 bun scripts/qa/real-live-smoke.ts
// Env: OLV_COST_LEDGER overrides the ledger path (QA of the budget gate; then no handoff file is written).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, appendFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const MAIN = process.env.OLV_MAIN_CHECKOUT ?? join(homedir(), "Documents/Projects/omo-live-voice");
const DEFAULT_LEDGER = `${MAIN}/.omo/handoff/cost-ledger.jsonl`;
const HANDOFF = process.env.OLV_SMOKE_HANDOFF ?? `${MAIN}/.omo/handoff/p3/n3-real-live-smoke.md`;
const EVIDENCE_DIR = `${MAIN}/.omo/evidence/p3`;
const LEDGER = process.env.OLV_COST_LEDGER ?? DEFAULT_LEDGER;
const WAV = `${ROOT}fixtures/ko-list-files.wav`;
const BUDGET_USD = 5.0;
const RUN_CAP_USD = 0.1;
const USD_PER_SEC = 0.05 / 60;
const CAP_CONNECTED_MS = 110_000;
// The bridge drops mic audio until the Live handshake completes (~1.7 s), so the WAV starts after it.
const INJECT_MS = 3000;

if (process.env.OLV_LIVE_E2E !== "1") {
  console.error("refusing: set OLV_LIVE_E2E=1");
  process.exit(2);
}

function ledgerTotal(path: string): number {
  if (!existsSync(path)) return 0;
  let sum = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const usd = Number((JSON.parse(line) as { usd?: unknown }).usd);
      if (Number.isFinite(usd)) sum += usd;
    } catch {
      // ignore unparsable ledger lines
    }
  }
  return sum;
}

const total = ledgerTotal(LEDGER);
if (total >= BUDGET_USD) {
  console.log(`ledger total ${total.toFixed(4)} >= ${BUDGET_USD.toFixed(2)}`);
  console.log("VERDICT: FAIL budget");
  process.exit(3);
}

mkdirSync(EVIDENCE_DIR, { recursive: true });
const t0 = Date.now();
const scrub = (s: string) => s.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***");
const logLines: string[] = [];
const note = (src: string, line: string) => logLines.push(`${String(Date.now() - t0).padStart(6)}ms ${src} ${scrub(line)}`);

// Preload for the bridge only: logs the voice/usage the real server reported (never the key).
const tmp = mkdtempSync(join(tmpdir(), "olv-smoke-"));
const preload = join(tmp, "preload.js");
writeFileSync(
  preload,
  `const O=globalThis.WebSocket;globalThis.WebSocket=class extends O{constructor(...a){super(...a);this.addEventListener("message",(m)=>{try{if(typeof m.data!=="string")return;const e=JSON.parse(m.data);if(e.type==="session.started")process.stderr.write("OLV_PRELOAD session.started voice="+String(e.session&&e.session.audio&&e.session.audio.output&&e.session.audio.output.voice)+" model="+String(e.session&&e.session.model)+"\\n");else if(e.type==="session.closed")process.stderr.write("OLV_PRELOAD session.closed usage_seconds="+String(e.usage&&e.usage.seconds)+"\\n")}catch{}})}};\n`,
);

const wavBytes = Bun.file(WAV).size;
const wavMs = ((wavBytes - 44) / 2 / 24000) * 1000;

type Ext = { type: string; [k: string]: any };
const checks: Record<string, { ok: boolean; detail: string }> = {};
const m: Record<string, number | string | null> = {
  speechEndToUtteranceMs: null,
  agentEndToFirstAudioMs: null,
  outputBytes: null,
  usageSeconds: null,
  usd: null,
};

let voice = "";
let liveStartedAt: number | null = null;
let liveClosedLine = "";
let usageSeconds: number | null = null;
let outputState = "idle";
let utterance: Ext | null = null;
let utteranceAt = 0;
let panelHelloAt = 0;
let agentEndAt = 0;
let armed = false;
let firstAudioAt = 0;
let sawIdleAfter = false;
let assistantMatched = "";
let extExitedAt = 0;
let extExitCode: number | null = null;
let aborted = "";
const waiters = new Set<() => void>();
const poke = () => waiters.forEach((w) => w());
function until(cond: () => boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (cond()) return resolve(true);
    const w = () => {
      if (cond()) done(true);
    };
    const timer = setTimeout(() => done(false), ms);
    const done = (v: boolean) => {
      clearTimeout(timer);
      waiters.delete(w);
      resolve(v);
    };
    waiters.add(w);
  });
}

async function lines(stream: ReadableStream<Uint8Array>, onLine: (l: string) => void) {
  const dec = new TextDecoder();
  let buf = "";
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value;
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      onLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  }
  if (buf) onLine(buf);
  reader.releaseLock();
}

let ready: Ext | null = null;
const ext = Bun.spawn(
  ["bun", `${ROOT}scripts/qa/fake-ext-host.ts`, "--env", "OLV_QA=1", "--env", `BUN_OPTIONS=--preload ${preload}`, "--env", `OLV_DATA_DIR=${join(tmp, "data")}`],
  { stdin: "pipe", stdout: "pipe", stderr: "pipe", cwd: ROOT },
);
const sendExt = (msg: Ext) => {
  ext.stdin.write(`emit ${JSON.stringify(msg)}\n`);
  ext.stdin.flush();
  note("ext<-", JSON.stringify(msg).slice(0, 200));
};

void lines(ext.stdout as ReadableStream<Uint8Array>, (l) => {
  note("ext", l.length > 300 ? `${l.slice(0, 300)}...` : l);
  if (l.startsWith("{") && !ready) {
    try {
      ready = JSON.parse(l) as Ext;
    } catch {
      // not the ready line
    }
  } else if (l.startsWith("recv ")) {
    let msg: Ext;
    try {
      msg = JSON.parse(l.slice(5)) as Ext;
    } catch {
      return poke();
    }
    if (msg.type === "utterance" && msg.kind === "message" && !utterance) {
      utterance = msg;
      utteranceAt = Date.now();
    } else if (msg.type === "state") {
      outputState = String(msg.output);
      if (agentEndAt) {
        if (outputState !== "speaking") {
          armed = true;
          if (firstAudioAt) sawIdleAfter = true;
        } else if (armed && !firstAudioAt) firstAudioAt = Date.now();
      }
    }
  } else if (l.startsWith("child-exit ")) {
    extExitCode = Number(l.slice(11));
  }
  poke();
});
void lines(ext.stderr as ReadableStream<Uint8Array>, (l) => {
  note("bridge", l);
  const v = /OLV_PRELOAD session\.started voice=(\S+)/.exec(l);
  if (v) voice = v[1]!;
  if (l.includes("LIVE_STARTED") && liveStartedAt === null) {
    liveStartedAt = Date.now();
    setTimeout(() => {
      if (!extExitedAt) {
        aborted = "budget: 110 s connected cap reached";
        poke();
      }
    }, CAP_CONNECTED_MS).unref();
  }
  const u = /OLV_PRELOAD session\.closed usage_seconds=(\S+)/.exec(l);
  if (u && Number.isFinite(Number(u[1]))) usageSeconds = Number(u[1]);
  if (l.includes("LIVE_CLOSED")) liveClosedLine = l;
  poke();
});
void ext.exited.then((code) => {
  extExitedAt = Date.now();
  extExitCode = extExitCode ?? code;
  poke();
});

let panel: ReturnType<typeof Bun.spawn> | null = null;
const panelOut = join(tmp, "panel.json");
let panelSummary: { receivedPcmBytes?: number } = {};

async function run() {
  if (!(await until(() => ready !== null || !!extExitedAt, 15_000)) || !ready) throw new Error("bridge ready not received in 15 s");
  const r = ready as Ext;
  const url = `ws://127.0.0.1:${r.port}/ws?token=${r.token}`;
  panel = Bun.spawn(
    ["bun", `${ROOT}scripts/qa/fake-panel.ts`, "--url", url, "--token", r.token, "--inject-at", String(INJECT_MS), WAV, "--tail-ms", "3000", "--linger-ms", "105000", "--exit-after-ms", "105000", "--out", panelOut],
    { stdout: "pipe", stderr: "pipe", cwd: ROOT },
  );
  void lines(panel.stdout as ReadableStream<Uint8Array>, (l) => {
    note("panel", l.length > 300 ? `${l.slice(0, 300)}...` : l);
    if (l.startsWith("envelope ")) {
      try {
        const e = JSON.parse(l.slice(9)) as Ext;
        if (e.type === "hello" && !panelHelloAt) panelHelloAt = Date.now();
        if (e.type === "transcript" && e.speaker === "assistant" && agentEndAt && /세 개|파일/.test(String(e.text)) && !assistantMatched) assistantMatched = String(e.text);
      } catch {
        // ignore
      }
    }
    poke();
  });
  void lines(panel.stderr as ReadableStream<Uint8Array>, (l) => note("panel!", l));

  // (1) utterance within 30 s of the WAV end
  const gotUtt = await until(() => utterance !== null || !!aborted || !!extExitedAt, 5_000 + wavMs + 30_000);
  const norm = String((utterance as Ext | null)?.text ?? "").normalize("NFC").replace(/\s+/g, "");
  const speechEnd = panelHelloAt + INJECT_MS + wavMs;
  if (utterance) m.speechEndToUtteranceMs = Math.round(utteranceAt - speechEnd);
  checks["1 utterance kind=message contains 파일+목록 within 30 s of WAV end"] = {
    ok: gotUtt && !!utterance && norm.includes("파일") && norm.includes("목록") && utteranceAt - speechEnd <= 30_000,
    detail: utterance ? `text=${JSON.stringify((utterance as Ext).text)} latency=${m.speechEndToUtteranceMs}ms` : "no utterance",
  };
  if (!utterance) return;

  // (2) agent reply -> audio back
  sendExt({ type: "agent.tool.start", name: "bash" });
  await Bun.sleep(1500); // scripted agent latency (+1500 ms per spec), not a test wait
  agentEndAt = Date.now();
  armed = outputState !== "speaking";
  sendExt({ type: "agent.end", text: "src 폴더에 파일이 세 개 있어요. ```ls```" });
  await until(() => (!!assistantMatched && sawIdleAfter) || !!aborted || !!extExitedAt, 10_000);
  panel.kill("SIGTERM");
  await Promise.race([panel.exited, Bun.sleep(3000)]);
  try {
    panelSummary = JSON.parse(readFileSync(panelOut, "utf8"));
  } catch {
    panelSummary = {};
  }
  m.outputBytes = panelSummary.receivedPcmBytes ?? 0;
  if (firstAudioAt) m.agentEndToFirstAudioMs = firstAudioAt - agentEndAt;
  checks["2 >= 48000 PCM bytes within 10 s of agent.end + assistant transcript 세 개|파일"] = {
    ok: Number(m.outputBytes) >= 48_000 && !!assistantMatched && !!firstAudioAt && firstAudioAt - agentEndAt <= 10_000,
    detail: `bytes=${m.outputBytes} firstAudio=${m.agentEndToFirstAudioMs}ms transcript=${JSON.stringify(assistantMatched)}`,
  };
  checks["3 session.started voice is cedar"] = { ok: voice === "cedar", detail: `voice=${voice || "(not observed)"}` };
}

let failure = "";
try {
  await run();
} catch (e) {
  failure = (e as Error).message;
} finally {
  // (4) stop path
  const stopAt = Date.now();
  if (!extExitedAt) {
    try {
      sendExt({ type: "stop" });
    } catch {
      // ext host already gone
    }
    if (!(await until(() => !!extExitedAt, 30_000))) ext.kill("SIGKILL");
  }
  const panelToKill = panel as ReturnType<typeof Bun.spawn> | null;
  if (panelToKill) panelToKill.kill("SIGKILL");
  const stopMs = (extExitedAt || Date.now()) - stopAt;
  await Bun.sleep(0);
  const closed = liveClosedLine !== "";
  checks["4 stop -> bridge exits 0 within 5 s and LIVE_CLOSED logged"] = {
    ok: extExitCode === 0 && stopMs <= 5_000 && closed,
    detail: `exit=${extExitCode} stopMs=${stopMs} ${closed ? scrubLine(liveClosedLine) : "no LIVE_CLOSED"}`,
  };
}

function scrubLine(l: string): string {
  return /LIVE_CLOSED[^"]*/.exec(scrub(l))?.[0] ?? "LIVE_CLOSED";
}

const connectedSec = liveStartedAt === null ? 0 : (Date.now() - liveStartedAt) / 1000;
const sec = usageSeconds ?? Math.ceil(connectedSec);
const usd = Number((sec * USD_PER_SEC).toFixed(4));
m.usageSeconds = sec;
m.usd = usd;
if (liveStartedAt !== null) {
  appendFileSync(LEDGER, `${JSON.stringify({ ts: new Date().toISOString(), node: "n3-real-live-smoke", seconds: sec, usd })}\n`);
}
if (usd > RUN_CAP_USD || aborted) failure ||= aborted || `budget: run cost ${usd} > ${RUN_CAP_USD}`;

const allOk = Object.values(checks).length === 4 && Object.values(checks).every((c) => c.ok) && !failure;
const verdict = allOk ? "VERDICT: PASS" : failure.startsWith("budget") ? "VERDICT: FAIL budget" : `VERDICT: FAIL ${failure || Object.entries(checks).filter(([, c]) => !c.ok).map(([k]) => k.split(" ")[0]).join(",") || "incomplete"}`;

writeFileSync(`${EVIDENCE_DIR}/real-live-smoke-run.log`, `${logLines.join("\n")}\n`);
const md = [
  "# n3-real-live-smoke handoff",
  "",
  `Run at ${new Date().toISOString()}; ledger ${LEDGER}; WAV ${WAV} (${wavMs.toFixed(0)} ms).`,
  "",
  "## metrics",
  "| metric | value |",
  "| --- | --- |",
  `| speech-end -> utterance (ms) | ${m.speechEndToUtteranceMs} |`,
  `| agent.end -> first audio (ms) | ${m.agentEndToFirstAudioMs} |`,
  `| output bytes (PCM) | ${m.outputBytes} |`,
  `| usage.seconds | ${m.usageSeconds} |`,
  `| usd | ${m.usd} |`,
  "",
  "## checks",
  ...Object.entries(checks).map(([k, c]) => `- ${c.ok ? "PASS" : "FAIL"} ${k}: ${c.detail}`),
  failure ? `\nfailure: ${failure}` : "",
  "",
  verdict,
  "",
].join("\n");
console.log(md);
if (!process.env.OLV_COST_LEDGER || process.env.OLV_SMOKE_HANDOFF) writeFileSync(HANDOFF, md);
rmSync(tmp, { recursive: true, force: true });
process.exit(allOk ? 0 : 1);
