import { describe, expect, test } from "bun:test";
import { Guard } from "../bridge/guard.ts";

function clock() {
  let time = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => time,
    schedule: (fn: () => void, ms: number) => {
      const id = ++nextId;
      timers.set(id, { at: time + ms, fn });
      return () => timers.delete(id);
    },
    advanceTo(target: number) {
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        time = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
      }
      time = target;
    },
    advance(ms: number) { this.advanceTo(time + ms); },
  };
}

describe("Guard", () => {
  test("speech resets idle and idle fires at the exact deadline", () => {
    const c = clock();
    const guard = new Guard({ idleMs: 180_000, capMs: 3_600_000, warnMs: 3_300_000, now: c.now, schedule: c.schedule });
    let idle = 0;
    guard.onIdle = () => idle++;
    guard.connected();
    c.advanceTo(10_000);
    guard.activity("speech");
    c.advanceTo(189_999);
    expect(idle).toBe(0);
    c.advanceTo(190_000);
    expect(idle).toBe(1);
  });

  test("agent busy suppresses idle until its busy state ends", () => {
    const c = clock();
    const guard = new Guard({ idleMs: 180_000, capMs: 3_600_000, warnMs: 3_300_000, now: c.now, schedule: c.schedule });
    let idle = 0;
    guard.onIdle = () => idle++;
    guard.connected();
    guard.setAgentBusy(true);
    c.advanceTo(600_000);
    expect(idle).toBe(0);
    guard.setAgentBusy(false);
    c.advanceTo(779_999);
    expect(idle).toBe(0);
    c.advanceTo(780_000);
    expect(idle).toBe(1);
  });

  test("warns at 55 minutes and caps at 60 minutes", () => {
    const c = clock();
    const guard = new Guard({ idleMs: 180_000, capMs: 3_600_000, warnMs: 3_300_000, now: c.now, schedule: c.schedule });
    let warned = 0;
    let capped = 0;
    guard.onWarn = () => warned++;
    guard.onCap = () => capped++;
    guard.connected();
    c.advanceTo(3_299_999);
    expect(warned).toBe(0);
    c.advanceTo(3_300_000);
    expect(warned).toBe(1);
    c.advanceTo(3_600_000);
    expect(capped).toBe(1);
    expect(guard.estimatedUsd()).toBe(3);
  });

  test("cumulative duration and cost survive disconnect and resume", () => {
    const c = clock();
    const guard = new Guard({ idleMs: 180_000, capMs: 3_600_000, warnMs: 3_300_000, now: c.now, schedule: c.schedule });
    guard.connected();
    c.advanceTo(190_000);
    guard.disconnected();
    c.advanceTo(200_000);
    guard.connected();
    c.advanceTo(260_000);
    guard.disconnected();
    expect(guard.cumulativeMs()).toBe(250_000);
    expect(guard.estimatedUsd()).toBeCloseTo(0.2083, 4);
  });

  test("playback activity never resets idle", () => {
    const c = clock();
    const guard = new Guard({ idleMs: 180_000, capMs: 3_600_000, warnMs: 3_300_000, now: c.now, schedule: c.schedule });
    let idleAt = -1;
    guard.onIdle = () => { idleAt = c.now(); };
    guard.connected();
    c.advanceTo(100_000);
    guard.activity("playback");
    c.advanceTo(180_000);
    expect(idleAt).toBe(180_000);
  });
});
