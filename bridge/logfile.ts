// Structured JSONL log file: <dataDir>/logs/<ISO>.log. Every record passes through redact().
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const KEEP_LOG_FILES = 20;

/** Masks API keys, bearer tokens, URL tokens and any caller-supplied secret values. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join("[redacted]");
  return out
    .replace(/sk-[\w-]*/g, "[redacted]")
    .replace(/(Bearer\s+)[\w.~+/=-]+/gi, "$1[redacted]")
    .replace(/([?&]token=)[^\s&"]+/g, "$1[redacted]");
}

export class LogFile {
  readonly file: string;
  private ready = false;
  private secrets: string[] = [];

  constructor(private readonly dir: string) {
    this.file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  }

  addSecret(secret: string): void {
    if (secret) this.secrets.push(secret);
  }

  write(record: Record<string, unknown>): void {
    try {
      if (!this.ready) {
        mkdirSync(this.dir, { recursive: true });
        this.rotate();
        this.ready = true;
      }
      appendFileSync(this.file, `${redact(JSON.stringify({ ts: new Date().toISOString(), ...record }), this.secrets)}\n`);
    } catch {
      // Logging must never take the bridge down.
    }
  }

  /** Keep the newest KEEP_LOG_FILES files including the one about to be written. */
  private rotate(): void {
    const names = readdirSync(this.dir).filter((n) => /^\d.*\.log$/.test(n) && join(this.dir, n) !== this.file).sort();
    for (const n of names.slice(0, Math.max(0, names.length - (KEEP_LOG_FILES - 1)))) {
      try {
        unlinkSync(join(this.dir, n));
      } catch {
        // already gone
      }
    }
  }
}
