export class TaskLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private limit: number;
  private readonly onActive?: (active: number) => void;

  constructor(
    limit: number,
    onActive?: (active: number) => void,
  ) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError("TaskLimiter limit must be a positive integer");
    }
    this.limit = limit;
    this.onActive = onActive;
  }

  get currentLimit(): number {
    return this.limit;
  }

  setLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError("TaskLimiter limit must be a positive integer");
    }
    const previous = this.limit;
    this.limit = limit;
    if (limit <= previous) return;
    const available = Math.max(0, limit - this.active);
    for (let index = 0; index < available; index++) this.waiters.shift()?.();
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    while (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      this.onActive?.(this.active);
      return await task();
    } finally {
      this.active--;
      this.waiters.shift()?.();
      this.onActive?.(this.active);
    }
  }
}

export function batches<T>(values: T[], size = 500): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError("Batch size must be a positive integer");
  }
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
