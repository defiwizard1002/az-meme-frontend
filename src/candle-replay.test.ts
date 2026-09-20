import { describe, expect, it, vi } from 'vitest';
import { CandleReplayQueue, streamBatchItems } from './candle-replay';
import type { Candle } from './types';

function candle(t: number, revision = 1): Candle {
  return { t, o: String(t), h: String(t), l: String(t), c: String(t), baseVolume: '1', quoteVolume: '1', revision };
}

describe('CandleReplayQueue', () => {
  it('applies the first candle immediately and replays the rest once per second', () => {
    vi.useFakeTimers();
    const applied: Candle[] = [];
    const queue = new CandleReplayQueue((item) => applied.push(item));

    queue.enqueue([candle(102), candle(100), candle(101)]);
    expect(applied.map((item) => item.t)).toEqual([100]);
    vi.advanceTimersByTime(999);
    expect(applied.map((item) => item.t)).toEqual([100]);
    vi.advanceTimersByTime(1_001);
    expect(applied.map((item) => item.t)).toEqual([100, 101, 102]);

    queue.stop();
    vi.useRealTimers();
  });

  it('keeps only the newest queued revision and ignores an already applied revision', () => {
    vi.useFakeTimers();
    const applied: Candle[] = [];
    const queue = new CandleReplayQueue((item) => applied.push(item));

    queue.enqueue([candle(100, 1), candle(101, 1), candle(101, 2)]);
    queue.enqueue([candle(100, 1)]);
    vi.runAllTimers();

    expect(applied.map((item) => [item.t, item.revision])).toEqual([[100, 1], [101, 2]]);
    queue.stop();
    vi.useRealTimers();
  });
});

describe('streamBatchItems', () => {
  it('accepts the batched contract and the legacy single-item form', () => {
    expect(streamBatchItems({ items: [1, 2] })).toEqual([1, 2]);
    expect(streamBatchItems(1)).toEqual([1]);
  });
});
