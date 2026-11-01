import { describe, expect, test } from "bun:test";
import type { ExtToBridge } from "../shared/protocol.ts";
import { createLineParser, readExt, sendExt } from "../bridge/ext-link.ts";

function collect() {
  const msgs: ExtToBridge[] = [];
  const logs: string[] = [];
  const parser = createLineParser((m) => msgs.push(m), (l) => logs.push(l));
  return { msgs, logs, parser };
}

async function* chunks(...parts: (string | Uint8Array)[]) {
  for (const p of parts) yield p;
}

describe("ext-link JSONL", () => {
  test("one message per newline-terminated line", () => {
    const { msgs, parser } = collect();
    parser.push('{"type":"stop"}\n{"type":"resume"}\n');
    expect(msgs.map((m) => m.type)).toEqual(["stop", "resume"]);
  });

  test("partial lines are buffered until the newline arrives", () => {
    const { msgs, parser } = collect();
    parser.push('{"type":"agent.de');
    expect(msgs).toHaveLength(0);
    parser.push('lta","text":"안');
    parser.push('녕"}\n{"type":');
    expect(msgs).toEqual([{ type: "agent.delta", text: "안녕" }]);
    parser.push('"stop"}\n');
    expect(msgs.map((m) => m.type)).toEqual(["agent.delta", "stop"]);
  });

  test("a multi-byte character split across byte chunks decodes intact", () => {
    const { msgs, parser } = collect();
    const bytes = new TextEncoder().encode('{"type":"agent.delta","text":"파일"}\n');
    const cut = bytes.indexOf(0xed) + 1; // inside the first Hangul code point
    parser.push(bytes.subarray(0, cut));
    parser.push(bytes.subarray(cut));
    expect(msgs).toEqual([{ type: "agent.delta", text: "파일" }]);
  });

  test("invalid JSON and typeless objects are logged and skipped, not thrown", () => {
    const { msgs, logs, parser } = collect();
    expect(() => parser.push('not json\n{"no":"type"}\n[1,2]\n\n{"type":"stop"}\n')).not.toThrow();
    expect(msgs.map((m) => m.type)).toEqual(["stop"]);
    expect(logs.filter((l) => l.includes("bad_json"))).toHaveLength(1);
    expect(logs.filter((l) => l.includes("bad_message"))).toHaveLength(2);
  });

  test("a trailing line without a newline is delivered at end of input", async () => {
    const msgs: ExtToBridge[] = [];
    await readExt((m) => msgs.push(m), { input: chunks('{"type":"resume"}\n{"type":"st', 'op"}'), log: () => {} });
    expect(msgs.map((m) => m.type)).toEqual(["resume", "stop"]);
  });

  test("a throwing handler is logged and the stream keeps going", async () => {
    const logs: string[] = [];
    const seen: string[] = [];
    await readExt(
      (m) => {
        seen.push(m.type);
        if (m.type === "resume") throw new Error("boom");
      },
      { input: chunks('{"type":"resume"}\n{"type":"stop"}\n'), log: (l) => logs.push(l) },
    );
    expect(seen).toEqual(["resume", "stop"]);
    expect(logs.some((l) => l.includes("handler_error"))).toBe(true);
  });

  test("sendExt writes exactly one JSON line per message", () => {
    const out: string[] = [];
    sendExt({ type: "ready", port: 1, token: "t", panelUrl: "http://127.0.0.1:1/?token=t" }, (l) => out.push(l));
    sendExt({ type: "exit", reason: "stop" }, (l) => out.push(l));
    expect(out).toHaveLength(2);
    for (const line of out) expect(line.endsWith("\n") && line.indexOf("\n") === line.length - 1).toBe(true);
    expect(JSON.parse(out[0]!)).toEqual({ type: "ready", port: 1, token: "t", panelUrl: "http://127.0.0.1:1/?token=t" });
  });
});
