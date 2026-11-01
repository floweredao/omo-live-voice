import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, appendFileSync, constants, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BridgeToExt, ExtToBridge, QuestionOption } from "../shared/protocol.ts";
import { ASK_USER_ANSWER_API, MCP_APP_FALLBACK_MS, PANEL_HOST, STOP_TIMEOUT_MS, type PanelHost } from "./config.ts";

type Lock = { sessionId: string; pid: number; startedAt: string; title?: string | null };
type StateMsg = Extract<BridgeToExt, { type: "state" }>;

const USAGE = "사용법: /voice | /voice tab | /voice stop | /voice confirm on|off";
const SUBCOMMANDS = [
  { value: "stop", label: "stop", description: "음성 모드 종료" },
  { value: "tab", label: "tab", description: "브라우저 탭으로 패널 열기" },
  { value: "confirm on", label: "confirm on", description: "보내기 전에 확인" },
  { value: "confirm off", label: "confirm off", description: "바로 보내기" },
];

const dataDir = () => process.env.OLV_DATA_DIR ?? join(homedir(), ".omo-live-voice");
const lockPath = () => join(dataDir(), "active.json");
const stopTimeoutMs = () => Number(process.env.OLV_STOP_TIMEOUT_MS) || STOP_TIMEOUT_MS;

function readLock(): Lock | null {
  try {
    const lock = JSON.parse(readFileSync(lockPath(), "utf8")) as Lock;
    return typeof lock?.pid === "number" && typeof lock?.sessionId === "string" ? lock : null;
  } catch {
    return null;
  }
}

function writeLock(lock: Lock): void {
  mkdirSync(dataDir(), { recursive: true });
  const tmp = `${lockPath()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(lock));
  renameSync(tmp, lockPath());
}

function removeLockIfOwned(pid: number | undefined): void {
  const lock = readLock();
  if (lock && pid !== undefined && lock.pid !== pid) return;
  rmSync(lockPath(), { force: true });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function resolveBun(): string | null {
  if (process.env.OLV_BUN) return process.env.OLV_BUN;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && isExecutable(join(dir, "bun"))) return join(dir, "bun");
  }
  const home = join(homedir(), ".bun", "bin", "bun");
  if (isExecutable(home)) return home;
  const bundled = join(homedir(), ".omo", "agent", "bundled-bun");
  try {
    const candidates = readdirSync(bundled)
      .map((d) => join(bundled, d, "bun"))
      .filter(isExecutable)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (candidates[0]) return candidates[0];
  } catch {}
  return null;
}

function lastAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m?.role !== "assistant") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .filter((c: { type?: string }) => c?.type === "text")
        .map((c: { text?: string }) => c.text ?? "")
        .join("");
    }
  }
  return "";
}

function statusLabel(s: StateMsg): string {
  if (s.muted || s.connection === "closed") return "🎙 일시정지";
  if (s.connection === "connecting") return "🎙 음성 연결 중";
  if (s.output === "speaking") return "🎙 말하는 중";
  if (s.agent !== "idle") return "🎙 에이전트 작업 중";
  return "🎙 듣는 중";
}

function toOptions(raw: unknown): QuestionOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((o) =>
    typeof o === "string"
      ? { label: o }
      : { label: String((o as QuestionOption)?.label ?? ""), ...((o as QuestionOption)?.description ? { description: String((o as QuestionOption).description) } : {}) },
  );
}

export default function omoLiveVoice(pi: ExtensionAPI): void {
  try {
    let child: ChildProcess | null = null;
    let childSessionId: string | null = null;
    let ctxRef: ExtensionContext | null = null;
    let logFile: string | null = null;
    let openOnReady: PanelHost | null = null;
    let panelConnected = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let stopping = false;
    let deltas = "";
    let exitWaiters: (() => void)[] = [];
    const pending: { id: string; text: string }[] = [];

    const extLog = (line: string) => {
      if (!logFile) return;
      try {
        mkdirSync(dirname(logFile), { recursive: true });
        appendFileSync(logFile, `${line.replace(/\n/g, "\\n")}\n`);
      } catch {}
    };
    const notify = (msg: string, type: "info" | "warning" | "error" = "info") => {
      try {
        ctxRef?.ui.notify(msg, type);
      } catch {}
    };
    const setStatus = (text: string) => {
      try {
        ctxRef?.ui.setStatus("voice", text);
      } catch {}
    };
    const send = (msg: ExtToBridge) => {
      if (!child?.stdin || child.stdin.destroyed) return;
      try {
        child.stdin.write(`${JSON.stringify(msg)}\n`);
      } catch (err) {
        extLog(`send_failed ${String(err)}`);
      }
    };

    const openBrowser = (url: string) => {
      execFile(process.env.OLV_OPEN_CMD ?? "open", [url], (err) => {
        if (err) {
          extLog(`open_failed ${err.message}`);
          notify(`패널을 열지 못했어요. 브라우저에서 직접 여세요: ${url}`, "warning");
        }
      });
    };

    const openPanel = (host: PanelHost, url: string) => {
      if (host === "browser-tab") return openBrowser(url);
      panelConnected = false;
      pi.sendMessage(
        { customType: "omo-live-voice", content: `Call the tool voice_panel_open with url="${url}" now and reply with nothing else.`, display: false },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      if (fallbackTimer) clearTimeout(fallbackTimer);
      fallbackTimer = setTimeout(() => {
        fallbackTimer = null;
        if (panelConnected || !child) return;
        openBrowser(url);
        notify("사이드패널이 열리지 않아 브라우저 탭으로 열었어요", "info");
      }, MCP_APP_FALLBACK_MS);
    };

    const onBridge = (msg: BridgeToExt) => {
      switch (msg.type) {
        case "ready": {
          const host = openOnReady;
          openOnReady = null;
          extLog(`ready port=${msg.port}`);
          if (host) {
            openPanel(host, msg.panelUrl);
            setStatus("🎙 음성 연결 중");
            notify("음성 모드 켜짐: 패널에서 마이크를 허용해 주세요", "info");
          }
          return;
        }
        case "utterance": {
          extLog(`utterance_received ${msg.id} ${Date.now()} ${msg.text}`);
          const idle = ctxRef?.isIdle() ?? true;
          if (msg.kind === "message") {
            pending.push({ id: msg.id, text: msg.text });
            if (pending.length > 50) pending.shift();
            pi.sendUserMessage(msg.text, idle ? undefined : { deliverAs: "steer" });
          } else if (msg.kind === "cancel") {
            if (!idle) ctxRef?.abort();
          } else if (!ASK_USER_ANSWER_API) {
            notify("질문은 화면에서 선택해 주세요", "info");
          }
          return;
        }
        case "state":
          if (msg.connection !== "closed") panelConnected = true;
          setStatus(statusLabel(msg));
          return;
        case "log":
          if (msg.msg.includes("panel.connected")) panelConnected = true;
          extLog(`bridge_${msg.level} ${msg.msg}`);
          return;
        case "exit":
          extLog(`bridge_exit ${msg.reason}`);
          if (!stopping) notify(`음성 종료: ${msg.reason}`, "info");
          stopping = true;
          return;
      }
    };

    const cleanup = (pid: number | undefined) => {
      if (fallbackTimer) clearTimeout(fallbackTimer);
      fallbackTimer = null;
      child = null;
      childSessionId = null;
      openOnReady = null;
      pending.length = 0;
      removeLockIfOwned(pid);
      setStatus("");
      const waiters = exitWaiters;
      exitWaiters = [];
      for (const w of waiters) w();
    };

    const start = (ctx: ExtensionContext, arg: "" | "tab"): string => {
      ctxRef = ctx;
      const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
      const sessionId = sessionFile ? basename(sessionFile, extname(sessionFile)) : (childSessionId ?? randomUUID());
      const title = ctx.sessionManager.getSessionName?.() ?? null;
      const host: PanelHost = arg === "tab" ? "browser-tab" : PANEL_HOST;

      let lock = readLock();
      if (lock && !pidAlive(lock.pid)) {
        rmSync(lockPath(), { force: true });
        lock = null;
      }
      if (child && childSessionId === sessionId) {
        openOnReady = host;
        send({ type: "resume" });
        notify("음성 재개", "info");
        return "resumed";
      }
      const owner = child ? { sessionId: childSessionId, title: null } : lock;
      if (owner && owner.sessionId !== sessionId) {
        notify(`이미 다른 세션(${owner.title || owner.sessionId})에 연결됨. 그곳에서 /voice stop 실행`, "warning");
        return "refused_other_session";
      }
      if (lock) {
        notify(`이 세션의 이전 음성 브리지(pid ${lock.pid})가 아직 실행 중이에요. /voice stop 후 다시 시도하세요`, "warning");
        return "refused_leftover";
      }

      const bun = resolveBun();
      if (!bun) {
        notify("bun을 찾지 못했어요. OLV_BUN 환경 변수로 경로를 지정하세요", "error");
        return "no_bun";
      }
      const bridgeMain = fileURLToPath(new URL("../bridge/main.ts", import.meta.url));
      logFile = join(dataDir(), "logs", `ext-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
      stopping = false;
      deltas = "";
      const proc = spawn(bun, [bridgeMain], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env }, cwd: ctx.cwd });
      child = proc;
      childSessionId = sessionId;
      openOnReady = host;
      extLog(`spawn pid=${proc.pid} bun=${bun}`);

      proc.on("error", (err) => {
        extLog(`spawn_error ${err.message}`);
        notify(`음성 브리지를 시작하지 못했어요: ${err.message}`, "error");
        if (child === proc) cleanup(proc.pid);
      });
      proc.on("exit", (code, signal) => {
        extLog(`child_exit code=${code} signal=${signal}`);
        if (!stopping) notify(`음성 브리지가 종료됐어요 (code ${code ?? signal})`, "warning");
        if (child === proc) cleanup(proc.pid);
      });
      proc.stdin?.on("error", (err) => extLog(`stdin_error ${err.message}`));
      if (proc.stdout) {
        createInterface({ input: proc.stdout }).on("line", (line) => {
          if (!line.trim()) return;
          let msg: BridgeToExt;
          try {
            msg = JSON.parse(line) as BridgeToExt;
          } catch {
            return extLog(`bad_line ${line.slice(0, 200)}`);
          }
          if (!msg || typeof msg.type !== "string") return extLog(`bad_line ${line.slice(0, 200)}`);
          try {
            onBridge(msg);
          } catch (err) {
            extLog(`handler_error ${String(err)}`);
          }
        });
      }
      if (proc.pid !== undefined) writeLock({ sessionId, pid: proc.pid, startedAt: new Date().toISOString(), title });
      send({ type: "hello", sessionId, sessionFile, cwd: ctx.cwd, title, qa: process.env.OLV_QA === "1" });
      setStatus("🎙 음성 연결 중");
      return "started";
    };

    const stop = async (ctx: ExtensionContext | null, signal?: AbortSignal): Promise<string> => {
      if (ctx) ctxRef = ctx;
      const proc = child;
      if (!proc) {
        const lock = readLock();
        const sessionFile = ctx?.sessionManager.getSessionFile();
        const sessionId = sessionFile ? basename(sessionFile, extname(sessionFile)) : null;
        if (lock && pidAlive(lock.pid) && sessionId && lock.sessionId === sessionId) {
          try {
            process.kill(lock.pid, "SIGTERM");
          } catch {}
          rmSync(lockPath(), { force: true });
          notify("음성 종료", "info");
          return "stopped_leftover";
        }
        if (lock && !pidAlive(lock.pid)) rmSync(lockPath(), { force: true });
        notify("음성 모드가 켜져 있지 않아요", "info");
        return "not_running";
      }
      stopping = true;
      const exited = new Promise<void>((resolve) => exitWaiters.push(resolve));
      send({ type: "stop" });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        exited.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), stopTimeoutMs());
          signal?.addEventListener("abort", () => resolve(true), { once: true });
        }),
      ]);
      clearTimeout(timer);
      if (timedOut && child === proc) {
        extLog("stop_timeout sigterm");
        proc.kill("SIGTERM");
        cleanup(proc.pid);
      }
      notify("음성 종료", "info");
      return timedOut ? "stopped_sigterm" : "stopped";
    };

    pi.registerCommand("voice", {
      description: "음성으로 이 세션과 대화 (stop|tab|confirm on|off)",
      getArgumentCompletions: (prefix: string) => {
        const items = SUBCOMMANDS.filter((s) => s.value.startsWith(prefix.trim()));
        return items.length ? items : null;
      },
      handler: async (args: string, ctx) => {
        try {
          const a = (args ?? "").trim().split(/\s+/).filter(Boolean);
          if (a.length === 0 || (a.length === 1 && a[0] === "tab")) {
            start(ctx, a[0] === "tab" ? "tab" : "");
          } else if (a.length === 1 && a[0] === "stop") {
            await stop(ctx);
          } else if (a.length === 2 && a[0] === "confirm" && (a[1] === "on" || a[1] === "off")) {
            ctxRef = ctx;
            if (!child) return notify("음성 모드가 켜져 있지 않아요", "info");
            send({ type: "confirm", mode: a[1] });
            notify(a[1] === "on" ? "보내기 전에 확인합니다" : "바로 보냅니다", "info");
          } else {
            ctx.ui.notify(USAGE, "info");
          }
        } catch (err) {
          try {
            ctx.ui.notify(`/voice 오류: ${String(err)}`, "error");
          } catch {}
        }
      },
    });

    pi.registerTool({
      name: "voice_start",
      label: "Voice Start",
      description: "이 세션의 음성 모드를 시작합니다 (/voice 와 같음). 인자는 없습니다.",
      parameters: { type: "object", properties: {}, additionalProperties: false } as never,
      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        let outcome: string;
        try {
          outcome = start(ctx, "");
        } catch (err) {
          outcome = `error ${String(err)}`;
        }
        return { content: [{ type: "text", text: `voice_start: ${outcome}` }], details: { outcome } };
      },
    });

    pi.on("input", (event, ctx) => {
      if (!child || event.source !== "extension") return;
      ctxRef = ctx;
      const i = pending.findIndex((p) => p.text === event.text);
      if (i < 0) return;
      const [p] = pending.splice(i, 1);
      extLog(`input_admitted ${p!.id} ${Date.now()} ${event.streamingBehavior ?? "idle"}`);
    });
    pi.on("message_update", (event) => {
      if (!child) return;
      const e = event.assistantMessageEvent as { type?: string; delta?: string };
      if (e?.type !== "text_delta" || typeof e.delta !== "string") return;
      deltas += e.delta;
      send({ type: "agent.delta", text: e.delta });
    });
    pi.on("tool_execution_start", (event) => {
      if (child) send({ type: "agent.tool.start", name: event.toolName });
    });
    pi.on("tool_execution_end", (event) => {
      if (child) send({ type: "agent.tool.end", name: event.toolName, ok: !event.isError });
    });
    pi.on("turn_end", () => {
      if (child) send({ type: "agent.turn.end" });
    });
    pi.on("agent_start", (_event, ctx) => {
      if (!child) return;
      ctxRef = ctx;
      deltas = "";
      send({ type: "agent.idle", idle: false });
    });
    pi.on("agent_end", (event) => {
      if (!child) return;
      send({ type: "agent.end", text: lastAssistantText(event.messages) || deltas });
      deltas = "";
    });
    pi.on("agent_settled", () => {
      if (child) send({ type: "agent.idle", idle: true });
    });
    pi.on("session_shutdown", async (event, ctx) => {
      if (!child) return;
      await stop(ctx, (event as { signal?: AbortSignal }).signal);
    });

    pi.events.on("ask-user:asked", (payload) => {
      if (!child) return;
      const request = (payload as { request?: Record<string, unknown> })?.request ?? {};
      const questions = Array.isArray(request.questions) ? (request.questions as Record<string, unknown>[]) : [request];
      const q = questions[0] ?? {};
      send({
        type: "agent.question",
        requestId: String(request.requestId ?? ""),
        header: String(q.header ?? ""),
        question: String(q.question ?? ""),
        options: toOptions(q.options),
      });
    });
    pi.events.on("ask-user:closed", (payload) => {
      if (!child) return;
      send({ type: "agent.question.closed", requestId: String((payload as { requestId?: unknown })?.requestId ?? "") });
    });
  } catch (err) {
    try {
      console.error(`[omo-live-voice] extension load failed: ${String(err)}`);
    } catch {}
  }
}
