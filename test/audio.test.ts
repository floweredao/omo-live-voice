import { describe, expect, test } from "bun:test";
import {
  base64ToPcm,
  concatPcm,
  InputPacer,
  isVoiced,
  LIVE_BYTES_PER_MS,
  LIVE_RATE,
  pcmToBase64,
  transcriptWindow,
  TurnGate,
  VoiceActivity,
} from "../bridge/audio.ts";

function tone(freq: number, durationMs: number, amplitude: number): Int16Array {
  const samples = new Int16Array((LIVE_RATE * durationMs) / 1000);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / LIVE_RATE) * amplitude * 32767);
  }
  return samples;
}

function pcmBytes(samples: number, value: number): Uint8Array {
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples; i++) view.setInt16(i * 2, value, true);
  return bytes;
}

describe("audio core", () => {
  test("pacer returns a 100 ms frame padded with silence", () => {
    const pacer = new InputPacer();
    pacer.push(new Uint8Array([1, 2, 3, 4]));
    const frame = pacer.take();
    expect(frame.length).toBe(4800);
    expect([...frame.slice(0, 6)]).toEqual([1, 2, 3, 4, 0, 0]);
  });

  test("pacer drops oldest bytes beyond 600 ms", () => {
    const pacer = new InputPacer();
    pacer.push(pcmBytes(14_400, 1));
    pacer.push(pcmBytes(2_400, 2));
    expect(pacer.bufferedBytes).toBe(600 * LIVE_BYTES_PER_MS);
    const newest = pacer.take(600);
    expect(newest.length).toBe(600 * LIVE_BYTES_PER_MS);
    expect(new DataView(newest.buffer).getInt16(0, true)).toBe(1);
    expect(new DataView(newest.buffer).getInt16(newest.length - 2, true)).toBe(2);
  });

  test("RMS recognizes a 440 Hz tone at -20 dBFS and rejects silence", () => {
    expect(isVoiced(tone(440, 100, 0.1))).toBe(true);
    expect(isVoiced(new Int16Array(2400))).toBe(false);
  });

  test("voice activity interrupts after 200 ms only while output is speaking", () => {
    const voicedFrame = tone(440, 100, 0.3);
    let now = 0;
    const activity = new VoiceActivity(500, 300, () => now);
    expect(activity.classify(voicedFrame, true)).toBe(null);
    now = 100;
    expect(activity.classify(voicedFrame, true)).toBe("interrupt");
  });

  test("voice activity starts speech at 400 ms, but not 100 ms", () => {
    const voicedFrame = tone(440, 100, 0.3);
    let now = 0;
    const activity = new VoiceActivity(500, 300, () => now);
    expect(activity.classify(voicedFrame, false)).toBe(null);
    for (now = 100; now < 300; now += 100) {
      expect(activity.classify(voicedFrame, false)).toBe(null);
    }
    expect(activity.classify(voicedFrame, false)).toBe("speech.start");
  });

  test("voice activity resets a burst after 300 ms of release", () => {
    let now = 0;
    const activity = new VoiceActivity(500, 300, () => now);
    const voicedFrame = tone(440, 100, 0.3);
    expect(activity.push(voicedFrame)).toBe(100);
    now = 401;
    expect(activity.push(voicedFrame)).toBe(100);
  });

  test("transcript window selects overlapping fragments and preserves spaces", () => {
    const fragments = [
      { text: "before ", startMs: 0, endMs: 99 },
      { text: "hello ", startMs: 100, endMs: 199 },
      { text: "world", startMs: 200, endMs: 300 },
      { text: " after", startMs: 301, endMs: 400 },
    ];
    expect(transcriptWindow(fragments, 150, 250)).toBe("hello world");
  });

  test("PCM helpers concatenate and round-trip little-endian samples", () => {
    const samples = concatPcm([new Int16Array([1, -2]), new Int16Array([32767])]);
    expect(base64ToPcm(pcmToBase64(samples))).toEqual(samples);
  });

  test("turn gate stops the current utterance after barge-in", () => {
    let now = 0;
    const gate = new TurnGate(600, 200, 600, () => now, 1500);
    expect(gate.pass(true)).toBe(true);
    now = 100;
    gate.bargeIn();
    expect(gate.pass(true)).toBe(false);
    now = 1600;
    expect(gate.pass(true)).toBe(true);
  });
});
