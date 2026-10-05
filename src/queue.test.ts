import { describe, expect, it } from "vitest";
import { isBusy, limit, tryRun } from "./queue.js";

function deferred<T = string>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("queue admission gate", () => {
  it("isBusy counts active + pending", async () => {
    expect(isBusy()).toBe(false);
    const gate1 = deferred();
    const gate2 = deferred();
    const p1 = tryRun(() => gate1.promise);
    const p2 = tryRun(() => gate2.promise);
    expect(p1).not.toBeNull();
    expect(p2).not.toBeNull();
    expect(isBusy()).toBe(true);
    gate1.resolve("a");
    gate2.resolve("b");
    await expect(p1).resolves.toBe("a");
    await expect(p2).resolves.toBe("b");
    expect(isBusy()).toBe(false);
  });

  it("5 parallel contenders -> 2 run, 3 get 429", async () => {
    const gates = [deferred(), deferred()];
    let running = 0;
    let started = 0;
    let dispatched = 0;
    let rejected = 0;

    const slow = (gate: number) => async () => {
      running++;
      started++;
      await gates[gate].promise;
      running--;
      return gate;
    };

    // Atomic admit: no await between the busy-check and dispatch (same
    // contract as POST /extract) — this is what makes the count exact.
    // Note: p-limit v5 moves tasks pending->active on a microtask, so
    // dispatch (pending) is what we assert synchronously here.
    const contenders = [0, 1, 2, 3, 4].map((i) => {
      const p = tryRun(slow(Math.min(i, 1)));
      if (p === null) {
        rejected++;
        return Promise.resolve("rejected" as const);
      }
      dispatched++;
      return p.then(() => "ran" as const);
    });

    // Only the first two pass the gate synchronously; rest see busy.
    expect(dispatched).toBe(2);
    expect(rejected).toBe(3);
    expect(limit.activeCount + limit.pendingCount).toBe(2);

    gates[0].resolve("x");
    gates[1].resolve("y");
    const outcomes = await Promise.all(contenders);
    expect(outcomes.filter((o) => o === "ran")).toHaveLength(2);
    expect(outcomes.filter((o) => o === "rejected")).toHaveLength(3);
    expect(started).toBe(2);
    expect(running).toBe(0);
    expect(isBusy()).toBe(false);
  });

  it("slot frees after completion", async () => {
    const p = tryRun(async () => "ok");
    expect(p).not.toBeNull();
    await expect(p).resolves.toBe("ok");
    expect(isBusy()).toBe(false);
  });
});
