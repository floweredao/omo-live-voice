import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import voiceExtension from "../extension/index.ts";

const FAKE_BRIDGE = join(import.meta.dir, "fixtures/fake-bridge.sh");
const EXTENSION_URL = pathToFileURL(join(import.meta.dir, "../extension/index.ts")).href;
const ENV_KEYS = ["OLV_BUN", "OLV_DATA_DIR", "OLV_OPEN_CMD", "OLV_STOP_TIMEOUT_MS", "OLV_QA", "FAKE_BRIDGE_LOG", "FAKE_BRIDGE_SCRIPT", "FAKE_BRIDGE_IGNORE_STOP"];

let listeners = new Set<() => void>();
const tick = () => {
  for (const l of [...listeners]) l();
};

function waitFor(pred: () => boolean, ms: number, label: string): Promise<void> {
  if (pred()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (!pred()) return;
      listeners.delete(check);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      listeners.delete(check);
      reject(new Error(`timed out after ${ms} ms: ${label}`));
    }, ms);
    listeners.add(check);
  });
}

type Handler = (event: any, ctx: any) => unknown;

class FakePi {
  commands = new Map<string, { description?: string; handler: (args: string, ctx: any) => Promise<void>; getArgumentCompletions?: (p: string) => unknown }>();
  tools = new Map<string, { execute: (...a: any[]) => Promise<any> }>();
  handlers = new Map<string, Handler[]>();
  bus = new Map<string, ((data: unknown) => void)[]>();
  userMessages: { text: string; options: unknown }[] = [];
  customMessages: unknown[] = [];
  events = {
    on: (channel: string, h: (data: unknown) => void) => {
      this.bus.set(channel, [...(this.bus.get(channel) ?? []), h]);
      return () => {};
    },
    emit: (channel: string, data: unknown) => {
      for (const h of this.bus.get(channel) ?? []) h(data);
    },
  };
  registerCommand(name: string, options: any) {
    this.commands.set(name, options);
  }
  registerTool(tool: any) {
    this.tools.set(tool.name, tool);
  }
  on(event: string, h: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), h]);
    return () => {};
  }
  sendUserMessage(text: string, options?: unknown) {
    this.userMessages.push({ text, options });
    tick();
  }
  sendMessage(message: unknown) {
    this.customMessages.push(message);
    tick();
  }
  async fire(event: string, payload: any, ctx: FakeCtx) {
    for (const h of this.handlers.get(event) ?? []) await h(payload, ctx);
  }
  run(args: string, ctx: FakeCtx) {
    return this.commands.get("voice")!.handler(args, ctx);
  }
}

class FakeCtx {
  notifies: { msg: string; type?: string }[] = [];
  statuses: { key: string; text: string | undefined }[] = [];
  abortCount = 0;
  idle = true;
  cwd: string;
  sessionManager: { getSessionFile: () => string | undefined; getSessionName: () => string | undefined };
  ui = {
    notify: (msg: string, type?: string) => {
      this.notifies.push({ msg, type });
      tick();
    },
    setStatus: (key: string, text: string | undefined) => {
      this.statuses.push({ key, text });
      tick();
    },
  };
  constructor(sessionFile: string, cwd: string) {
    this.cwd = cwd;
    this.sessionManager = { getSessionFile: () => sessionFile, getSessionName: () => undefined };
  }
  isIdle() {
    return this.idle;
  }
  abort() {
    this.abortCount++;
    tick();
  }
}

let dir = "";
let watcher: FSWatcher | null = null;
let live: { pi: FakePi; ctx: FakeCtx }[] = [];

const fakeLog = () => (existsSync(join(dir, "fake.log")) ? readFileSync(join(dir, "fake.log"), "utf8") : "");
const spawnCount = () => fakeLog().split("\n").filter((l) => l.startsWith("spawned ")).length;
const lockFile = () => join(dir, "data", "active.json");
const readLock = () => JSON.parse(readFileSync(lockFile(), "utf8")) as { sessionId: string; pid: number; startedAt: string };
const extLog = () => {
  const logs = join(dir, "data", "logs");
  if (!existsSync(logs)) return "";
  return readdirSync(logs)
    .map((f) => readFileSync(join(logs, f), "utf8"))
    .join("");
};
const received = (frag: string) => fakeLog().includes(`recv ${frag}`);
const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function setup(sessionFile = "/sessions/s-one.jsonl") {
  const pi = new FakePi();
  voiceExtension(pi as unknown as ExtensionAPI);
  const ctx = new FakeCtx(sessionFile, dir);
  live.push({ pi, ctx });
  return { pi, ctx };
}

function runQaChild(mode: "with-flag" | "without-flag" | "registration-only"): string {
  const home = join(dir, `home-${mode}`);
  mkdirSync(join(home, ".omo-live-voice"), { recursive: true });
  if (mode === "with-flag") writeFileSync(join(home, ".omo-live-voice", "qa-mode"), "");
  const homeBoot = join(dir, `home-boot-${mode}.cjs`);
  writeFileSync(homeBoot, `
    const os = require("node:os");
    const fs = require("node:fs");
    const original = os.homedir;
    os.homedir = () => ${JSON.stringify(home)};
    const existsSync = fs.existsSync;
    globalThis.__qaFlagChecks = 0;
    fs.existsSync = (path, ...args) => {
      if (String(path) === ${JSON.stringify(join(home, ".omo-live-voice", "qa-mode"))}) globalThis.__qaFlagChecks++;
      return existsSync(path, ...args);
    };
    process.on("exit", () => { os.homedir = original; });
  `);
  const script = `
    import voiceExtension from ${JSON.stringify(EXTENSION_URL)};
    const pi = {
      registerCommand(_name, command) { this.command = command; },
      registerTool() {},
      on() {},
      events: { on() {} },
      sendMessage() {},
      sendUserMessage() {},
    };
    voiceExtension(pi);
    if (${JSON.stringify(mode)} === "registration-only") {
      process.stdout.write(JSON.stringify({ registered: true, flagChecks: globalThis.__qaFlagChecks }));
    } else {
      process.env.OLV_BUN = ${JSON.stringify(FAKE_BRIDGE)};
      process.env.OLV_DATA_DIR = ${JSON.stringify(join(dir, `data-${mode}`))};
      process.env.FAKE_BRIDGE_LOG = ${JSON.stringify(join(dir, `fake-${mode}.log`))};
      process.env.FAKE_BRIDGE_SCRIPT = ${JSON.stringify(join(dir, "script.jsonl"))};
      delete process.env.OLV_QA;
      const logPath = ${JSON.stringify(join(dir, `fake-${mode}.log`))};
      const fs = await import("node:fs");
      const receivedHello = new Promise((resolve, reject) => {
        const watcher = fs.watch(${JSON.stringify(dir)}, (_event, name) => {
          if (String(name) !== logPath.split("/").pop() || !fs.existsSync(logPath)) return;
          const log = fs.readFileSync(logPath, "utf8");
          if (!log.includes("recv ")) return;
          watcher.close();
          resolve(log);
        });
        setTimeout(() => {
          watcher.close();
          reject(new Error("fake bridge did not receive hello"));
        }, 5000);
      });
      await pi.command.handler("", {
        cwd: ${JSON.stringify(dir)},
        sessionManager: { getSessionFile: () => "/sessions/qa-child.jsonl", getSessionName: () => undefined },
        ui: { notify() {}, setStatus() {} },
        isIdle: () => true,
      });
      process.stdout.write(await receivedHello);
      process.exit(0);
    }
  `;
  const result = spawnSync(process.execPath, ["--require", homeBoot, "-e", script], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  if (result.status !== 0) throw new Error(result.stderr || `QA child exited ${result.status}`);
  return result.stdout;
}

function script(...lines: object[]) {
  writeFileSync(join(dir, "script.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

async function startVoice(pi: FakePi, ctx: FakeCtx) {
  await pi.run("", ctx);
  await waitFor(() => existsSync(lockFile()) && extLog().includes("ready port=1"), 5000, "bridge ready");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "olv-ext-test-"));
  mkdirSync(join(dir, "home", ".omo-live-voice"), { recursive: true });
  mkdirSync(join(dir, "data"), { recursive: true });
  listeners = new Set();
  watcher = watch(dir, { recursive: true }, tick);
  process.env.OLV_BUN = FAKE_BRIDGE;
  process.env.OLV_DATA_DIR = join(dir, "data");
  process.env.OLV_OPEN_CMD = "/usr/bin/true";
  process.env.FAKE_BRIDGE_LOG = join(dir, "fake.log");
  process.env.FAKE_BRIDGE_SCRIPT = join(dir, "script.jsonl");
  delete process.env.FAKE_BRIDGE_IGNORE_STOP;
  delete process.env.OLV_STOP_TIMEOUT_MS;
});

afterEach(async () => {
  process.env.OLV_STOP_TIMEOUT_MS = "500";
  for (const { pi, ctx } of live) await pi.run("stop", ctx);
  live = [];
  watcher?.close();
  for (const k of ENV_KEYS) delete process.env[k];
  rmSync(dir, { recursive: true, force: true });
});

describe("registration", () => {
  test("registers exactly the voice command and the voice_start tool and spawns nothing", () => {
    const { pi } = setup();
    expect([...pi.commands.keys()]).toEqual(["voice"]);
    expect([...pi.tools.keys()]).toEqual(["voice_start"]);
    expect(pi.commands.get("voice")!.description).toContain("음성");
    expect(pi.userMessages.length + pi.customMessages.length).toBe(0);
    expect(existsSync(join(dir, "fake.log"))).toBe(false);
    expect(readdirSync(join(dir, "data"))).toEqual([]);
    expect(existsSync(join(dir, "home", ".omo-live-voice", "qa-mode"))).toBe(false);
  });

  test("argument completions offer the subcommands", () => {
    const { pi } = setup();
    const items = pi.commands.get("voice")!.getArgumentCompletions!("con") as { value: string }[];
    expect(items.map((i) => i.value)).toEqual(["confirm on", "confirm off"]);
  });
});

describe("/voice lifecycle", () => {
  test("/voice hello enables QA from the HOME file flag", async () => {
    writeFileSync(join(dir, "home", ".omo-live-voice", "qa-mode"), "");
    const output = runQaChild("with-flag");
    expect(output).toContain('"qa":true');
  });

  test("/voice hello keeps QA disabled without env or file flag", async () => {
    const output = runQaChild("without-flag");
    expect(output).toContain('"qa":false');
  });

  test("registration does not inspect the QA flag", () => {
    const output = runQaChild("registration-only");
    expect(JSON.parse(output)).toEqual({ registered: true, flagChecks: 0 });
    expect(existsSync(join(dir, "fake.log"))).toBe(false);
  });

  test("/voice spawns the bridge, writes the lock, sends hello and sets status", async () => {
    const { pi, ctx } = setup();
    await startVoice(pi, ctx);
    expect(spawnCount()).toBe(1);
    const lock = readLock();
    expect(lock.sessionId).toBe("s-one");
    expect(pidAlive(lock.pid)).toBe(true);
    expect(received('{"type":"hello","sessionId":"s-one","sessionFile":"/sessions/s-one.jsonl"')).toBe(true);
    expect(ctx.statuses.some((s) => s.key === "voice" && s.text?.includes("음성 연결 중"))).toBe(true);
  });

  test("utterance message -> sendUserMessage with steer while busy and while idle", async () => {
    script({ type: "utterance", id: "u1", text: "테스트 해 줘", kind: "message" });
    const busy = setup();
    busy.ctx.idle = false;
    await startVoice(busy.pi, busy.ctx);
    await waitFor(() => busy.pi.userMessages.length === 1, 5000, "busy sendUserMessage");
    expect(busy.pi.userMessages[0]).toEqual({ text: "테스트 해 줘", options: { deliverAs: "steer" } });
    await busy.pi.run("stop", busy.ctx);

    const idle = setup("/sessions/s-two.jsonl");
    await startVoice(idle.pi, idle.ctx);
    await waitFor(() => idle.pi.userMessages.length === 1, 5000, "idle sendUserMessage");
    expect(idle.pi.userMessages[0]).toEqual({ text: "테스트 해 줘", options: { deliverAs: "steer" } });
  });

  test("two utterances before the first run starts both reach the session (#9)", async () => {
    script(
      { type: "utterance", id: "u1", text: "현재 폴더 파일 목록 보여 줘", kind: "message" },
      { type: "utterance", id: "u2", text: "테스트도 돌려 줘", kind: "message" },
    );
    // Given: isIdle() stays true until the first run starts streaming.
    const { pi, ctx } = setup();
    // The runtime rejects a message without deliverAs while an earlier prompt is still starting.
    const accepted: string[] = [];
    pi.sendUserMessage = (text: string, options?: unknown) => {
      const queued = (options as { deliverAs?: string } | undefined)?.deliverAs !== undefined;
      if (accepted.length === 0 || queued) accepted.push(text);
      pi.userMessages.push({ text, options });
      tick();
    };
    await startVoice(pi, ctx);
    await waitFor(() => pi.userMessages.length === 2, 5000, "both utterances sent");
    expect(accepted).toEqual(["현재 폴더 파일 목록 보여 줘", "테스트도 돌려 줘"]);
  });

  test("utterance cancel -> abort once when busy, never when idle", async () => {
    script({ type: "utterance", id: "c1", text: "그만", kind: "cancel" });
    const busy = setup();
    busy.ctx.idle = false;
    await startVoice(busy.pi, busy.ctx);
    await waitFor(() => busy.ctx.abortCount > 0, 5000, "abort");
    expect(busy.ctx.abortCount).toBe(1);
    await busy.pi.run("stop", busy.ctx);

    const idle = setup("/sessions/s-two.jsonl");
    await startVoice(idle.pi, idle.ctx);
    await waitFor(() => (extLog().match(/utterance_received c1 /g) ?? []).length === 2, 5000, "second cancel received");
    expect(idle.ctx.abortCount).toBe(0);
  });

  test("utterance answer -> notify to pick on screen (no answer API)", async () => {
    script({ type: "utterance", id: "a1", text: "첫 번째", kind: "answer", requestId: "r1", optionIndex: 0 });
    const { pi, ctx } = setup();
    await startVoice(pi, ctx);
    await waitFor(() => ctx.notifies.some((n) => n.msg === "질문은 화면에서 선택해 주세요"), 5000, "answer notify");
    expect(pi.userMessages.length).toBe(0);
  });

  test("/voice from a different session while the lock is held is refused", async () => {
    const a = setup();
    await startVoice(a.pi, a.ctx);
    const b = setup("/sessions/s-other.jsonl");
    await b.pi.run("", b.ctx);
    expect(b.ctx.notifies.some((n) => n.msg.includes("이미 다른 세션") && n.type === "warning")).toBe(true);
    expect(spawnCount()).toBe(1);
  });

  test("/voice again in the same session resumes instead of spawning", async () => {
    const { pi, ctx } = setup();
    await startVoice(pi, ctx);
    await pi.run("", ctx);
    await waitFor(() => received('{"type":"resume"}'), 5000, "resume received");
    expect(spawnCount()).toBe(1);
    expect(ctx.notifies.some((n) => n.msg === "음성 재개")).toBe(true);
  });

  test("/voice stop -> bridge exits, lock removed, status cleared", async () => {
    const { pi, ctx } = setup();
    await startVoice(pi, ctx);
    const { pid } = readLock();
    await pi.run("stop", ctx);
    expect(received('{"type":"stop"}')).toBe(true);
    expect(fakeLog()).toContain("exit stop");
    expect(pidAlive(pid)).toBe(false);
    expect(existsSync(lockFile())).toBe(false);
    expect(ctx.statuses.at(-1)).toEqual({ key: "voice", text: "" });
    expect(ctx.notifies.some((n) => n.msg === "음성 종료")).toBe(true);
  });

  test("/voice stop falls back to SIGTERM when the bridge ignores stop", async () => {
    process.env.FAKE_BRIDGE_IGNORE_STOP = "1";
    process.env.OLV_STOP_TIMEOUT_MS = "300";
    const { pi, ctx } = setup();
    await startVoice(pi, ctx);
    const { pid } = readLock();
    await pi.run("stop", ctx);
    await waitFor(() => !pidAlive(pid), 3000, "bridge killed");
    expect(existsSync(lockFile())).toBe(false);
    expect(extLog()).toContain("stop_timeout sigterm");
  });

  test("a stale lock naming a dead pid is reclaimed", async () => {
    const dead = spawn("/usr/bin/true");
    await new Promise((r) => dead.on("exit", r));
    writeFileSync(lockFile(), JSON.stringify({ sessionId: "s-gone", pid: dead.pid, startedAt: "2026-01-01T00:00:00Z" }));
    const { pi, ctx } = setup();
    await startVoice(pi, ctx);
    expect(spawnCount()).toBe(1);
    expect(readLock().sessionId).toBe("s-one");
  });

  test("a lock naming another live pid and session blocks the spawn", async () => {
    writeFileSync(lockFile(), JSON.stringify({ sessionId: "s-elsewhere", pid: process.pid, startedAt: "2026-01-01T00:00:00Z", title: "다른 스레드" }));
    const { pi, ctx } = setup();
    await pi.run("", ctx);
    expect(ctx.notifies.at(-1)).toEqual({ msg: "이미 다른 세션(다른 스레드)에 연결됨. 그곳에서 /voice stop 실행", type: "warning" });
    expect(spawnCount()).toBe(0);
    expect(readLock().sessionId).toBe("s-elsewhere");
  });

  test("unknown arguments show usage; confirm on is forwarded", async () => {
    const { pi, ctx } = setup();
    await pi.run("bogus $(touch /tmp/olv-ext-pwn)", ctx);
    expect(ctx.notifies.at(-1)?.msg).toContain("사용법");
    expect(spawnCount()).toBe(0);
    expect(existsSync("/tmp/olv-ext-pwn")).toBe(false);
    await startVoice(pi, ctx);
    await pi.run("confirm on", ctx);
    await waitFor(() => received('{"type":"confirm","mode":"on"}'), 5000, "confirm received");
  });

  test("voice_start tool runs the same start path", async () => {
    const { pi, ctx } = setup();
    const result = await pi.tools.get("voice_start")!.execute("call-1", {}, undefined, undefined, ctx);
    expect(result.content[0].text).toBe("voice_start: started");
    await waitFor(() => existsSync(lockFile()) && spawnCount() === 1, 5000, "tool spawn");
    const again = await pi.tools.get("voice_start")!.execute("call-2", {}, undefined, undefined, ctx);
    expect(again.content[0].text).toBe("voice_start: resumed");
    expect(spawnCount()).toBe(1);
  });

  test("session_shutdown stops the bridge and removes the lock", async () => {
    const { pi, ctx } = setup();
    await startVoice(pi, ctx);
    const { pid } = readLock();
    await pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit", signal: new AbortController().signal }, ctx);
    expect(pidAlive(pid)).toBe(false);
    expect(existsSync(lockFile())).toBe(false);
  });
});

function exitingBridge(reason: string): string {
  const path = join(dir, `exit-${reason}.sh`);
  writeFileSync(
    path,
    `#!/bin/bash\nread -r line\nprintf '%s\\n' '{"type":"ready","port":1,"token":"t","panelUrl":"http://127.0.0.1:1/"}'\nprintf '%s\\n' '{"type":"exit","reason":"${reason}"}'\nexit 0\n`,
    { mode: 0o755 },
  );
  return path;
}

describe("polish", () => {
  test("state frames map to the five Korean status texts", async () => {
    const st = (o: object) => ({ type: "state", connection: "open", input: "quiet", agent: "idle", output: "idle", muted: false, ...o });
    script(
      st({}),
      st({ output: "speaking" }),
      st({ agent: "running" }),
      st({ connection: "closed" }),
      st({ muted: true }),
    );
    const { pi, ctx } = setup();
    await startVoice(pi, ctx);
    await waitFor(() => ctx.statuses.some((s) => s.text === "🔇 무음"), 5000, "mute status");
    const texts = ctx.statuses.map((s) => s.text);
    for (const t of ["🎙 듣는 중", "🔊 말하는 중", "🤖 에이전트 작업 중", "⏸ 일시정지", "🔇 무음"]) expect(texts).toContain(t);
  });

  test("bridge exit cedar_rejected notifies a cedar message and removes the lock", async () => {
    process.env.OLV_BUN = exitingBridge("cedar_rejected");
    const { pi, ctx } = setup();
    await pi.run("", ctx);
    await waitFor(() => ctx.notifies.some((n) => n.msg.includes("cedar")), 5000, "cedar notify");
    await waitFor(() => !existsSync(lockFile()) && ctx.statuses.at(-1)?.text === "", 5000, "lock removed");
    const n = ctx.notifies.find((x) => x.msg.includes("cedar"))!;
    expect(n).toEqual({ msg: "GPT-Live가 cedar 보이스를 거절했어요. 관리자에게 알려 주세요.", type: "error" });
  });

  test("bridge exit reasons key_missing, budget, cap, idle each get a Korean notice", async () => {
    const expected: Record<string, string> = {
      key_missing: "Keychain에 키가 없어요: scripts/set-key.sh",
      budget: "예산",
      cap: "한도",
      idle: "조용",
    };
    for (const [reason, frag] of Object.entries(expected)) {
      process.env.OLV_BUN = exitingBridge(reason);
      const { pi, ctx } = setup(`/sessions/s-${reason}.jsonl`);
      await pi.run("", ctx);
      await waitFor(() => ctx.notifies.some((n) => n.msg.includes(frag)), 5000, `${reason} notify`);
      await waitFor(() => !existsSync(lockFile()), 5000, `${reason} lock removed`);
    }
  });

  test("utterance answer never calls sendUserMessage, sendMessage or abort", async () => {
    script(
      { type: "utterance", id: "a1", text: "두 번째", kind: "answer", requestId: "r1", optionIndex: 1 },
      { type: "utterance", id: "a2", text: "네", kind: "answer", requestId: "r1" },
    );
    const { pi, ctx } = setup();
    ctx.idle = false;
    await startVoice(pi, ctx);
    await waitFor(() => (extLog().match(/utterance_received a[12] /g) ?? []).length === 2, 5000, "both answers received");
    expect(pi.userMessages.length).toBe(0);
    expect(pi.customMessages.length).toBe(0);
    expect(ctx.abortCount).toBe(0);
  });

  test("refusal names the bound session title when it is the live child", async () => {
    const a = setup();
    a.ctx.sessionManager.getSessionName = () => "내 작업";
    await startVoice(a.pi, a.ctx);
    // hide the lock so the in-process child is the owner that is reported
    const b = setup("/sessions/s-other.jsonl");
    await b.pi.run("", b.ctx);
    expect(b.ctx.notifies.at(-1)?.msg).toContain("내 작업");
  });

  test("session_shutdown resolves within 2000 ms when the bridge ignores stop", async () => {
    process.env.FAKE_BRIDGE_IGNORE_STOP = "1";
    const { pi, ctx } = setup();
    await startVoice(pi, ctx);
    const { pid } = readLock();
    const t0 = performance.now();
    await pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit", signal: new AbortController().signal }, ctx);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(existsSync(lockFile())).toBe(false);
    await waitFor(() => !pidAlive(pid), 3000, "bridge terminated");
  });

  test("session_shutdown with an already-aborted signal does not wait", async () => {
    process.env.FAKE_BRIDGE_IGNORE_STOP = "1";
    const { pi, ctx } = setup();
    await startVoice(pi, ctx);
    const { pid } = readLock();
    const ac = new AbortController();
    ac.abort();
    const t0 = performance.now();
    await pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit", signal: ac.signal }, ctx);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(existsSync(lockFile())).toBe(false);
    await waitFor(() => !pidAlive(pid), 3000, "bridge terminated");
  });
});

describe("event taps", () => {
  test("taps are inert while no bridge runs", async () => {
    const { pi, ctx } = setup();
    await pi.fire("agent_end", { messages: [{ role: "assistant", content: "x" }] }, ctx);
    expect(existsSync(join(dir, "fake.log"))).toBe(false);
  });

  test("agent_end forwards agent.end with the final assistant text", async () => {
    const { pi, ctx } = setup();
    await startVoice(pi, ctx);
    await pi.fire("agent_start", { type: "agent_start" }, ctx);
    await pi.fire("message_update", { assistantMessageEvent: { type: "text_delta", delta: "중간" } }, ctx);
    await pi.fire("tool_execution_start", { toolName: "bash" }, ctx);
    await pi.fire("tool_execution_end", { toolName: "bash", isError: true }, ctx);
    await pi.fire("turn_end", {}, ctx);
    await pi.fire("agent_end", { messages: [{ role: "user", content: "q" }, { role: "assistant", content: [{ type: "text", text: "다 끝났어요" }] }] }, ctx);
    await pi.fire("agent_settled", { aborted: false }, ctx);
    await waitFor(() => received('{"type":"agent.idle","idle":true}'), 5000, "settled forwarded");
    const lines = fakeLog()
      .split("\n")
      .filter((l) => l.startsWith("recv {") && !l.includes('"hello"'))
      .map((l) => l.slice(5));
    expect(lines).toEqual([
      '{"type":"agent.idle","idle":false}',
      '{"type":"agent.delta","text":"중간"}',
      '{"type":"agent.tool.start","name":"bash"}',
      '{"type":"agent.tool.end","name":"bash","ok":false}',
      '{"type":"agent.turn.end"}',
      '{"type":"agent.end","text":"다 끝났어요"}',
      '{"type":"agent.idle","idle":true}',
    ]);
  });

  test("input tap logs utterance_received and input_admitted for the same utterance", async () => {
    script({ type: "utterance", id: "u9", text: "파일 목록 보여 줘", kind: "message" });
    const { pi, ctx } = setup();
    await startVoice(pi, ctx);
    await waitFor(() => pi.userMessages.length === 1, 5000, "message delivered");
    await pi.fire("input", { type: "input", source: "interactive", text: "파일 목록 보여 줘" }, ctx);
    await pi.fire("input", { type: "input", source: "extension", text: "파일 목록 보여 줘", streamingBehavior: "steer" }, ctx);
    await waitFor(() => extLog().includes("input_admitted"), 5000, "input_admitted");
    expect(extLog()).toMatch(/utterance_received u9 \d+ 파일 목록 보여 줘/);
    expect(extLog().match(/input_admitted u9 \d+ steer/g)?.length).toBe(1);
  });

  test("ask-user bus events forward agent.question and agent.question.closed", async () => {
    const { pi, ctx } = setup();
    await startVoice(pi, ctx);
    pi.events.emit("ask-user:asked", {
      ctx: {},
      variant: "blocking",
      request: { requestId: "q-1", questions: [{ header: "선택", question: "어느 쪽?", options: [{ label: "A" }, { label: "B", description: "두 번째" }] }] },
    });
    pi.events.emit("ask-user:closed", { requestId: "q-1", status: "answered" });
    await waitFor(() => received('{"type":"agent.question.closed","requestId":"q-1"}'), 5000, "question closed");
    expect(
      received('{"type":"agent.question","requestId":"q-1","header":"선택","question":"어느 쪽?","options":[{"label":"A"},{"label":"B","description":"두 번째"}]}'),
    ).toBe(true);
  });

  test("malformed bridge lines are logged and skipped", async () => {
    writeFileSync(join(dir, "script.jsonl"), 'not json\n{"no":1}\n{"type":"utterance","id":"u2","text":"ok","kind":"message"}\n');
    const { pi, ctx } = setup();
    await startVoice(pi, ctx);
    await waitFor(() => pi.userMessages.length === 1, 5000, "valid line after bad ones");
    expect(extLog().match(/bad_line/g)?.length).toBe(2);
  });
});
