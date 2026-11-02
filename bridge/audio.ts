export const LIVE_RATE = 24_000;
export const LIVE_BYTES_PER_MS = 48;

export class InputPacer {
  private queue: Uint8Array[] = [];
  private queued = 0;
  private readonly maxBytes: number;

  constructor(maxBufferMs = 600) {
    this.maxBytes = maxBufferMs * LIVE_BYTES_PER_MS;
  }

  push(bytes: Uint8Array): void {
    if (!bytes.length) return;
    this.queue.push(bytes);
    this.queued += bytes.length;
    while (this.queued > this.maxBytes) {
      const head = this.queue[0]!;
      const drop = Math.min(head.length, this.queued - this.maxBytes);
      if (drop === head.length) this.queue.shift();
      else this.queue[0] = head.subarray(drop);
      this.queued -= drop;
    }
  }

  get bufferedBytes(): number {
    return this.queued;
  }

  take(ms = 100): Uint8Array {
    const bytes = ms * LIVE_BYTES_PER_MS;
    const out = new Uint8Array(bytes);
    let offset = 0;
    while (offset < bytes && this.queue.length) {
      const head = this.queue[0]!;
      const count = Math.min(head.length, bytes - offset);
      out.set(head.subarray(0, count), offset);
      offset += count;
      if (count === head.length) this.queue.shift();
      else this.queue[0] = head.subarray(count);
      this.queued -= count;
    }
    return out;
  }
}

function rms(pcm: Int16Array): number {
  if (!pcm.length) return 0;
  let sum = 0;
  for (const sample of pcm) sum += sample * sample;
  return Math.sqrt(sum / pcm.length);
}

export function isVoiced(pcm: Int16Array, threshold = 300): boolean {
  return pcm.length > 0 && rms(pcm) >= threshold;
}

export class VoiceActivity {
  private burstMs = 0;
  private lastVoiced = -Infinity;

  constructor(
    private readonly threshold = 500,
    private readonly gapMs = 300,
    private readonly now: () => number = () => Date.now(),
  ) {}

  push(pcm: Int16Array): number {
    if (!pcm.length || rms(pcm) < this.threshold) return 0;
    const time = this.now();
    if (time - this.lastVoiced > this.gapMs) this.burstMs = 0;
    this.lastVoiced = time;
    this.burstMs += (pcm.length * 1000) / LIVE_RATE;
    return this.burstMs;
  }

  classify(pcm: Int16Array, speaking: boolean): "interrupt" | "speech.start" | null {
    const burstMs = this.push(pcm);
    if (burstMs >= 200 && speaking) return "interrupt";
    if (burstMs >= 400 && !speaking) return "speech.start";
    return null;
  }
}

export class TurnGate {
  private requestedUntil = 0;
  private holding = false;
  private dropping = false;
  private lastVoiced = -Infinity;
  private lastPassedVoiced = -Infinity;
  private ownerVoicedAt = -Infinity;

  constructor(
    private readonly utteranceGapMs = 600,
    private readonly ownerQuietMs = 200,
    private readonly tailMs = 600,
    private readonly now: () => number = () => Date.now(),
    private readonly dropGapMs = 1500,
  ) {}

  request(ms: number): void {
    this.requestedUntil = Math.max(this.requestedUntil, this.now() + ms);
  }

  hold(on: boolean): void {
    this.holding = on;
  }

  ownerVoiced(): void {
    this.ownerVoicedAt = this.now();
  }

  bargeIn(): void {
    this.requestedUntil = 0;
    if (this.speaking) this.dropping = true;
  }

  get speaking(): boolean {
    return this.now() - this.lastPassedVoiced < this.utteranceGapMs;
  }

  get audible(): boolean {
    return !this.dropping;
  }

  pass(voiced: boolean): boolean {
    const time = this.now();
    if (!voiced) return !this.dropping && time - this.lastPassedVoiced < this.tailMs;
    if (time - this.lastVoiced >= (this.dropping ? this.dropGapMs : this.utteranceGapMs)) {
      const ownerTalking = time - this.ownerVoicedAt < this.ownerQuietMs;
      const requested = time < this.requestedUntil;
      this.dropping = ownerTalking || (this.holding && !requested);
    }
    this.lastVoiced = time;
    if (this.dropping) return false;
    this.lastPassedVoiced = time;
    return true;
  }
}

export function concatPcm(chunks: readonly Int16Array[]): Int16Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Int16Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i]!, true);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToPcm(base64: string): Int16Array {
  const binary = atob(base64);
  const length = binary.length - (binary.length % 2);
  const pcm = new Int16Array(length / 2);
  for (let i = 0; i < pcm.length; i++) {
    const lo = binary.charCodeAt(i * 2);
    const hi = binary.charCodeAt(i * 2 + 1);
    pcm[i] = (hi << 8) | lo;
  }
  return pcm;
}

// With gapMs, earlier speech separated from the last run by at least gapMs of silence is left out.
export function transcriptWindow(
  fragments: { text: string; startMs: number; endMs: number }[],
  fromMs: number,
  toMs: number,
  gapMs = Infinity,
): string {
  const inWindow = fragments.filter((fragment) => fragment.endMs >= fromMs && fragment.startMs <= toMs);
  let start = inWindow.length - 1;
  while (start > 0 && inWindow[start]!.startMs - inWindow[start - 1]!.endMs < gapMs) start--;
  return inWindow
    .slice(Math.max(start, 0))
    .map((fragment) => fragment.text)
    .join("");
}
