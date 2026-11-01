import { decodeFrame, encodeFrame, MAX_FRAME_SAMPLES } from "../../shared/protocol.ts";

const USAGE = `usage: bun fake-panel.ts --url <ws://127.0.0.1:PORT/...> --token <token> [options]

  --origin <origin>     Origin header (default: http://127.0.0.1:<port of --url>)
  --wav <file>          24 kHz mono PCM16 WAV streamed as 2,400-sample binary frames
  --pace <x>            real-time multiplier (default 1.0; 2 = twice as fast)
  --inject-at <ms> <wav> mix a second WAV into the mic stream starting at <ms> (after pacing; repeatable)
  --mute-at <ms>        send {type:"control",action:"mute"} at <ms>
  --tail-ms <ms>        silent mic frames after the audio so a burst can end (default 1000)
  --linger-ms <ms>      keep the socket open this long after the last frame (default 1500)
  --exit-after-ms <ms>  hard stop at <ms> from open regardless of streaming (default none)
  --expect-reject       the connection is expected to be refused (wrong token/Origin): exit 0 only if it is
  --out <file>          write the JSON summary here (also printed on the last stdout line)
  --help

Answers every bridge "flush" with {type:"playback", flushAck: generation} immediately.`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const num = (n: string, d: number) => {
  const v = opt(n);
  if (v === undefined) return d;
  const x = Number(v);
  if (!Number.isFinite(x) || x < 0) {
    console.error(`bad ${n}: ${v}`);
    process.exit(2);
  }
  return x;
};

export function readWav(bytes: Uint8Array): Int16Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a RIFF/WAVE file");
  let fmtOk = false;
  for (let o = 12; o + 8 <= bytes.length; ) {
    const id = tag(o);
    const size = dv.getUint32(o + 4, true);
    if (id === "fmt ") {
      const format = dv.getUint16(o + 8, true);
      const ch = dv.getUint16(o + 10, true);
      const rate = dv.getUint32(o + 12, true);
      const bits = dv.getUint16(o + 22, true);
      if (format !== 1 || ch !== 1 || rate !== 24000 || bits !== 16) throw new Error(`WAV must be PCM mono 24000 Hz 16-bit (got fmt=${format} ch=${ch} rate=${rate} bits=${bits})`);
      fmtOk = true;
    } else if (id === "data") {
      if (!fmtOk) throw new Error("WAV data chunk before fmt chunk");
      const n = Math.min(size, bytes.length - o - 8) >> 1;
      const out = new Int16Array(n);
      for (let i = 0; i < n; i++) out[i] = dv.getInt16(o + 8 + i * 2, true);
      return out;
    }
    o += 8 + size + (size & 1);
  }
  throw new Error("WAV has no data chunk");
}

const urlArg = opt("--url");
const token = opt("--token");
if (!urlArg || token === undefined) {
  console.error(USAGE);
  process.exit(2);
}
const url = new URL(urlArg);
const origin = opt("--origin") ?? `http://127.0.0.1:${url.port}`;
const pace = num("--pace", 1.0);
if (pace <= 0) {
  console.error("--pace must be > 0");
  process.exit(2);
}
const tailMs = num("--tail-ms", 1000);
const lingerMs = num("--linger-ms", 1500);
const muteAt = opt("--mute-at") !== undefined ? num("--mute-at", 0) : null;
const exitAfter = opt("--exit-after-ms") !== undefined ? num("--exit-after-ms", 0) : null;
const expectReject = args.includes("--expect-reject");
const outPath = opt("--out");

const mainWav = opt("--wav") ? readWav(new Uint8Array(await Bun.file(opt("--wav")!).arrayBuffer())) : new Int16Array(0);
const injects: { atMs: number; pcm: Int16Array }[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--inject-at") {
    const at = Number(args[i + 1]);
    const file = args[i + 2];
    if (!Number.isFinite(at) || at < 0 || !file) {
      console.error("--inject-at needs <ms> <wav>");
      process.exit(2);
    }
    injects.push({ atMs: at, pcm: readWav(new Uint8Array(await Bun.file(file).arrayBuffer())) });
  }
}

const FRAME = MAX_FRAME_SAMPLES;
const frameCount = (n: number) => Math.ceil(n / FRAME);
const timeline: Int16Array[] = [];
const slot = (i: number) => (timeline[i] ??= new Int16Array(FRAME));
const lay = (pcm: Int16Array, startSample: number) => {
  for (let i = 0; i < pcm.length; i++) {
    const p = startSample + i;
    const s = slot(Math.floor(p / FRAME));
    const k = p % FRAME;
    s[k] = Math.max(-32768, Math.min(32767, s[k]! + pcm[i]!));
  }
};
lay(mainWav, 0);
for (const inj of injects) lay(inj.pcm, Math.round((inj.atMs / 1000) * 24000 / FRAME) * FRAME);
const audioSlots = Math.max(frameCount(mainWav.length), ...injects.map((j) => Math.round((j.atMs / 1000) * 24000 / FRAME) + frameCount(j.pcm.length)), 0);
const totalSlots = audioSlots + Math.ceil((tailMs / 1000) * 24000 / FRAME);
for (let i = 0; i < totalSlots; i++) slot(i);
timeline.length = totalSlots;

const summary = {
  url: url.toString().replace(/token=[^&]*/, "token=***"),
  opened: false,
  rejected: false,
  closeCode: null as number | null,
  closeReason: "" as string,
  sentFrames: 0,
  sentSamples: 0,
  receivedPcmBytes: 0,
  receivedBinaryFrames: 0,
  binaryFrameErrors: 0,
  flushes: [] as { generation: number; reason: string }[],
  flushAcks: [] as number[],
  envelopeTypes: {} as Record<string, number>,
  envelopes: [] as unknown[],
};

let seq = 0;
const ws = new WebSocket(urlArg, { headers: { Origin: origin } } as never);
ws.binaryType = "arraybuffer";
const timers: ReturnType<typeof setTimeout>[] = [];
let finished = false;

function finish(code: number) {
  if (finished) return;
  finished = true;
  for (const t of timers) clearTimeout(t);
  const text = JSON.stringify(summary, null, 2);
  if (outPath) void Bun.write(outPath, text);
  console.log(JSON.stringify({ opened: summary.opened, rejected: summary.rejected, closeCode: summary.closeCode, sentFrames: summary.sentFrames, receivedPcmBytes: summary.receivedPcmBytes, envelopeTypes: summary.envelopeTypes, out: outPath ?? null }));
  try {
    ws.close();
  } catch {
    process.exit(code);
  }
  setTimeout(() => process.exit(code), 50);
}

const sendJson = (o: Record<string, unknown>) => ws.send(JSON.stringify({ v: 1, seq: seq++, ...o }));

ws.onopen = () => {
  summary.opened = true;
  sendJson({ type: "hello", token, capabilities: { audioWorklet: true, setSinkId: true }, sampleRate: 24000 });
  const t0 = performance.now();
  for (let i = 0; i < timeline.length; i++) {
    const due = (i * 100) / pace;
    timers.push(
      setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(encodeFrame(0, i, timeline[i]!));
        summary.sentFrames++;
        summary.sentSamples += FRAME;
      }, Math.max(0, due - (performance.now() - t0))),
    );
  }
  if (muteAt !== null) timers.push(setTimeout(() => ws.readyState === WebSocket.OPEN && sendJson({ type: "control", action: "mute" }), muteAt));
  const endMs = (timeline.length * 100) / pace + lingerMs;
  timers.push(setTimeout(() => finish(expectReject ? 1 : 0), exitAfter !== null ? Math.min(exitAfter, endMs) : endMs));
};

ws.onmessage = (m) => {
  if (typeof m.data === "string") {
    let env: { type?: string; generation?: number; reason?: string };
    try {
      env = JSON.parse(m.data);
    } catch {
      summary.envelopes.push({ _unparsable: m.data.slice(0, 200) });
      return;
    }
    summary.envelopes.push(env);
    const t = env.type ?? "?";
    summary.envelopeTypes[t] = (summary.envelopeTypes[t] ?? 0) + 1;
    console.log(`envelope ${JSON.stringify(env)}`);
    if (t === "flush" && typeof env.generation === "number") {
      summary.flushes.push({ generation: env.generation, reason: String(env.reason) });
      sendJson({ type: "playback", generation: env.generation, consumedSamples: 0, bufferedSamples: 0, flushAck: env.generation });
      summary.flushAcks.push(env.generation);
    }
  } else {
    try {
      const f = decodeFrame(m.data as ArrayBuffer);
      summary.receivedBinaryFrames++;
      summary.receivedPcmBytes += f.pcm.length * 2;
    } catch {
      summary.binaryFrameErrors++;
    }
  }
};

ws.onclose = (e) => {
  summary.closeCode = e.code;
  summary.closeReason = e.reason;
  if (!summary.opened) summary.rejected = true;
  finish(expectReject ? (summary.opened ? 1 : 0) : summary.opened ? 0 : 1);
};
ws.onerror = () => {
  if (!summary.opened) summary.rejected = true;
};
process.on("SIGTERM", () => finish(0));
process.on("SIGINT", () => finish(0));
