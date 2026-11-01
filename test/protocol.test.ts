import { describe, expect, test } from "bun:test";
import {
  FrameError,
  MAX_FRAME_SAMPLES,
  decodeFrame,
  encodeFrame,
  estimatedUsd,
} from "../shared/protocol.ts";

describe("pcm frame codec", () => {
  test("round-trips header and samples", () => {
    const pcm = Int16Array.from([0, 1, -1, 32767, -32768, 1234]);
    const out = decodeFrame(encodeFrame(7, 4294967295, pcm));
    expect(out.generation).toBe(7);
    expect(out.sequence).toBe(4294967295);
    expect(Array.from(out.pcm)).toEqual(Array.from(pcm));
  });

  test("accepts max payload and empty payload", () => {
    expect(decodeFrame(encodeFrame(1, 1, new Int16Array(MAX_FRAME_SAMPLES))).pcm.length).toBe(2400);
    expect(decodeFrame(encodeFrame(1, 1, new Int16Array(0))).pcm.length).toBe(0);
  });

  test("rejects odd byte lengths", () => {
    expect(() => decodeFrame(new ArrayBuffer(9))).toThrow(FrameError);
    expect(() => decodeFrame(new ArrayBuffer(11))).toThrow(FrameError);
  });

  test("rejects frames shorter than the header", () => {
    expect(() => decodeFrame(new ArrayBuffer(7))).toThrow(FrameError);
  });

  test("rejects payloads over 4800 bytes", () => {
    expect(() => decodeFrame(new ArrayBuffer(8 + 4802))).toThrow(FrameError);
    expect(() => encodeFrame(1, 1, new Int16Array(2401))).toThrow(FrameError);
  });
});

describe("cost", () => {
  test("estimatedUsd is 0.05 at 60000 ms", () => {
    expect(estimatedUsd(60000)).toBeCloseTo(0.05, 10);
    expect(estimatedUsd(0)).toBe(0);
  });
});
