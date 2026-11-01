// Panel server: static panel files + one authenticated, single-controller WebSocket on 127.0.0.1.
// Security boundary: WebSockets ignore CORS, so every upgrade needs the per-launch token AND an allowed Origin.

import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { decodeFrame, encodeFrame, FrameError } from "../shared/protocol.ts";
import type { BridgeToPanel, PanelHello, PanelToBridge } from "../shared/protocol.ts";

export const DEFAULT_PORT = 47831;
export const MAX_STRIKES = 3;
/** Close code sent to a second panel whose hello lost to the controlling panel. */
export const CLOSE_PANEL_TAKEN = 4409;

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Logger = (level: LogLevel, msg: string) => void;

const defaultLog: Logger = (level, msg) => {
  if (level === "debug" && process.env.OLV_DEBUG !== "1") return;
  console.error(JSON.stringify({ level, msg }));
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type OutboundMsg = DistributiveOmit<BridgeToPanel, "v" | "seq">;
export type InboundMsg = Exclude<PanelToBridge, PanelHello>;

export interface PanelConn {
  readonly hello: PanelHello;
  send(msg: OutboundMsg): void;
  sendPcm(generation: number, sequence: number, pcm: Int16Array): void;
  onMessage(cb: (msg: InboundMsg) => void): void;
  onPcm(cb: (frame: { generation: number; sequence: number; pcm: Int16Array }) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
  close(code?: number, reason?: string): void;
}

export interface StartServerOptions {
  panelDir: string;
  token: string;
  allowedOrigins: string[];
  onPanel: (conn: PanelConn) => void;
  port?: number;
  log?: Logger;
}

export interface PanelServer {
  port: number;
  url: string;
  /** Sends to the controlling panel; returns false when there is none. */
  broadcast(msg: OutboundMsg): boolean;
  /** Sends one speaker PCM frame to the controlling panel; returns false when there is none. */
  sendPcm(generation: number, sequence: number, pcm: Int16Array): boolean;
  close(): Promise<void>;
}

interface WsData {
  strikes: number;
  conn: Conn | null;
}

class Conn implements PanelConn {
  private msgCbs: ((msg: InboundMsg) => void)[] = [];
  private pcmCbs: ((f: { generation: number; sequence: number; pcm: Int16Array }) => void)[] = [];
  private closeCbs: ((code: number, reason: string) => void)[] = [];
  constructor(
    readonly hello: PanelHello,
    private readonly ws: ServerWebSocket<WsData>,
    private readonly stamp: (msg: OutboundMsg) => string,
  ) {}
  send(msg: OutboundMsg): void {
    this.ws.send(this.stamp(msg));
  }
  sendPcm(generation: number, sequence: number, pcm: Int16Array): void {
    this.ws.send(encodeFrame(generation, sequence, pcm));
  }
  onMessage(cb: (msg: InboundMsg) => void): void {
    this.msgCbs.push(cb);
  }
  onPcm(cb: (f: { generation: number; sequence: number; pcm: Int16Array }) => void): void {
    this.pcmCbs.push(cb);
  }
  onClose(cb: (code: number, reason: string) => void): void {
    this.closeCbs.push(cb);
  }
  close(code = 1000, reason = "closed"): void {
    this.ws.close(code, reason);
  }
  emitMessage(msg: InboundMsg): void {
    for (const cb of this.msgCbs) cb(msg);
  }
  emitPcm(f: { generation: number; sequence: number; pcm: Int16Array }): void {
    for (const cb of this.pcmCbs) cb(f);
  }
  emitClose(code: number, reason: string): void {
    for (const cb of this.closeCbs) cb(code, reason);
  }
}

/** Per-launch token: 32 random bytes as hex, or OLV_TEST_TOKEN for QA runs. */
export function createToken(env: Record<string, string | undefined> = process.env, log: Logger = defaultLog): string {
  const fixed = env.OLV_TEST_TOKEN;
  if (fixed) {
    log("warn", "test_token");
    return fixed;
  }
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const INBOUND_TYPES = new Set(["hello", "devices", "control", "playback"]);

function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

export async function startServer(opts: StartServerOptions): Promise<PanelServer> {
  const log = opts.log ?? defaultLog;
  const requested = opts.port ?? Number(process.env.OLV_PORT ?? DEFAULT_PORT);
  const indexPath = join(opts.panelDir, "index.html");
  let controller: Conn | null = null;
  let seq = 0;
  const stamp = (msg: OutboundMsg): string => JSON.stringify({ ...msg, v: 1, seq: ++seq });
  const errorFrame = (code: string, message: string, recoverable: boolean): string =>
    stamp({ type: "error", code, message, recoverable });

  const strike = (ws: ServerWebSocket<WsData>, code: string, message: string): void => {
    ws.data.strikes += 1;
    ws.send(errorFrame(code, message, ws.data.strikes < MAX_STRIKES));
    if (ws.data.strikes >= MAX_STRIKES) ws.close(1008, "too many malformed frames");
  };

  const serve = (port: number) =>
    Bun.serve<WsData>({
      hostname: "127.0.0.1",
      port,
      routes: {
        // Token is never embedded: the panel reads ?token= from location.search.
        "/": () => new Response(Bun.file(indexPath), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }),
        "/assets/*": { dir: opts.panelDir },
      },
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname !== "/ws") return new Response("not found", { status: 404 });
        const origin = req.headers.get("origin");
        const originOk = origin !== null && (opts.allowedOrigins.includes(origin) || origin === `http://127.0.0.1:${server.port}`);
        if (url.searchParams.get("token") !== opts.token || !originOk) return unauthorized();
        if (server.upgrade(req, { data: { strikes: 0, conn: null } })) return undefined;
        return new Response("upgrade required", { status: 426 });
      },
      websocket: {
        message(ws, raw) {
          if (typeof raw !== "string") {
            let frame: ReturnType<typeof decodeFrame>;
            try {
              const bytes = raw as Uint8Array;
              frame = decodeFrame(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
            } catch (e) {
              strike(ws, "bad_frame", e instanceof FrameError ? e.message : "undecodable binary frame");
              return;
            }
            if (!ws.data.conn) return strike(ws, "hello_required", "send hello first");
            ws.data.conn.emitPcm(frame);
            return;
          }
          let msg: unknown;
          try {
            msg = JSON.parse(raw);
          } catch {
            return strike(ws, "bad_envelope", "invalid JSON");
          }
          const m = msg as { v?: unknown; type?: unknown; seq?: unknown };
          if (typeof msg !== "object" || msg === null || m.v !== 1 || typeof m.type !== "string" || typeof m.seq !== "number" || !INBOUND_TYPES.has(m.type)) {
            return strike(ws, "bad_envelope", "expected {v:1,type,seq} with a known type");
          }
          if (m.type === "hello") {
            const hello = msg as PanelHello;
            if (hello.token !== opts.token) {
              ws.send(errorFrame("unauthorized", "bad token", false));
              ws.close(1008, "unauthorized");
              return;
            }
            if (ws.data.conn) return;
            if (controller) {
              ws.send(errorFrame("panel_taken", "another panel is already connected", false));
              ws.close(CLOSE_PANEL_TAKEN, "panel_taken");
              return;
            }
            const conn = new Conn(hello, ws, stamp);
            ws.data.conn = conn;
            controller = conn;
            opts.onPanel(conn);
            return;
          }
          if (!ws.data.conn) return strike(ws, "hello_required", "send hello first");
          ws.data.conn.emitMessage(msg as InboundMsg);
        },
        close(ws, code, reason) {
          const conn = ws.data.conn;
          if (!conn) return;
          if (controller === conn) controller = null;
          conn.emitClose(code, reason);
        },
      },
    });

  let server: ReturnType<typeof serve>;
  try {
    server = serve(requested);
  } catch (e) {
    if ((e as { code?: string }).code !== "EADDRINUSE") throw e;
    log("warn", "port_fallback");
    server = serve(0);
  }
  const port = server.port as number;
  const url = `http://127.0.0.1:${port}/?token=${opts.token}`;
  log("info", `panel_server listening port=${port}`);
  log("debug", `panel_url ${url}`);

  return {
    port,
    url,
    broadcast(msg) {
      if (!controller) return false;
      controller.send(msg);
      return true;
    },
    sendPcm(generation, sequence, pcm) {
      if (!controller) return false;
      controller.sendPcm(generation, sequence, pcm);
      return true;
    },
    async close() {
      await server.stop(true);
    },
  };
}
