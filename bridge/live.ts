import { ACK_DELAY_MS, INSTRUCTIONS_KO, LIVE_MODEL, LIVE_RATE, LIVE_URL, LIVE_VOICE } from "./config.ts";

export type LiveEvent = { type: string; [key: string]: any };
export type LiveHandler = (event: LiveEvent) => void;

export type LiveOptions = {
  apiKey: string;
  /** Overrides LIVE_URL (tests only; the voice is never configurable). */
  url?: string;
  log?: (line: string) => void;
};

export function sessionConfig() {
  return {
    model: LIVE_MODEL,
    instructions: INSTRUCTIONS_KO,
    input: [] as unknown[],
    audio: { format: { type: "audio/pcm", rate: LIVE_RATE }, output: { voice: LIVE_VOICE } },
    delegation: { type: "client", acknowledgement_delay_ms: ACK_DELAY_MS },
  };
}

const KNOWN = new Set([
  "session.started",
  "session.output_audio.delta",
  "session.input_transcript.delta",
  "session.output_transcript.delta",
  "session.delegation.created",
  "session.commentary.appended",
  "session.thinking.appended",
  "session.usage.updated",
  "session.input_audio.muted",
  "session.input_audio.unmuted",
  "error",
  "session.closed",
]);

export class LiveSession {
  private ws: WebSocket | null = null;
  private started = false;
  private closing = false;
  private pendingByte: Uint8Array = new Uint8Array(0);
  private closedResolve: (() => void) | null = null;
  private handlers = new Map<string, Set<LiveHandler>>();
  private seq = 0;
  sessionId = "";
  usageSeconds = 0;
  startedSnapshot: Record<string, any> | null = null;

  private readonly opts: LiveOptions;

  constructor(opts: LiveOptions) {
    this.opts = opts;
  }

  get ready(): boolean {
    return this.started && !this.closing;
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }

  /** Subscribe to a server event type; "*" receives types outside the known set. Returns an unsubscribe fn. */
  onEvent(type: string, handler: LiveHandler): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }

  private emit(type: string, event: LiveEvent): void {
    for (const h of [...(this.handlers.get(type) ?? [])]) {
      try {
        h(event);
      } catch (e) {
        this.log(`LIVE_HANDLER_ERROR ${type} ${(e as Error).message.slice(0, 200)}`);
      }
    }
  }

  private send(msg: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  start(timeoutMs = 20_000): Promise<void> {
    const url = this.opts.url ?? LIVE_URL;
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.opts.apiKey}` } } as unknown as string[]);
    this.ws = ws;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("session.started not received in time"));
        ws.close();
      }, timeoutMs);
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ type: "session.start", event_id: "event_start", session: sessionConfig() }));
      });
      ws.addEventListener("message", (m) => {
        let event: LiveEvent;
        try {
          event = JSON.parse(typeof m.data === "string" ? m.data : new TextDecoder().decode(m.data as ArrayBuffer));
        } catch {
          this.log("LIVE_BAD_FRAME unparseable server message");
          return;
        }
        switch (event.type) {
          case "session.started":
            this.started = true;
            this.startedSnapshot = event.session ?? null;
            this.sessionId = event.session?.id ?? "";
            clearTimeout(timer);
            this.log(`LIVE_STARTED id=${this.sessionId}`);
            resolve();
            break;
          case "session.usage.updated":
            this.usageSeconds = event.usage?.seconds ?? this.usageSeconds;
            break;
          case "session.closed":
            this.closing = true;
            this.usageSeconds = event.usage?.seconds ?? this.usageSeconds;
            this.log(`LIVE_CLOSED id=${this.sessionId} seconds=${this.usageSeconds}`);
            break;
          case "error":
            // The server message can echo the API key: log only the code.
            this.log(`LIVE_ERROR code=${event.error?.code ?? "unknown"}`);
            if (!this.started) {
              clearTimeout(timer);
              reject(new Error(`session.start rejected: ${event.error?.code ?? "error"}`));
            }
            break;
          default:
            if (!KNOWN.has(event.type)) this.log(`LIVE_UNKNOWN_EVENT ${String(event.type).slice(0, 80)}`);
        }
        this.emit(KNOWN.has(event.type) ? event.type : "*", event);
        if (event.type === "session.closed") {
          this.closedResolve?.();
          ws.close();
        }
      });
      ws.addEventListener("error", () => this.log("LIVE_WS_ERROR"));
      ws.addEventListener("close", () => {
        clearTimeout(timer);
        const wasStarted = this.started;
        this.started = false;
        this.closedResolve?.();
        if (!wasStarted) reject(new Error("connection closed before session.started"));
        else if (!this.closing) {
          this.closing = true;
          this.log("LIVE_DROPPED connection closed without session.closed");
          // Normalize transport loss through the same terminal event as a server close.
          this.emit("session.closed", { type: "session.closed", reason: "live_dropped" });
        }
      });
    });
  }

  appendAudio(pcm: Uint8Array): void {
    if (!this.ready) return;
    let bytes = pcm;
    if (this.pendingByte.length) {
      bytes = new Uint8Array(this.pendingByte.length + pcm.length);
      bytes.set(this.pendingByte, 0);
      bytes.set(pcm, this.pendingByte.length);
    }
    const even = bytes.length - (bytes.length % 2);
    this.pendingByte = bytes.slice(even);
    if (even) this.send({ type: "session.input_audio.append", audio: Buffer.from(bytes.subarray(0, even)).toString("base64") });
  }

  commentary(content: string, delegationId: string | null, eventId: string): boolean {
    if (!this.ready) return false;
    return this.send({ type: "session.commentary.append", event_id: eventId, delegation_id: delegationId, content });
  }

  thinking(content: string, delegationId: string | null, eventId: string): boolean {
    if (!this.ready) return false;
    return this.send({ type: "session.thinking.append", event_id: eventId, delegation_id: delegationId, content });
  }

  instructions(content: string, delegationId: string | null, eventId: string): boolean {
    if (!this.ready) return false;
    return this.send({ type: "session.instructions.append", event_id: eventId, delegation_id: delegationId, content });
  }

  mute(timeoutMs = 5_000): Promise<void> {
    return this.toggleMute("mute", timeoutMs);
  }

  unmute(timeoutMs = 5_000): Promise<void> {
    return this.toggleMute("unmute", timeoutMs);
  }

  private toggleMute(kind: "mute" | "unmute", timeoutMs: number): Promise<void> {
    const id = `${kind}_${++this.seq}`;
    const ackType = kind === "mute" ? "session.input_audio.muted" : "session.input_audio.unmuted";
    return new Promise<void>((resolve, reject) => {
      if (!this.ready) return reject(new Error(`${kind}: session not ready`));
      const timer = setTimeout(() => {
        off();
        reject(new Error(`${kind}: ack not received in time`));
      }, timeoutMs);
      const off = this.onEvent(ackType, (e) => {
        if (e.client_event_id !== id) return;
        clearTimeout(timer);
        off();
        resolve();
      });
      this.send({ type: `session.input_audio.${kind}`, event_id: id });
    });
  }

  async close(timeoutMs = 15_000): Promise<void> {
    if (!this.ws || this.closing) return;
    this.closing = true;
    if (!this.started) {
      this.ws.close();
      return;
    }
    const closed = new Promise<void>((r) => (this.closedResolve = r));
    this.send({ type: "session.close" });
    let timer: ReturnType<typeof setTimeout>;
    const timedOut = await Promise.race([
      closed.then(() => false),
      new Promise<boolean>((r) => (timer = setTimeout(() => r(true), timeoutMs))),
    ]);
    clearTimeout(timer!);
    if (timedOut) {
      this.log("LIVE_CLOSE_TIMEOUT session.closed not received");
      this.ws.close();
    }
    this.started = false;
  }
}
