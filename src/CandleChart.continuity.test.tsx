import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CandleChart } from './CandleChart';
import { mergeSnapshots } from './App';
import type { Candle, CandleSnapshot } from './types';

const engine = vi.hoisted(() => ({
  create: vi.fn(), set: vi.fn(), update: vi.fn(), volumes: vi.fn(), updateVolume: vi.fn(),
  fit: vi.fn(), scroll: vi.fn(), range: vi.fn(), restore: vi.fn(), scaleOptions: vi.fn(),
  restorePrice: vi.fn(), crosshair: vi.fn(), restoreCrosshair: vi.fn(), removeCrosshair: vi.fn(),
}));
vi.mock('lightweight-charts', () => ({
  CandlestickSeries: 'candle', HistogramSeries: 'volume', ColorType: { Solid: 'solid' },
  CrosshairMode: { Normal: 0 }, createChart: engine.create,
}));
const candle = (t: number, close: string, revision = '1'): Candle => ({
  t, o: close, h: close, l: close, c: close, quoteVolume: '7', baseVolume: '9', revision,
});
const snapshot = (items: Candle[]): CandleSnapshot => ({
  chainId: 4663, tokenAddress: '0x1111', marketKey: 'USD:USDG', interval: '1s',
  syncStatus: 'READY', availability: 'COMPLETE', coverage: { from: 1, to: 100 },
  gaps: [], revision: '1', asOfBlock: 100, source: 'CHAIN', items,
});

describe('chart continuity and user viewport', () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.resetAllMocks();
    engine.range.mockReturnValue({ from: 0.25, to: 1.75 });
    engine.restore.mockImplementation((range) => engine.range.mockReturnValue(range));
    engine.create.mockReturnValue({
      addSeries: (type: string) => ({
        setData: type === 'candle' ? engine.set : engine.volumes,
        update: type === 'candle' ? engine.update : engine.updateVolume,
        coordinateToPrice: () => 2.25,
        priceScale: () => ({ applyOptions: engine.scaleOptions, options: () => ({ autoScale: false }),
          getVisibleRange: () => ({ from: 1, to: 4 }), setVisibleRange: engine.restorePrice }),
      }),
      applyOptions: vi.fn(), remove: vi.fn(), subscribeCrosshairMove: engine.crosshair,
      unsubscribeCrosshairMove: engine.removeCrosshair, setCrosshairPosition: engine.restoreCrosshair,
      timeScale: () => ({ fitContent: engine.fit, scrollToRealTime: engine.scroll,
        getVisibleLogicalRange: engine.range, setVisibleLogicalRange: engine.restore,
        subscribeVisibleLogicalRangeChange: vi.fn(), unsubscribeVisibleLogicalRangeChange: vi.fn() }),
    });
  });

  it('connects sorted genuine bars across empty seconds without changing raw facts or volumes', () => {
    const raw = [candle(110, '1'), candle(100, '2'), candle(105, '3')];
    const before = structuredClone(raw);
    render(<CandleChart symbol="A" candles={raw} />);
    expect(engine.set).toHaveBeenLastCalledWith([
      { time: 100, open: 2, high: 2, low: 2, close: 2 },
      { time: 105, open: 2, high: 3, low: 2, close: 3 },
      { time: 110, open: 3, high: 3, low: 1, close: 1 },
    ]);
    expect(engine.volumes.mock.lastCall?.[0].map((bar: { time: number; value: number }) => [bar.time, bar.value]))
      .toEqual([[100, 7], [105, 7], [110, 7]]);
    expect(raw).toEqual(before);
  });

  it('recomputes continuity after history prepend and out-of-order revision merges, keeping the same times visible', () => {
    const initial = snapshot([candle(100, '2'), candle(105, '3')]);
    const { rerender } = render(<CandleChart symbol="A" candles={initial.items} />);
    const merged = mergeSnapshots(initial, snapshot([candle(105, '99', '0'), candle(100, '4', '2'), candle(90, '5')]));
    const before = structuredClone(merged);
    rerender(<CandleChart symbol="A" candles={merged.items} />);
    expect(engine.set).toHaveBeenLastCalledWith([
      { time: 90, open: 5, high: 5, low: 5, close: 5 },
      { time: 100, open: 5, high: 5, low: 4, close: 4 },
      { time: 105, open: 4, high: 4, low: 3, close: 3 },
    ]);
    expect(engine.restore).toHaveBeenLastCalledWith({ from: 1.25, to: 2.75 });
    expect(engine.fit).toHaveBeenCalledTimes(1);
    expect(merged).toEqual(before);
    expect(merged.items.map((bar) => [bar.revision, bar.quoteVolume])).toEqual([['1', '7'], ['2', '7'], ['1', '7']]);
  });

  it('uses tail updates while preserving zoom, manual price range, focus and crosshair', () => {
    const initial = [candle(100, '2'), candle(105, '3')];
    const { rerender, unmount } = render(<CandleChart symbol="A" candles={initial} />);
    const setCount = engine.set.mock.calls.length;
    act(() => engine.crosshair.mock.lastCall?.[0]({ time: 100, point: { x: 20, y: 30 }, seriesData: new Map() }));
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    engine.update.mockImplementation(() => engine.range.mockReturnValue({ from: 8, to: 10 }));
    rerender(<CandleChart symbol="A" candles={[initial[0]!, candle(105, '4', '2'), candle(110, '1')]} />);
    expect(engine.set).toHaveBeenCalledTimes(setCount);
    expect(engine.update).toHaveBeenLastCalledWith({ time: 110, open: 4, high: 4, low: 1, close: 1 });
    expect(engine.restore).toHaveBeenLastCalledWith({ from: 0.25, to: 1.75 });
    expect(engine.restorePrice).toHaveBeenLastCalledWith({ from: 1, to: 4 });
    expect(engine.scaleOptions).not.toHaveBeenCalledWith({ autoScale: true });
    expect(engine.restoreCrosshair).toHaveBeenLastCalledWith(2.25, 100, expect.any(Object));
    expect(document.activeElement).toBe(input);
    expect(engine.fit).toHaveBeenCalledTimes(1);
    expect(engine.scroll).not.toHaveBeenCalled();
    expect(engine.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      timeScale: expect.objectContaining({ shiftVisibleRangeOnNewBar: false }),
    }));
    unmount();
    expect(engine.removeCrosshair).toHaveBeenCalledTimes(1);
    input.remove();
  });

  it('never refits for historical corrections or temporary empty recovery, but resets on token/interval identity', () => {
    const initial = [candle(100, '2'), candle(105, '3')];
    const { rerender } = render(<CandleChart key="A:1s" symbol="A" candles={initial} />);
    engine.set.mockImplementation((bars) => engine.range.mockReturnValue(bars.length ? { from: 8, to: 10 } : null));
    rerender(<CandleChart key="A:1s" symbol="A" candles={[candle(100, '4', '2'), initial[1]!]} />);
    expect(engine.restore).toHaveBeenLastCalledWith({ from: 0.25, to: 1.75 });
    rerender(<CandleChart key="A:1s" symbol="A" candles={[]} />);
    rerender(<CandleChart key="A:1s" symbol="A" candles={initial} />);
    expect(engine.fit).toHaveBeenCalledTimes(1);
    rerender(<CandleChart key="A:1m" symbol="A" candles={initial} />);
    expect(engine.fit).toHaveBeenCalledTimes(2);
    rerender(<CandleChart key="B:1m" symbol="B" candles={initial} />);
    expect(engine.fit).toHaveBeenCalledTimes(3);
  });

  it('leaves an already stable viewport alone on incremental tail updates', () => {
    const initial = [candle(100, '2'), candle(105, '3')];
    const { rerender } = render(<CandleChart symbol="A" candles={initial} />);
    engine.restore.mockClear();
    rerender(<CandleChart symbol="A" candles={[...initial, candle(110, '1')]} />);
    expect(engine.range()).toEqual({ from: 0.25, to: 1.75 });
    expect(engine.restore).not.toHaveBeenCalled();
    expect(engine.fit).toHaveBeenCalledTimes(1);
  });
});
