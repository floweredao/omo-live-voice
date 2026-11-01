import type { CaptureOut } from "./worklets/capture.worklet.ts";
import type { PlaybackIn, PlaybackOut } from "./worklets/playback.worklet.ts";

export type CaptureFrame = { generation: number; seq: number; pcm: Int16Array };
export type PlaybackReport = { generation: number; consumedSamples: number; bufferedSamples: number; flushAck?: number };
export type AudioDevice = { id: string; label: string };

export interface AudioCallbacks {
  onFrame(frame: CaptureFrame): void;
  onPlayback(report: PlaybackReport): void;
  onOverflow?(generation: number, droppedSamples: number): void;
}

export interface QaParams {
  qa: boolean;
  qaWav: string | null; // absolute same-origin URL under /assets/qa/, or null
}

const QA_PREFIX = "/assets/qa/";

/** Reads `?qa=1&qa_wav=...`; a qa_wav outside same-origin /assets/qa/ is ignored. */
export function parseQaParams(search: string, href: string): QaParams {
  const params = new URLSearchParams(search);
  const qa = params.get("qa") === "1";
  const raw = params.get("qa_wav");
  if (!qa || !raw) return { qa, qaWav: null };
  let url: URL;
  try {
    url = new URL(raw, href);
  } catch {
    return { qa, qaWav: null };
  }
  const ok = url.origin === new URL(href).origin && url.pathname.startsWith(QA_PREFIX) && url.pathname.endsWith(".wav");
  return { qa, qaWav: ok ? url.href : null };
}

type SinkCapableContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };
type SinkCapableElement = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };

export function audioCapabilities(): { audioWorklet: boolean; setSinkId: boolean } {
  const g = globalThis as { AudioContext?: { prototype: object }; HTMLMediaElement?: { prototype: object }; AudioWorkletNode?: unknown };
  return {
    audioWorklet: typeof g.AudioWorkletNode === "function" && !!g.AudioContext && "audioWorklet" in g.AudioContext.prototype,
    setSinkId: (!!g.AudioContext && "setSinkId" in g.AudioContext.prototype) || (!!g.HTMLMediaElement && "setSinkId" in g.HTMLMediaElement.prototype),
  };
}

/** Resolves with a running AudioContext: immediately when `qa`, otherwise on the first user gesture. */
export function armAudioContext(qa: boolean, target: EventTarget = window): Promise<AudioContext> {
  const create = async (): Promise<AudioContext> => {
    const ctx = new AudioContext({ latencyHint: "interactive" });
    if (ctx.state !== "running") await ctx.resume().catch(() => undefined);
    return ctx;
  };
  if (qa) return create();
  return new Promise((resolve, reject) => {
    const events = ["pointerdown", "keydown", "touchend"] as const;
    const onGesture = () => {
      for (const e of events) target.removeEventListener(e, onGesture);
      create().then(resolve, reject);
    };
    for (const e of events) target.addEventListener(e, onGesture);
  });
}

export async function listDevices(): Promise<{ inputs: AudioDevice[]; outputs: AudioDevice[] }> {
  const all = await navigator.mediaDevices.enumerateDevices();
  const pick = (kind: MediaDeviceKind): AudioDevice[] =>
    all.filter((d) => d.kind === kind).map((d, i) => ({ id: d.deviceId, label: d.label || `${kind === "audioinput" ? "마이크" : "스피커"} ${i + 1}` }));
  return { inputs: pick("audioinput"), outputs: pick("audiooutput") };
}

export interface PanelAudioOptions {
  qa: QaParams;
  callbacks: AudioCallbacks;
  /** Directory URL holding capture.worklet.js / playback.worklet.js; defaults to ./worklets/ next to the bundle. */
  workletBase?: string;
}

export class PanelAudio {
  readonly ctx: AudioContext;
  private readonly opts: PanelAudioOptions;
  private capture: AudioWorkletNode | null = null;
  private playback: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private source: AudioNode | null = null;
  private stream: MediaStream | null = null;
  private sinkElement: SinkCapableElement | null = null;

  private constructor(ctx: AudioContext, opts: PanelAudioOptions) {
    this.ctx = ctx;
    this.opts = opts;
  }

  /** Loads both worklets and builds the playback graph. Never assumes a 48 kHz context. */
  static async create(ctx: AudioContext, opts: PanelAudioOptions): Promise<PanelAudio> {
    if (!audioCapabilities().audioWorklet) throw new Error("이 브라우저는 실시간 오디오 처리를 지원하지 않아요.");
    const base = opts.workletBase ?? new URL("./worklets/", import.meta.url).href;
    await ctx.audioWorklet.addModule(new URL("capture.worklet.js", base).href);
    await ctx.audioWorklet.addModule(new URL("playback.worklet.js", base).href);
    const audio = new PanelAudio(ctx, opts);
    audio.buildPlayback();
    return audio;
  }

  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  private buildPlayback(): void {
    const node = new AudioWorkletNode(this.ctx, "olv-playback", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    node.port.onmessage = (ev: MessageEvent<PlaybackOut>) => {
      const m = ev.data;
      const cb = this.opts.callbacks;
      if (m.type === "stats") cb.onPlayback({ generation: m.generation, consumedSamples: m.consumed, bufferedSamples: m.buffered });
      else if (m.type === "flushAck") cb.onPlayback({ generation: m.generation, consumedSamples: 0, bufferedSamples: 0, flushAck: m.generation });
      else if (m.type === "overflow") cb.onOverflow?.(m.generation, m.dropped);
    };
    node.connect(this.ctx.destination);
    this.playback = node;
  }

  /**
   * Starts capture. With `?qa=1`, a valid qa_wav and a bridge hello carrying `qa: true`, the WAV is fed
   * through an AudioBufferSourceNode instead of the microphone.
   */
  async startCapture(opts: { deviceId?: string; bridgeQa: boolean }): Promise<{ source: "mic" | "qa-wav"; settings: MediaTrackSettings | null }> {
    this.stopCapture();
    const node = new AudioWorkletNode(this.ctx, "olv-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    node.port.onmessage = (ev: MessageEvent<CaptureOut>) => {
      const m = ev.data;
      if (m.type === "frame") this.opts.callbacks.onFrame({ generation: m.generation, seq: m.seq, pcm: m.pcm });
    };
    // Zero-gain sink keeps the capture worklet pulled by the render graph without echoing the mic.
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink).connect(this.ctx.destination);
    this.capture = node;
    this.sink = sink;

    const { qa, qaWav } = this.opts.qa;
    if (qa && opts.bridgeQa && qaWav) {
      const res = await fetch(qaWav);
      if (!res.ok) throw new Error(`샘플 오디오를 불러오지 못했어요 (${res.status})`);
      const buffer = await this.ctx.decodeAudioData(await res.arrayBuffer());
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(node);
      src.start();
      this.source = src;
      return { source: "qa-wav", settings: null };
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    const src = this.ctx.createMediaStreamSource(stream);
    src.connect(node);
    this.stream = stream;
    this.source = src;
    return { source: "mic", settings: stream.getAudioTracks()[0]?.getSettings() ?? null };
  }

  stopCapture(): void {
    if (this.source instanceof AudioBufferSourceNode) this.source.stop();
    this.source?.disconnect();
    this.source = null;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    this.capture?.port.close();
    this.capture?.disconnect();
    this.capture = null;
    this.sink?.disconnect();
    this.sink = null;
  }

  setMuted(muted: boolean): void {
    this.capture?.port.postMessage({ type: "mute", muted });
  }

  play(generation: number, pcm: Int16Array): void {
    const msg: PlaybackIn = { type: "frame", generation, pcm };
    this.playback?.port.postMessage(msg, [pcm.buffer]);
  }

  flush(generation: number): void {
    const msg: PlaybackIn = { type: "flush", generation };
    this.playback?.port.postMessage(msg);
  }

  /** Routes playback to an output device; returns false when the browser cannot select sinks. */
  async setOutputDevice(deviceId: string): Promise<boolean> {
    const ctx = this.ctx as SinkCapableContext;
    if (typeof ctx.setSinkId === "function") {
      await ctx.setSinkId(deviceId);
      return true;
    }
    if (!this.playback || typeof (HTMLMediaElement.prototype as SinkCapableElement).setSinkId !== "function") return false;
    if (!this.sinkElement) {
      const dest = this.ctx.createMediaStreamDestination();
      this.playback.disconnect();
      this.playback.connect(dest);
      const el = new Audio() as SinkCapableElement;
      el.srcObject = dest.stream;
      this.sinkElement = el;
    }
    await this.sinkElement.setSinkId!(deviceId);
    await this.sinkElement.play();
    return true;
  }

  async close(): Promise<void> {
    this.stopCapture();
    this.playback?.port.close();
    this.playback?.disconnect();
    this.playback = null;
    this.sinkElement?.pause();
    this.sinkElement = null;
    await this.ctx.close();
  }
}
