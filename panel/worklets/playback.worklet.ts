import { RingBuffer, Resampler, WIRE_RATE, fromPcm16 } from "../dsp.ts";
import "./worklet-env.ts";

export type PlaybackIn = { type: "frame"; generation: number; pcm: Int16Array } | { type: "flush"; generation: number };
export type PlaybackOut =
  | { type: "flushAck"; generation: number; buffered: 0 }
  | { type: "stats"; buffered: number; consumed: number; generation: number }
  | { type: "overflow"; generation: number; dropped: number };

const RING_SAMPLES = WIRE_RATE; // 1 s
const STARTUP_SAMPLES = WIRE_RATE / 10; // 100 ms
const TARGET_SAMPLES = (WIRE_RATE * 3) / 20; // 150 ms: re-buffer level after an underrun
const TAIL_SAMPLES = WIRE_RATE / 100; // 10 ms fading tail kept on flush
const PULL_SAMPLES = 64;
const MAX_PENDING_SAMPLES = RING_SAMPLES;

type Mode = "buffering" | "playing" | "draining";

class PlaybackProcessor extends AudioWorkletProcessor {
  private readonly ring = new RingBuffer(RING_SAMPLES);
  private readonly resampler = new Resampler(WIRE_RATE, sampleRate);
  private readonly pull = new Float32Array(PULL_SAMPLES);
  private fifo = new Float32Array(1024);
  private fifoLen = 0;
  private mode: Mode = "buffering";
  private threshold = STARTUP_SAMPLES;
  private generation = 0;
  private consumed = 0;
  private pending: Int16Array[] = [];
  private pendingSamples = 0;
  private fadeInLeft = 0;
  private readonly fadeInLen = Math.max(1, Math.round(sampleRate * 0.0025));
  private readonly statsEvery = Math.round(sampleRate / 4);
  private sinceStats = 0;

  constructor() {
    super();
    this.port.onmessage = (ev: MessageEvent<PlaybackIn>) => this.onMessage(ev.data);
  }

  private post(msg: PlaybackOut): void {
    this.port.postMessage(msg);
  }

  private onMessage(msg: PlaybackIn): void {
    if (!msg || typeof msg.generation !== "number" || !Number.isFinite(msg.generation)) return;
    if (msg.type === "flush") {
      if (msg.generation < this.generation) return;
      this.generation = msg.generation;
      this.pending = [];
      this.pendingSamples = 0;
      if (this.mode === "buffering") {
        this.ring.clear(); // nothing audible yet: no tail to play out
        this.finishFlush();
      } else {
        this.ring.flush(TAIL_SAMPLES);
        this.mode = "draining";
      }
      return;
    }
    if (msg.type !== "frame" || !(msg.pcm instanceof Int16Array)) return;
    if (msg.generation < this.generation) return;
    if (this.mode === "draining") {
      if (this.pendingSamples + msg.pcm.length <= MAX_PENDING_SAMPLES) {
        this.pending.push(msg.pcm);
        this.pendingSamples += msg.pcm.length;
      } else this.post({ type: "overflow", generation: msg.generation, dropped: msg.pcm.length });
      return;
    }
    this.generation = msg.generation;
    this.admit(msg.pcm);
  }

  private admit(pcm: Int16Array): void {
    const accepted = this.ring.push(fromPcm16(pcm));
    if (accepted < pcm.length) this.post({ type: "overflow", generation: this.generation, dropped: pcm.length - accepted });
  }

  private finishFlush(): void {
    this.resampler.reset();
    this.fifoLen = 0;
    this.mode = "buffering";
    this.threshold = STARTUP_SAMPLES;
    this.post({ type: "flushAck", generation: this.generation, buffered: 0 });
    const queued = this.pending;
    this.pending = [];
    this.pendingSamples = 0;
    for (const pcm of queued) this.admit(pcm);
  }

  private refill(need: number): void {
    while (this.fifoLen < need && this.ring.buffered > 0) {
      const n = this.ring.read(this.pull);
      this.consumed += n;
      const y = this.resampler.process(this.pull.subarray(0, n));
      if (this.fifoLen + y.length > this.fifo.length) {
        const grown = new Float32Array((this.fifoLen + y.length) * 2);
        grown.set(this.fifo.subarray(0, this.fifoLen));
        this.fifo = grown;
      }
      this.fifo.set(y, this.fifoLen);
      this.fifoLen += y.length;
    }
  }

  private take(out: Float32Array, n: number): void {
    out.set(this.fifo.subarray(0, n));
    this.fifo.copyWithin(0, n, this.fifoLen);
    this.fifoLen -= n;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0] ?? [];
    const out = channels[0];
    if (!out) return true;
    const frames = out.length;
    out.fill(0);

    if (this.mode === "buffering" && this.ring.buffered >= this.threshold) {
      this.mode = "playing";
      this.fadeInLeft = this.fadeInLen;
    }
    if (this.mode !== "buffering") {
      this.refill(frames);
      const n = Math.min(frames, this.fifoLen);
      this.take(out, n);
      for (let i = 0; i < n && this.fadeInLeft > 0; i++, this.fadeInLeft--) {
        out[i]! *= 1 - this.fadeInLeft / this.fadeInLen;
      }
      if (n < frames) {
        if (this.mode === "draining") {
          this.finishFlush();
        } else {
          for (let i = 0; i < n; i++) out[i]! *= 1 - (i + 1) / n; // underrun: fade what is left, then re-buffer
          this.mode = "buffering";
          this.threshold = TARGET_SAMPLES;
        }
      }
    }
    for (let c = 1; c < channels.length; c++) channels[c]!.set(out);

    this.sinceStats += frames;
    if (this.sinceStats >= this.statsEvery) {
      this.sinceStats -= this.statsEvery;
      this.post({ type: "stats", buffered: this.ring.buffered, consumed: this.consumed, generation: this.generation });
    }
    return true;
  }
}

registerProcessor("olv-playback", PlaybackProcessor);
