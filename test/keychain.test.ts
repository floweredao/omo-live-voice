import { afterEach, describe, expect, test } from "bun:test";
import { KeyMissingError, readApiKey, redact } from "../bridge/keychain.ts";

const originalKey = process.env.OPENAI_API_KEY;
const originalBin = process.env.OLV_SECURITY_BIN;
afterEach(() => {
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
  if (originalBin === undefined) delete process.env.OLV_SECURITY_BIN;
  else process.env.OLV_SECURITY_BIN = originalBin;
});

describe("readApiKey", () => {
  test("returns explicitly configured environment key", async () => {
    process.env.OPENAI_API_KEY = "sk-test-env";
    const warn = console.warn;
    console.warn = () => {};
    try { expect(await readApiKey()).toBe("sk-test-env"); }
    finally { console.warn = warn; }
  });

  test("loads a key from the security command", async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.OLV_SECURITY_BIN = new URL("./fixtures/fake-security.sh", import.meta.url).pathname;
    expect(await readApiKey()).toBe("sk-fake");
  });

  test("throws KeyMissingError on empty output", async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.OLV_SECURITY_BIN = "/usr/bin/false";
    await expect(readApiKey()).rejects.toBeInstanceOf(KeyMissingError);
  });

  test("redacts API key strings", () => {
    expect(redact({ a: "sk-abc" })).toEqual({ a: "sk-***" });
  });
});
