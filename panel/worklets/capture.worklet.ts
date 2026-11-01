import { MAX_FRAME_SAMPLES } from "../../shared/protocol.ts";
import { Resampler, WIRE_RATE, toPcm16 } from "../dsp.ts";
import "./worklet-env.ts";

export type CaptureIn = { type: "mute"; muted: boolean };
export type CaptureOut = { type: "frame"; generation: number; seq: number; pcm: Int16Array };

class CaptureProcessor extends AudioWorkletProcessor {
  private readonly resampler = new Resampler(sampleRate, WIRE_RATE);
  private readonly pending = new Float32Array(MAX_FRAME_SAMPLES);
  private filled = 0;
  private generation = 0;
  private seq = 0;
  private muted = false;
  private mono = new Float32Array(128);

  constructor() {
    super();
    this.port.onmessage = (ev: MessageEvent<CaptureIn>) => {
      const msg = ev.data;
      if (msg?.type !== "mute" || typeof msg.muted !== "boolean" || msg.muted === this.muted) return;
      this.muted = msg.muted;
      this.generation += 1;
      this.filled = 0; // queued mic audio (and filter history) of the old generation is invalidated
      this.resampler.reset();
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0] ?? [];
    const frames = channels[0]?.length ?? 128;
    if (this.mono.length !== frames) this.mono = new Float32Array(frames);
    const mono = this.mono;
    mono.fill(0);
    if (!this.muted && channels.length > 0) {
      for (const ch of channels) for (let i = 0; i < frames; i++) mono[i]! += ch[i]!;
      const scale = 1 / channels.length;
      for (let i = 0; i < frames; i++) mono[i]! *= scale;
    }
    const resampled = this.resampler.process(mono);
    let off = 0;
    while (off < resampled.length) {
      const n = Math.min(resampled.length - off, MAX_FRAME_SAMPLES - this.filled);
      this.pending.set(resampled.subarray(off, off + n), this.filled);
      this.filled += n;
      off += n;
      if (this.filled === MAX_FRAME_SAMPLES) {
        const pcm = toPcm16(this.pending);
        const out: CaptureOut = { type: "frame", generation: this.generation, seq: this.seq++, pcm };
        this.port.postMessage(out, [pcm.buffer]);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("olv-capture", CaptureProcessor);
