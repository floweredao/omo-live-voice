// One timer table for the whole bridge. Nothing here owns a real timer: the owner calls
// poll() from its single ticker (and again whenever a fake clock moves), so tests drive time.

type Entry = { due: number; fn: () => void };

export class Timers {
  private entries = new Map<string, Entry>();
  private anon = 0;

  constructor(private readonly now: () => number) {}

  /** Arms (or re-arms) the named entry; a re-arm replaces the previous deadline and callback. */
  start(name: string, ms: number, fn: () => void): void {
    this.entries.set(name, { due: this.now() + ms, fn });
  }

  cancel(name: string): void {
    this.entries.delete(name);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Guard-compatible scheduler: returns a cancel function. */
  schedule(fn: () => void, ms: number): () => void {
    const name = `#${++this.anon}`;
    this.start(name, ms, fn);
    return () => this.cancel(name);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Fires every due entry in deadline order. Entries armed or cancelled by a callback are respected. */
  poll(): number {
    const now = this.now();
    const due = [...this.entries].filter(([, e]) => e.due <= now).sort((a, b) => a[1].due - b[1].due);
    let fired = 0;
    for (const [name, entry] of due) {
      if (this.entries.get(name) !== entry) continue; // cancelled or re-armed by an earlier callback
      this.entries.delete(name);
      fired++;
      entry.fn();
    }
    return fired;
  }
}
