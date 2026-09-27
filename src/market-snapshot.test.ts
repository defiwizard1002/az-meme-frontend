import { describe, expect, it } from 'vitest';
import { chooseNewerCandle, mergeSnapshots } from './App.js';
import { streamBatchItems, streamSequenceAction } from './stream-batches.js';
import type { Candle, CandleSnapshot } from './types.js';

const candle = (t: number, revision: string, close = '1'): Candle => ({
  t, o: close, h: close, l: close, c: close, baseVolume: '1', quoteVolume: '1', revision,
});
const snapshot = (items: Candle[], revision = '1'): CandleSnapshot => ({
  chainId: 4663, tokenAddress: '0x1111111111111111111111111111111111111111', marketKey: 'USD:USDG',
  interval: '1s', syncStatus: 'READY', availability: 'COMPLETE', coverage: { from: 1, to: 100 },
  gaps: [], revision, asOfBlock: 100, source: 'CHAIN', items,
});

describe('USD candle snapshot and live batch revision handling', () => {
  it('upserts a live revision immediately and refuses duplicate or older revisions', () => {
    expect(chooseNewerCandle(candle(1, '18446744073709551600'), candle(1, '18446744073709551601')).revision)
      .toBe('18446744073709551601');
    expect(chooseNewerCandle(candle(1, '10'), candle(1, '9')).revision).toBe('10');
    expect(streamBatchItems({ items: [candle(1, '10'), candle(2, '11')] })).toHaveLength(2);
  });

  it('merges a single gap snapshot with live candles in deterministic time order', () => {
    const live = snapshot([candle(1, '10'), candle(100, '100')], '100');
    const gap = snapshot(Array.from({ length: 99 }, (_, index) => candle(index + 1, '20')), '20');
    const merged = mergeSnapshots(live, gap);
    expect(merged.items).toHaveLength(100);
    expect(merged.items[0]?.revision).toBe('20');
    expect(merged.items.at(-1)?.revision).toBe('100');
    expect(merged.items.map((item) => item.t)).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
  });

  it('requires REST resync on reconnect epoch changes or missing sequence ranges', () => {
    const previous = { epoch: 'api-1', sequence: 10 };
    expect(streamSequenceAction(previous, { epoch: 'api-1', sequence: 10 })).toBe('DUPLICATE');
    expect(streamSequenceAction(previous, { epoch: 'api-1', sequence: 9 })).toBe('DUPLICATE');
    expect(streamSequenceAction(previous, { epoch: 'api-1', sequence: 11 })).toBe('APPLY');
    expect(streamSequenceAction(previous, { epoch: 'api-1', sequence: 1_000 })).toBe('RESYNC');
    expect(streamSequenceAction(previous, { epoch: 'api-2', sequence: 1 })).toBe('RESYNC');
  });
});
