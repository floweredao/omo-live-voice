export const SINC_TAPS = 64;
export const CUTOFF_HZ = 10_800;
export const WIRE_RATE = 24_000;
/** Polyphase table resolution; neighbouring phases are linearly interpolated. */
const PHASES = 256;

/**
 * Blackman-windowed sinc low-pass of `taps` coefficients for a filter running at `rate`.
 * `frac` in [0,1) shifts the kernel by a fractional sample (used for resampling); 0 = integer grid.
 * Tap j weights input sample x[n + j - (taps/2 - 1)] for an output at n + frac. DC gain is 1.
 */
export function designSinc(taps: number, cutoffHz: number, rate: number, frac = 0): Float32Array {
  if (!Number.isInteger(taps) || taps < 2 || taps % 2 !== 0) throw new RangeError(`taps must be an even integer >= 2, got ${taps}`);
  if (!(rate > 0) || !(cutoffHz > 0) || cutoffHz >= rate / 2) throw new RangeError(`cutoff ${cutoffHz} Hz invalid for rate ${rate} Hz`);
  const fc = cutoffHz / rate;
  const half = taps / 2;
  const h = new Float64Array(taps);
  let sum = 0;
  for (let j = 0; j < taps; j++) {
    const t = frac - (j - (half - 1)); // distance from output instant to this input sample
    const x = 2 * fc * t;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const w = 0.42 + 0.5 * Math.cos((2 * Math.PI * t) / taps) + 0.08 * Math.cos((4 * Math.PI * t) / taps);
    h[j] = 2 * fc * sinc * w;
    sum += h[j]!;
  }
  const out = new Float32Array(taps);
  for (let j = 0; j < taps; j++) out[j] = h[j]! / sum;
  return out;
}

/**
 * Streaming fractional-phase band-limited resampler. Filter history and phase persist across
 * `process` calls, so any block split yields the same output stream (delay: taps/2 input samples).
 * Phase is tracked with integer arithmetic (no floating drift between block sizes).
 */
export class Resampler {
  readonly inRate: number;
  readonly outRate: number;
  readonly taps: number;
  private readonly table: Float32Array; // (PHASES + 1) x taps
  private buf: Float32Array;
  private len: number;
  private n: number; // input index (into buf) of the next output instant
  private acc: number; // fractional phase numerator in [0, outRate)

  constructor(inRate: number, outRate: number, taps = SINC_TAPS, cutoffHz = CUTOFF_HZ) {
    if (!Number.isInteger(inRate) || !Number.isInteger(outRate) || inRate <= 0 || outRate <= 0) {
      throw new RangeError(`rates must be positive integers, got ${inRate} -> ${outRate}`);
    }
    this.inRate = inRate;
    this.outRate = outRate;
    this.taps = taps;
    // The kernel runs at the input rate; band-limit below both Nyquists.
    const cutoff = Math.min(cutoffHz, 0.45 * Math.min(inRate, outRate));
    this.table = new Float32Array((PHASES + 1) * taps);
    for (let p = 0; p <= PHASES; p++) this.table.set(designSinc(taps, cutoff, inRate, p / PHASES), p * taps);
    this.buf = new Float32Array(taps * 4);
    this.len = 0;
    this.n = 0;
    this.acc = 0;
    this.reset();
  }

  reset(): void {
    this.buf.fill(0);
    this.len = this.taps / 2 - 1; // zero history before the first input sample
    this.n = this.taps / 2 - 1;
    this.acc = 0;
  }

  process(input: Float32Array): Float32Array {
    const taps = this.taps;
    const half = taps / 2;
    if (this.len + input.length > this.buf.length) {
      const grown = new Float32Array(Math.max(this.buf.length * 2, this.len + input.length + taps));
      grown.set(this.buf.subarray(0, this.len));
      this.buf = grown;
    }
    this.buf.set(input, this.len);
    this.len += input.length;

    // Outputs available: every instant n with n + half < len.
    const maxOut = Math.max(0, Math.ceil(((this.len - half - this.n) * this.outRate - this.acc) / this.inRate) + 1);
    const out = new Float32Array(maxOut);
    let count = 0;
    const buf = this.buf;
    const table = this.table;
    while (this.n + half < this.len) {
      const pos = (this.acc / this.outRate) * PHASES;
      const p0 = Math.floor(pos);
      const a = pos - p0;
      const c0 = p0 * taps;
      const c1 = c0 + taps;
      const base = this.n - (half - 1);
      let y = 0;
      for (let j = 0; j < taps; j++) {
        const c = table[c0 + j]! + a * (table[c1 + j]! - table[c0 + j]!);
        y += buf[base + j]! * c;
      }
      out[count++] = y;
      this.acc += this.inRate;
      const adv = Math.floor(this.acc / this.outRate);
      this.n += adv;
      this.acc -= adv * this.outRate;
    }
    // Keep only the history the next output needs.
    const keepFrom = Math.min(this.n - (half - 1), this.len);
    if (keepFrom > 0) {
      buf.copyWithin(0, keepFrom, this.len);
      this.len -= keepFrom;
      this.n -= keepFrom;
    }
    return count === out.length ? out : out.subarray(0, count);
  }
}

/** Saturating float -> PCM16 (+1 -> 32767, -1 -> -32768). NaN maps to 0. */
export function toPcm16(input: Float32Array, out: Int16Array = new Int16Array(input.length)): Int16Array {
  for (let i = 0; i < input.length; i++) {
    const v = input[i]!;
    const s = v > 1 ? 1 : v < -1 ? -1 : v === v ? v : 0;
    out[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
  }
  return out;
}

export function fromPcm16(input: Int16Array, out: Float32Array = new Float32Array(input.length)): Float32Array {
  for (let i = 0; i < input.length; i++) out[i] = input[i]! / 32768;
  return out;
}

/** Fixed-capacity float FIFO. Never overwrites: `push` returns how many samples were accepted. */
export class RingBuffer {
  readonly capacity: number;
  private readonly data: Float32Array;
  private head = 0;
  private size = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError(`capacity must be a positive integer, got ${capacity}`);
    this.capacity = capacity;
    this.data = new Float32Array(capacity);
  }

  get buffered(): number {
    return this.size;
  }

  push(samples: Float32Array): number {
    const n = Math.min(samples.length, this.capacity - this.size);
    let w = (this.head + this.size) % this.capacity;
    for (let i = 0; i < n; i++) {
      this.data[w] = samples[i]!;
      w = w + 1 === this.capacity ? 0 : w + 1;
    }
    this.size += n;
    return n;
  }

  /** Read up to out.length samples into `out`; returns the count read (rest of `out` untouched). */
  read(out: Float32Array, count = out.length): number {
    const n = Math.min(count, this.size, out.length);
    for (let i = 0; i < n; i++) {
      out[i] = this.data[this.head]!;
      this.head = this.head + 1 === this.capacity ? 0 : this.head + 1;
    }
    this.size -= n;
    return n;
  }

  /** Keep only the next `tail` samples, faded linearly to silence; discard everything after them. */
  flush(tail: number): number {
    const keep = Math.max(0, Math.min(Math.floor(tail), this.size));
    for (let i = 0; i < keep; i++) {
      const idx = (this.head + i) % this.capacity;
      this.data[idx] = this.data[idx]! * (1 - (i + 1) / keep);
    }
    this.size = keep;
    return keep;
  }

  clear(): void {
    this.size = 0;
  }
}
