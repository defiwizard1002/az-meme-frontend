import type { Candle } from './types';

export class CandleReplayQueue {
  private readonly pending = new Map<number, Candle>();
  private readonly appliedRevisions = new Map<number, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(
    private readonly apply: (candle: Candle) => void,
    private readonly intervalMs = 1_000,
  ) {}

  enqueue(candles: Candle[]): void {
    if (this.stopped) return;
    for (const candle of candles) {
      const appliedRevision = this.appliedRevisions.get(candle.t) ?? 0;
      const queuedRevision = this.pending.get(candle.t)?.revision ?? 0;
      if (candle.revision <= Math.max(appliedRevision, queuedRevision)) continue;
      this.pending.set(candle.t, candle);
    }
    if (!this.timer) this.drain();
  }

  stop(): void {
    this.stopped = true;
    this.pending.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private drain(): void {
    if (this.stopped || this.pending.size === 0) return;
    const timestamp = Math.min(...this.pending.keys());
    const candle = this.pending.get(timestamp)!;
    this.pending.delete(timestamp);
    this.appliedRevisions.set(timestamp, candle.revision);
    this.apply(candle);
    if (this.pending.size > 0) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.drain();
      }, this.intervalMs);
    }
  }
}

export function streamBatchItems<T>(data: T | { items: T[] }): T[] {
  if (typeof data === 'object' && data !== null && 'items' in data && Array.isArray(data.items)) return data.items;
  return [data as T];
}
