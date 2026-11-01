import { describe, expect, test } from "bun:test";
import { CUTOFF_HZ, RingBuffer, Resampler, SINC_TAPS, designSinc, toPcm16 } from "../panel/dsp.ts";

const tone = (hz: number, rate: number, n: number, amp = 0.5): Float32Array => {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
};

const rms = (x: Float32Array): number => {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / x.length);
};

const db = (ratio: number): number => 20 * Math.log10(ratio);

// Skip the filter warm-up (taps/2 input samples of zero history) before measuring.
const steady = (x: Float32Array): Float32Array => x.subarray(200, x.length - 200);

describe("designSinc", () => {
  test("unit DC gain, even taps required", () => {
    const h = designSinc(SINC_TAPS, CUTOFF_HZ, 48_000);
    expect(h.length).toBe(64);
    expect(Math.abs(h.reduce((a, b) => a + b, 0) - 1)).toBeLessThan(1e-6);
    expect(() => designSinc(63, CUTOFF_HZ, 48_000)).toThrow(RangeError);
    expect(() => designSinc(64, 30_000, 48_000)).toThrow(RangeError);
  });
});

describe("Resampler", () => {
  test("48 kHz -> 24 kHz keeps a 1 kHz tone within 1 dB", () => {
    const out = new Resampler(48_000, 24_000).process(tone(1000, 48_000, 48_000));
    expect(Math.abs(out.length - 24_000)).toBeLessThanOrEqual(32);
    const gain = db(rms(steady(out)) / (0.5 / Math.SQRT2));
    expect(Math.abs(gain)).toBeLessThan(1);
  });

  test("48 kHz -> 24 kHz attenuates a 15 kHz tone by >= 40 dB", () => {
    const out = new Resampler(48_000, 24_000).process(tone(15_000, 48_000, 48_000));
    const attenuation = -db(rms(steady(out)) / (0.5 / Math.SQRT2));
    expect(attenuation).toBeGreaterThanOrEqual(40);
  });

  test("128-sample blocks equal one block (max abs diff < 1e-4)", () => {
    for (const [inRate, outRate] of [
      [48_000, 24_000],
      [44_100, 24_000],
      [24_000, 48_000],
    ] as const) {
      const input = new Float32Array(inRate / 2);
      for (let i = 0; i < input.length; i++) input[i] = 0.4 * Math.sin(i * 0.07) + 0.3 * Math.sin(i * 1.3) * Math.cos(i * 0.011);
      const whole = new Resampler(inRate, outRate).process(input);
      const blocked = new Resampler(inRate, outRate);
      const parts: number[] = [];
      for (let i = 0; i < input.length; i += 128) parts.push(...blocked.process(input.subarray(i, i + 128)));
      expect(parts.length).toBe(whole.length);
      let maxDiff = 0;
      for (let i = 0; i < whole.length; i++) maxDiff = Math.max(maxDiff, Math.abs(parts[i]! - whole[i]!));
      expect(maxDiff).toBeLessThan(1e-4);
    }
  });

  test("non-48 kHz context rates: 44.1 kHz capture and 24 kHz -> 44.1 kHz playback keep 1 kHz within 1 dB", () => {
    const down = new Resampler(44_100, 24_000).process(tone(1000, 44_100, 44_100));
    expect(Math.abs(down.length - 24_000)).toBeLessThanOrEqual(32);
    expect(Math.abs(db(rms(steady(down)) / (0.5 / Math.SQRT2)))).toBeLessThan(1);
    const up = new Resampler(24_000, 44_100).process(tone(1000, 24_000, 24_000));
    expect(Math.abs(up.length - 44_100)).toBeLessThanOrEqual(64);
    expect(Math.abs(db(rms(steady(up)) / (0.5 / Math.SQRT2)))).toBeLessThan(1);
  });

  test("reset drops history: output after reset matches a fresh resampler", () => {
    const a = new Resampler(48_000, 24_000);
    a.process(tone(3000, 48_000, 1000));
    a.reset();
    const after = a.process(tone(500, 48_000, 960));
    const fresh = new Resampler(48_000, 24_000).process(tone(500, 48_000, 960));
    expect(Array.from(after)).toEqual(Array.from(fresh));
  });
});

describe("toPcm16", () => {
  test("saturates +-1.2 to 32767 / -32768 and maps NaN to 0", () => {
    const out = toPcm16(new Float32Array([1.2, -1.2, 1, -1, 0, Number.NaN, 0.5]));
    expect(Array.from(out)).toEqual([32767, -32768, 32767, -32768, 0, 0, 16384]);
  });
});

describe("RingBuffer", () => {
  test("flush keeps exactly 240 samples (10 ms at 24 kHz), fades them, then buffered is 0", () => {
    const ring = new RingBuffer(24_000);
    expect(ring.push(new Float32Array(2400).fill(0.5))).toBe(2400);
    expect(ring.flush(240)).toBe(240);
    expect(ring.buffered).toBe(240);
    const out = new Float32Array(1000);
    expect(ring.read(out)).toBe(240);
    expect(ring.buffered).toBe(0);
    expect(out[0]!).toBeGreaterThan(0.49);
    expect(out[239]!).toBe(0);
    for (let i = 1; i < 240; i++) expect(out[i]!).toBeLessThanOrEqual(out[i - 1]!);
  });

  test("never overwrites: push beyond capacity is truncated and wraps correctly", () => {
    const ring = new RingBuffer(10);
    expect(ring.push(new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBe(8);
    const out = new Float32Array(6);
    expect(ring.read(out)).toBe(6);
    expect(ring.push(new Float32Array([9, 10, 11, 12, 13, 14, 15, 16, 17]))).toBe(8);
    const rest = new Float32Array(20);
    expect(ring.read(rest)).toBe(10);
    expect(Array.from(rest.subarray(0, 10))).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  });
});
