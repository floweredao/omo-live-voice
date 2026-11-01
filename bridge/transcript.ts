// Ported from ddolmeng-voice/src/transcript.ts: groups transcript deltas into markdown lines.
// A new line starts when the speaker changes or the next fragment starts more than gapMs after
// the previous one ended. The file is created lazily on the first line, so a session in which
// nobody spoke leaves nothing behind.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type Speaker = "사용자" | "어시스턴트";

export class TranscriptLog {
  readonly file: string;
  private created = false;
  private speaker: Speaker | null = null;
  private text = "";
  private startMs = 0;
  private endMs = 0;

  constructor(
    private readonly dir: string,
    private readonly gapMs = 1500,
  ) {
    this.file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  }

  delta(speaker: Speaker, delta: string, startMs: number, endMs: number): void {
    if (this.speaker && (speaker !== this.speaker || startMs - this.endMs > this.gapMs)) this.flush();
    if (!this.speaker) {
      this.speaker = speaker;
      this.startMs = startMs;
    }
    this.text += delta;
    this.endMs = Math.max(this.endMs, endMs);
  }

  note(line: string): void {
    this.flush();
    this.append(`- _${new Date().toISOString()} ${line}_\n`);
  }

  flush(): void {
    if (this.speaker && this.text.trim()) {
      this.append(`- [${(this.startMs / 1000).toFixed(1)}s] **${this.speaker}**: ${this.text.trim()}\n`);
    }
    this.speaker = null;
    this.text = "";
  }

  private append(line: string): void {
    if (!this.created) {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.file, `# omo-live-voice ${new Date().toISOString()}\n\n`);
      this.created = true;
    }
    appendFileSync(this.file, line);
  }
}
