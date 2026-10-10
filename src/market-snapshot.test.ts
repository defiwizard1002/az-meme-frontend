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

  it.each([false, true])('preserves partial history when merging a complete page (reversed: %s)', (reversed) => {
    const partial: CandleSnapshot = { ...snapshot([candle(50, '10')], '10'), availability: 'PARTIAL',
      coverage: { from: 50, to: 60 }, gaps: [{ from: 1, to: 49, reason: 'EVENT_EXPIRED' }] };
    const complete = { ...snapshot([candle(100, '20')], '20'), coverage: { from: 90, to: 100 } };
    const merged = mergeSnapshots(reversed ? complete : partial, reversed ? partial : complete);
    expect(merged.availability).toBe('PARTIAL');
    expect(merged.gaps).toEqual(partial.gaps);
    expect(merged.coverage).toEqual({ from: 50, to: 100 });
    expect(merged.revision).toBe('20');
    expect(merged.items.map((item) => item.t)).toEqual([50, 100]);
  });

  it('unions and deduplicates all gap metadata without losing overlapping reasons', () => {
    const expired = { from: 20, to: 40, reason: 'EVENT_EXPIRED' as const };
    const beforeStart = { from: 1, to: 19, reason: 'BEFORE_SCAN_START' as const };
    const overlapping = { from: 20, to: 40, reason: 'BEFORE_SCAN_START' as const };
    const first: CandleSnapshot = { ...snapshot([candle(50, '1')]), availability: 'PARTIAL', gaps: [expired] };
    const second: CandleSnapshot = { ...snapshot([candle(100, '2')]), availability: 'PARTIAL',
      gaps: [expired, overlapping, beforeStart] };
    const merged = mergeSnapshots(first, second);
    expect(merged.availability).toBe('PARTIAL');
    expect(merged.gaps).toEqual([beforeStart, overlapping, expired]);
    expect(mergeSnapshots(merged, second).gaps).toEqual(merged.gaps);
    expect(mergeSnapshots(second, first).gaps).toEqual(merged.gaps);
    expect(first.gaps).toEqual([expired]);
    expect(second.gaps).toEqual([expired, overlapping, beforeStart]);
  });

  it.each([false, true])('marks available history plus an unavailable older page partial (reversed: %s)', (reversed) => {
    const unavailable: CandleSnapshot = { ...snapshot([]), availability: 'UNAVAILABLE_BEFORE_START',
      coverage: { from: null, to: null }, gaps: [{ from: 1, to: 49, reason: 'BEFORE_SCAN_START' }] };
    const available = snapshot([candle(50, '2')]);
    const merged = mergeSnapshots(reversed ? available : unavailable, reversed ? unavailable : available);
    expect(merged.availability).toBe('PARTIAL');
    expect(merged.gaps).toEqual(unavailable.gaps);
    expect(merged.items).toEqual(available.items);
  });

  it('keeps an explicit partial status even if no gap details were supplied', () => {
    const partial: CandleSnapshot = { ...snapshot([candle(50, '1')]), availability: 'PARTIAL' };
    expect(mergeSnapshots(partial, snapshot([candle(100, '2')])).availability).toBe('PARTIAL');
  });

  it('keeps entirely unavailable history unavailable and fully complete pages complete', () => {
    const unavailable: CandleSnapshot = { ...snapshot([]), availability: 'UNAVAILABLE_BEFORE_START',
      gaps: [{ from: 1, to: 49, reason: 'BEFORE_SCAN_START' }] };
    expect(mergeSnapshots(unavailable, unavailable).availability).toBe('UNAVAILABLE_BEFORE_START');
    expect(mergeSnapshots(snapshot([candle(1, '1')]), snapshot([candle(2, '2')])).availability).toBe('COMPLETE');
  });

  it('never calls a snapshot with declared gaps complete, including its first page', () => {
    const inconsistent = { ...snapshot([candle(50, '1')]),
      gaps: [{ from: 1, to: 49, reason: 'EVENT_EXPIRED' as const }] };
    expect(mergeSnapshots(null, inconsistent).availability).toBe('PARTIAL');
    expect(mergeSnapshots(snapshot([]), inconsistent).availability).toBe('PARTIAL');
  });

  it.each([
    { tokenAddress: '0x2222222222222222222222222222222222222222' },
    { marketKey: 'USD:OTHER' },
    { interval: '1m' as const },
  ])('does not carry another series gaps into a replacement: %j', (identity) => {
    const partial: CandleSnapshot = { ...snapshot([candle(1, '1')]), availability: 'PARTIAL',
      gaps: [{ from: 2, to: 10, reason: 'EVENT_EXPIRED' }] };
    const next = { ...snapshot([candle(100, '2')]), ...identity };
    expect(mergeSnapshots(partial, next)).toEqual(next);
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
