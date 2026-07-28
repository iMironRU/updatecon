import { describe, it, expect } from "vitest";
import { TaskLimiter, batches } from "./index.js";

describe("batches", () => {
  it("splits array into batches of given size", () => {
    expect(batches([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
  });

  it("returns single batch when array fits in one", () => {
    expect(batches([1, 2, 3], 5)).toEqual([[1, 2, 3]]);
  });

  it("returns empty array for empty input", () => {
    expect(batches([], 3)).toEqual([]);
  });

  it("uses default size of 500", () => {
    const input = Array.from({ length: 1200 }, (_, i) => i);
    const result = batches(input);
    expect(result).toHaveLength(3);
    expect(result[0]).toHaveLength(500);
    expect(result[1]).toHaveLength(500);
    expect(result[2]).toHaveLength(200);
  });

  it("rejects a non-positive batch size", () => {
    expect(() => batches([1, 2, 3], 0)).toThrow(RangeError);
  });
});

describe("TaskLimiter", () => {
  it("runs a single task", async () => {
    const limiter = new TaskLimiter(1);
    const result = await limiter.run(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it("limits concurrency", async () => {
    const limiter = new TaskLimiter(2);
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = async (delay: number) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, delay));
      concurrent--;
      return delay;
    };

    const results = await Promise.all([
      limiter.run(() => task(50)),
      limiter.run(() => task(50)),
      limiter.run(() => task(50)),
      limiter.run(() => task(50)),
    ]);

    expect(results).toEqual([50, 50, 50, 50]);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it("calls onActive callback", async () => {
    const calls: number[] = [];
    const limiter = new TaskLimiter(2, (active) => calls.push(active));

    await Promise.all([
      limiter.run(() => Promise.resolve(1)),
      limiter.run(() => Promise.resolve(2)),
    ]);

    expect(calls).toContain(1);
    expect(calls).toContain(2);
  });

  it("runs tasks sequentially when limit is 1", async () => {
    const limiter = new TaskLimiter(1);
    const order: number[] = [];

    await Promise.all([
      limiter.run(async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(1);
      }),
      limiter.run(async () => {
        order.push(2);
      }),
    ]);

    expect(order).toEqual([1, 2]);
  });

  it("rejects when task throws", async () => {
    const limiter = new TaskLimiter(1);
    await expect(limiter.run(() => Promise.reject(new Error("fail")))).rejects.toThrow("fail");
  });

  it("rejects an invalid concurrency limit instead of deadlocking", () => {
    expect(() => new TaskLimiter(0)).toThrow(RangeError);
    expect(() => new TaskLimiter(Number.NaN)).toThrow(RangeError);
  });

  it("increases concurrency while tasks are queued", async () => {
    const limiter = new TaskLimiter(1);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let secondStarted = false;
    const first = limiter.run(() => firstGate);
    const second = limiter.run(async () => { secondStarted = true; });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(secondStarted).toBe(false);
    limiter.setLimit(2);
    await second;
    expect(secondStarted).toBe(true);
    expect(limiter.currentLimit).toBe(2);
    releaseFirst();
    await first;
  });

  it("applies a lower limit to subsequent tasks", async () => {
    const limiter = new TaskLimiter(2);
    limiter.setLimit(1);
    expect(limiter.currentLimit).toBe(1);
    expect(() => limiter.setLimit(0)).toThrow(RangeError);
  });

  it("releases the next task when the activity callback throws", async () => {
    let callbackCalls = 0;
    const limiter = new TaskLimiter(1, () => {
      callbackCalls++;
      if (callbackCalls === 1) throw new Error("stats callback failed");
    });

    await expect(limiter.run(() => Promise.resolve(1))).rejects.toThrow("stats callback failed");
    await expect(limiter.run(() => Promise.resolve(2))).resolves.toBe(2);
  });
});
