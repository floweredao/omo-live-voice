// Extension <-> bridge link: JSONL over stdin/stdout. stdout carries protocol lines ONLY;
// every log goes to stderr.
import type { BridgeToExt, ExtToBridge } from "../shared/protocol.ts";

export type ExtLog = (msg: string) => void;

const stderrLog: ExtLog = (msg) => process.stderr.write(`${msg}\n`);

/** Incremental JSONL parser: feed arbitrary chunks, receive one callback per complete valid line. */
export function createLineParser(onMsg: (msg: ExtToBridge) => void, log: ExtLog = stderrLog) {
  const decoder = new TextDecoder();
  let buf = "";
  const line = (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      log(`ext_link bad_json len=${text.length}`);
      return;
    }
    if (typeof msg !== "object" || msg === null || typeof (msg as { type?: unknown }).type !== "string") {
      log("ext_link bad_message missing type");
      return;
    }
    onMsg(msg as ExtToBridge);
  };
  return {
    push(chunk: Uint8Array | string): void {
      buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        line(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
    },
    /** End of input: a trailing line without a newline still counts. */
    end(): void {
      buf += decoder.decode();
      const rest = buf;
      buf = "";
      line(rest);
    },
  };
}

export interface ReadExtOptions {
  input?: AsyncIterable<Uint8Array | string>;
  log?: ExtLog;
}

/** Reads JSONL messages until EOF; resolves when the input ends (the extension or OmO went away). */
export async function readExt(onMsg: (msg: ExtToBridge) => void, opts: ReadExtOptions = {}): Promise<void> {
  const log = opts.log ?? stderrLog;
  const parser = createLineParser((msg) => {
    try {
      onMsg(msg);
    } catch (e) {
      log(`ext_link handler_error ${(e as Error).message.slice(0, 200)}`);
    }
  }, log);
  const input = opts.input ?? (process.stdin as AsyncIterable<Uint8Array>);
  try {
    for await (const chunk of input) parser.push(chunk);
  } catch (e) {
    log(`ext_link read_error ${(e as Error).message.slice(0, 200)}`);
  }
  parser.end();
}

export type ExtWriter = (line: string) => void;
const stdoutWriter: ExtWriter = (line) => process.stdout.write(line);

export function sendExt(msg: BridgeToExt, write: ExtWriter = stdoutWriter): void {
  write(`${JSON.stringify(msg)}\n`);
}
