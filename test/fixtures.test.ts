import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const fixtures = new URL("../fixtures/", import.meta.url);
const speechFiles = [
  "ko-list-files.wav",
  "ko-cancel.wav",
  "ko-answer-2.wav",
  "ko-greeting.wav",
  "ko-backchannel.wav",
];

describe("Korean audio fixtures", () => {
  for (const name of speechFiles) {
    test(`${name} exists and is 24 kHz mono PCM16 WAV`, () => {
      const wav = readFileSync(new URL(name, fixtures));
      expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
      expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
      expect(wav.readUInt16LE(20)).toBe(1);
      expect(wav.readUInt16LE(22)).toBe(1);
      expect(wav.readUInt32LE(24)).toBe(24_000);
      expect(wav.readUInt16LE(34)).toBe(16);
    });
  }
});
