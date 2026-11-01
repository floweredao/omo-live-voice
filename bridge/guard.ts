import { estimatedUsd as calculateEstimatedUsd } from "../shared/protocol.ts";

export interface GuardOptions {
  idleMs: number;
  capMs: number;
  warnMs: number;
  now: () => number;
  schedule: (fn: () => void, ms: number) => () => void;
}

export class Guard {
  onIdle: (() => void) | undefined;
  onWarn: (() => void) | undefined;
  onCap: (() => void) | undefined;

  private connectedAt: number | undefined;
  private elapsedMs = 0;
  private idleCancel: (() => void) | undefined;
  private warnCancel: (() => void) | undefined;
  private capCancel: (() => void) | undefined;
  private busy = false;
  private speaking = false;
  private idleFired = false;
  private warned = false;
  private capped = false;

  constructor(private readonly options: GuardOptions) {}

  connected(): void {
    if (this.connectedAt !== undefined) return;
    this.connectedAt = this.options.now();
    this.idleFired = false;
    if (!this.warned && this.elapsedMs < this.options.warnMs) {
      this.warnCancel = this.options.schedule(
        () => {
          this.warnCancel = undefined;
          this.warned = true;
          this.onWarn?.();
        },
        this.options.warnMs - this.elapsedMs,
      );
    }
    if (!this.capped && this.elapsedMs < this.options.capMs) {
      this.capCancel = this.options.schedule(
        () => {
          this.capCancel = undefined;
          this.capped = true;
          this.onCap?.();
        },
        this.options.capMs - this.elapsedMs,
      );
    }
    this.resetIdle();
  }

  disconnected(): void {
    if (this.connectedAt === undefined) return;
    this.elapsedMs += this.options.now() - this.connectedAt;
    this.connectedAt = undefined;
    this.clearTimers();
  }

  activity(kind: "speech" | "agent" | "playback"): void {
    if (kind !== "playback") this.resetIdle();
  }

  setAgentBusy(busy: boolean): void {
    this.busy = busy;
    this.resetIdle();
  }

  setUserSpeaking(speaking: boolean): void {
    this.speaking = speaking;
    this.resetIdle();
  }

  cumulativeMs(): number {
    return this.elapsedMs + (this.connectedAt === undefined ? 0 : this.options.now() - this.connectedAt);
  }

  estimatedUsd(): number {
    return calculateEstimatedUsd(this.cumulativeMs());
  }

  private resetIdle(): void {
    this.idleCancel?.();
    this.idleCancel = undefined;
    if (this.connectedAt === undefined || this.busy || this.speaking || this.idleFired) return;
    this.idleCancel = this.options.schedule(() => {
      this.idleCancel = undefined;
      this.idleFired = true;
      this.onIdle?.();
    }, this.options.idleMs);
  }

  private clearTimers(): void {
    this.idleCancel?.();
    this.warnCancel?.();
    this.capCancel?.();
    this.idleCancel = this.warnCancel = this.capCancel = undefined;
  }
}
