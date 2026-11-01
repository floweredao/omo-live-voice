import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import type { BridgeToExt, ExtToBridge } from "../../shared/protocol.ts";

const USAGE = `usage: bun fake-ext-host.ts [--env KEY=VALUE]... [--script <file>] [--bridge <main.ts>] [--cwd <dir>] [--session-id <id>] [--no-qa] [--help]

Spawns the bridge (default: bridge/main.ts) with the given env, sends hello, and talks JSONL over its stdio.
stdout line 1 is the bridge's ready JSON. After that: "recv <json>" for every utterance/state/log/exit, "sent <json>" for every forwarded message.
--script lines (offsets in ms from ready):  +500 agent.tool.start bash
                                            +3000 agent.end "text as a JSON string"
                                            +100 {"type":"agent.idle","idle":true}      (raw ExtToBridge JSON)
  kinds: agent.delta "t" | agent.tool.start NAME | agent.tool.end NAME [ok|fail] | agent.turn.end | agent.end "t" | agent.idle true|false
         agent.question.closed ID | confirm on|off | resume | stop
stdin control (one per line): emit <ExtToBridge JSON> | quit`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

function opt(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const env: Record<string, string> = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--env") {
    const kv = args[++i] ?? "";
    const eq = kv.indexOf("=");
    if (eq <= 0) {
      console.error(`bad --env ${kv}`);
      process.exit(2);
    }
    env[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
}
const bridgePath = resolve(opt("--bridge") ?? new URL("../../bridge/main.ts", import.meta.url).pathname);
const scriptPath = opt("--script");

export function parseScriptLine(line: string): { at: number; msg: ExtToBridge } | null {
  const t = line.trim();
  if (!t || t.startsWith("#")) return null;
  const m = /^\+(\d+)\s+(\S+)\s*(.*)$/.exec(t);
  if (!m) throw new Error(`bad script line: ${t}`);
  const at = Number(m[1]);
  const kind = m[2]!;
  const rest = m[3]!.trim();
  if (kind.startsWith("{")) return { at, msg: JSON.parse(`${kind}${rest ? ` ${rest}` : ""}`) as ExtToBridge };
  const str = () => (rest.startsWith('"') ? (JSON.parse(rest) as string) : rest);
  switch (kind) {
    case "agent.delta":
      return { at, msg: { type: "agent.delta", text: str() } };
    case "agent.end":
      return { at, msg: { type: "agent.end", text: str() } };
    case "agent.tool.start":
      return { at, msg: { type: "agent.tool.start", name: str() } };
    case "agent.tool.end": {
      const [name = "", flag = "ok"] = rest.split(/\s+/);
      return { at, msg: { type: "agent.tool.end", name, ok: flag !== "fail" } };
    }
    case "agent.turn.end":
      return { at, msg: { type: "agent.turn.end" } };
    case "agent.idle":
      return { at, msg: { type: "agent.idle", idle: rest !== "false" } };
    case "agent.question.closed":
      return { at, msg: { type: "agent.question.closed", requestId: str() } };
    case "confirm":
      return { at, msg: { type: "confirm", mode: rest === "on" ? "on" : "off" } };
    case "resume":
      return { at, msg: { type: "resume" } };
    case "stop":
      return { at, msg: { type: "stop" } };
    default:
      throw new Error(`unknown script kind: ${kind}`);
  }
}

const script = scriptPath ? (await Bun.file(scriptPath).text()).split("\n").map(parseScriptLine).filter((x): x is NonNullable<typeof x> => x !== null) : [];

const child = Bun.spawn(["bun", bridgePath], {
  env: { ...process.env, ...env },
  stdin: "pipe",
  stdout: "pipe",
  stderr: "inherit",
});

const forward = (msg: ExtToBridge) => {
  const line = JSON.stringify(msg);
  child.stdin.write(`${line}\n`);
  child.stdin.flush();
  console.log(`sent ${line}`);
};

let readySeen = false;
const timers: ReturnType<typeof setTimeout>[] = [];
function onReady() {
  readySeen = true;
  for (const s of script) timers.push(setTimeout(() => forward(s.msg), s.at));
}

(async () => {
  const rl = createInterface({ input: Readable.fromWeb(child.stdout as never) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: BridgeToExt | null = null;
    try {
      msg = JSON.parse(line) as BridgeToExt;
    } catch {
      console.log(`recv-raw ${line}`);
      continue;
    }
    if (msg.type === "ready" && !readySeen) {
      console.log(line);
      onReady();
    } else {
      console.log(`recv ${line}`);
    }
  }
})();

forward({
  type: "hello",
  sessionId: opt("--session-id") ?? "fake-session",
  sessionFile: null,
  cwd: opt("--cwd") ?? process.cwd(),
  title: null,
  qa: !args.includes("--no-qa"),
});

let quitting = false;
async function quit(code: number) {
  if (quitting) return;
  quitting = true;
  for (const t of timers) clearTimeout(t);
  try {
    forward({ type: "stop" });
  } catch {
    child.kill();
  }
  const grace = setTimeout(() => child.kill("SIGKILL"), 2000);
  await child.exited;
  clearTimeout(grace);
  process.exit(code);
}

const stdin = createInterface({ input: process.stdin });
stdin.on("line", (line) => {
  const t = line.trim();
  if (t === "quit") return void quit(0);
  if (t.startsWith("emit ")) {
    try {
      forward(JSON.parse(t.slice(5)) as ExtToBridge);
    } catch (e) {
      console.error(`bad emit: ${e instanceof Error ? e.message : e}`);
    }
  } else if (t) {
    console.error(`unknown control: ${t}`);
  }
});
stdin.on("close", () => void quit(0));

process.on("SIGTERM", () => void quit(0));
process.on("SIGINT", () => void quit(0));
child.exited.then((code) => {
  if (!quitting) {
    console.log(`child-exit ${code}`);
    process.exit(code === 0 ? 0 : 1);
  }
});
