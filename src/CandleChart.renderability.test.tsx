import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CandleChart } from './CandleChart';
import type { Candle } from './types';

const engine = vi.hoisted(() => ({
  createChart: vi.fn(),
  setCandles: vi.fn(),
  updateCandle: vi.fn(),
  setVolumes: vi.fn(),
  updateVolume: vi.fn(),
  subscribe: vi.fn(),
  visibleRange: vi.fn((): { from: number; to: number } | null => null),
  setVisibleRange: vi.fn(),
}));

vi.mock('lightweight-charts', () => ({
  CandlestickSeries: 'Candlestick',
  HistogramSeries: 'Histogram',
  ColorType: { Solid: 'solid' },
  CrosshairMode: { Normal: 0 },
  createChart: engine.createChart,
}));

// A decimal backend price that reproduces the real development-engine assertion.
const hugePrice = `3776570421343502${'0'.repeat(53)}`;
const chartBound = Number.MAX_SAFE_INTEGER / 100;
type ChartCandle = { time: number; open: number; high: number; low: number; close: number };
type ChartVolume = { time: number; value: number; color: string };

function candle(t: number, fields: Partial<Candle> = {}): Candle {
  return { t, o: '0.0184', h: '0.022', l: '0.017', c: '0.0195',
    baseVolume: '1200', quoteVolume: '0.42', revision: '1', ...fields };
}

function assertEngineValue(value: number, field: string): void {
  if (!Number.isFinite(value) || Math.abs(value) > chartBound) {
    throw new Error(`Assertion failed: ${field} must be between -90071992547409.91 and 90071992547409.91, value=${value}`);
  }
}

function assertEngineCandle(bar: ChartCandle): void {
  for (const field of ['open', 'high', 'low', 'close'] as const) assertEngineValue(bar[field], field);
}

describe('CandleChart renderability', () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.resetAllMocks();
    engine.setCandles.mockImplementation((bars: ChartCandle[]) => bars.forEach(assertEngineCandle));
    engine.updateCandle.mockImplementation(assertEngineCandle);
    engine.setVolumes.mockImplementation((bars: ChartVolume[]) => bars.forEach((bar) => assertEngineValue(bar.value, 'volume')));
    engine.updateVolume.mockImplementation((bar: ChartVolume) => assertEngineValue(bar.value, 'volume'));
    engine.visibleRange.mockReturnValue(null);
    engine.createChart.mockReturnValue({
      addSeries: (type: string) => ({
        setData: type === 'Candlestick' ? engine.setCandles : engine.setVolumes,
        update: type === 'Candlestick' ? engine.updateCandle : engine.updateVolume,
        priceScale: () => ({ applyOptions: vi.fn() }),
      }),
      applyOptions: vi.fn(),
      timeScale: () => ({
        fitContent: vi.fn(),
        subscribeVisibleLogicalRangeChange: engine.subscribe,
        unsubscribeVisibleLogicalRangeChange: vi.fn(),
        getVisibleLogicalRange: engine.visibleRange,
        setVisibleLogicalRange: engine.setVisibleRange,
      }),
      remove: vi.fn(),
    });
  });

  it('excludes the real huge decimal without a setData assertion, clamping, or rewriting raw candles', () => {
    const candles = [candle(100), candle(160, { o: hugePrice, h: hugePrice, c: hugePrice }),
      candle(220, { o: '0.02', c: '0.021' })];
    const original = structuredClone(candles);
    expect(Number(hugePrice)).toBe(3.776570421343502e+68);

    expect(() => render(<CandleChart symbol="HUGE" candles={candles} />)).not.toThrow();

    expect(engine.setCandles).toHaveBeenLastCalledWith([
      { time: 100, open: 0.0184, high: 0.022, low: 0.017, close: 0.0195 },
      { time: 220, open: 0.0195, high: 0.022, low: 0.017, close: 0.021 },
    ]);
    expect(engine.setVolumes.mock.lastCall?.[0].map((bar: ChartVolume) => bar.time)).toEqual([100, 220]);
    expect(candles).toEqual(original);
    expect(screen.getByRole('status')).toHaveTextContent('部分 K 线点无法渲染，已排除 1 个');
    expect(screen.getByRole('status')).toBeVisible();
  });

  it.each(['o', 'h', 'l', 'c'] as const)('checks %s independently for finite, positive, in-range conversion', (field) => {
    const invalid = [hugePrice, '90071992547410', '1e309', 'NaN', 'Infinity', '-Infinity', '0', '-1', '1e-400'];
    const candles = [candle(100), ...invalid.map((value, index) => candle(160 + index * 60, { [field]: value }))];

    expect(() => render(<CandleChart symbol="HUGE" candles={candles} />)).not.toThrow();

    expect(engine.setCandles.mock.lastCall?.[0]).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent(`已排除 ${invalid.length} 个`);
  });

  it('keeps an empty chart and an explicit notice when every candle is huge or non-finite', () => {
    const candles = [candle(100, { o: hugePrice }), candle(160, { h: '1e309' }),
      candle(220, { l: 'NaN' }), candle(280, { c: 'Infinity' })];

    expect(() => render(<CandleChart symbol="HUGE" candles={candles} />)).not.toThrow();

    expect(engine.setCandles).toHaveBeenLastCalledWith([]);
    expect(engine.setVolumes).toHaveBeenLastCalledWith([]);
    expect(screen.getByLabelText('HUGE K 线图')).toBeInTheDocument();
    expect(screen.getByText('暂无可渲染 K 线')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('已排除 4 个');
  });

  it('preserves boundary prices and small positive prices exactly, with no notice for valid bars', () => {
    const prices = ['90071992547409.91', '0.000000000000000001', '0.018456789123456789'];
    const candles = prices.map((price, index) => candle(100 + index * 60, { o: price, h: price, l: price, c: price }));

    render(<CandleChart symbol="VALID" candles={candles} />);

    expect(engine.setCandles).toHaveBeenLastCalledWith([
      { time: 100, open: Number(prices[0]), high: Number(prices[0]), low: Number(prices[0]), close: Number(prices[0]) },
      { time: 160, open: Number(prices[0]), high: Number(prices[0]), low: Number(prices[1]), close: Number(prices[1]) },
      { time: 220, open: Number(prices[1]), high: Number(prices[2]), low: Number(prices[1]), close: Number(prices[2]) },
    ]);
    expect(candles.map((bar) => bar.o)).toEqual(prices);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('filters unsafe histogram values independently without discarding valid OHLC bars or substituting volume', () => {
    const volumes = ['0', '0.42', '90071992547409.91', hugePrice, 'NaN', '1e309', '-1', null];
    render(<CandleChart symbol="VALID" candles={volumes.map((quoteVolume, index) => candle(100 + index * 60, { quoteVolume }))} />);

    expect(engine.setCandles.mock.lastCall?.[0]).toHaveLength(volumes.length);
    expect(engine.setVolumes).toHaveBeenLastCalledWith([
      { time: 100, value: 0, color: '#39d98a55' },
      { time: 160, value: 0.42, color: '#39d98a55' },
      { time: 220, value: chartBound, color: '#39d98a55' },
    ]);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('handles live invalid bars and their recovery without asserting in update or losing valid history', () => {
    const { rerender } = render(<CandleChart symbol="LIVE" candles={[candle(100)]} />);
    expect(() => rerender(<CandleChart symbol="LIVE" candles={[candle(100), candle(160, { o: hugePrice })]} />)).not.toThrow();
    expect(screen.getByRole('status')).toHaveTextContent('已排除 1 个');
    expect(engine.updateCandle.mock.calls.every(([bar]) => bar.time === 100)).toBe(true);

    rerender(<CandleChart symbol="LIVE" candles={[candle(100), candle(160)]} />);
    expect(engine.updateCandle).toHaveBeenCalledWith({ time: 160, open: 0.0195, high: 0.022, low: 0.017, close: 0.0195 });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('replaces historical membership when a bar becomes non-renderable and another recovers at the same count', () => {
    const { rerender } = render(<CandleChart symbol="LIVE" candles={[candle(100), candle(160, { o: hugePrice }), candle(220)]} />);
    rerender(<CandleChart symbol="LIVE" candles={[candle(100, { o: hugePrice }), candle(160), candle(220)]} />);

    expect(engine.setCandles.mock.lastCall?.[0].map((bar: ChartCandle) => bar.time)).toEqual([160, 220]);
    expect(engine.setVolumes.mock.lastCall?.[0].map((bar: ChartVolume) => bar.time)).toEqual([160, 220]);
    expect(screen.getByRole('status')).toHaveTextContent('已排除 1 个');
  });

  it('clears previously visible bars if all become non-renderable, then recovers', () => {
    const { rerender } = render(<CandleChart symbol="LIVE" candles={[candle(100)]} />);
    rerender(<CandleChart symbol="LIVE" candles={[candle(100, { c: hugePrice })]} />);
    expect(engine.setCandles).toHaveBeenLastCalledWith([]);
    expect(engine.setVolumes).toHaveBeenLastCalledWith([]);
    rerender(<CandleChart symbol="LIVE" candles={[candle(100)]} />);
    expect(engine.setCandles.mock.lastCall?.[0]).toHaveLength(1);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('adds newly renderable historical volume even when the previous histogram was empty', () => {
    const { rerender } = render(<CandleChart symbol="LIVE" candles={[candle(100, { quoteVolume: hugePrice }), candle(160, { quoteVolume: null })]} />);
    rerender(<CandleChart symbol="LIVE" candles={[candle(100, { quoteVolume: '0.42' }), candle(160, { quoteVolume: null })]} />);

    expect(engine.setVolumes).toHaveBeenLastCalledWith([{ time: 100, value: 0.42, color: '#39d98a55' }]);
    expect(engine.setCandles.mock.lastCall?.[0]).toHaveLength(2);
  });

  it('removes a live histogram bar when its volume becomes non-renderable while preserving its OHLC', () => {
    const { rerender } = render(<CandleChart symbol="LIVE" candles={[candle(100), candle(160)]} />);
    expect(() => rerender(<CandleChart symbol="LIVE" candles={[candle(100), candle(160, { quoteVolume: hugePrice })]} />)).not.toThrow();

    expect(engine.setVolumes).toHaveBeenLastCalledWith([{ time: 100, value: 0.42, color: '#39d98a55' }]);
    expect(engine.setCandles.mock.lastCall?.[0]).toHaveLength(2);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('preserves the viewport using only newly rendered history while loading from the original earliest timestamp', async () => {
    const onLoadBefore = vi.fn(async () => ({ added: 2, exhausted: false }));
    const { rerender } = render(<CandleChart symbol="HISTORY" candles={[candle(100, { o: hugePrice }), candle(160), candle(220)]} onLoadBefore={onLoadBefore} />);
    fireEvent.pointerDown(screen.getByTestId('tradingview-chart'));
    engine.subscribe.mock.lastCall?.[0]({ from: 0, to: 2 });
    await waitFor(() => expect(onLoadBefore).toHaveBeenCalledWith(99));
    engine.visibleRange.mockReturnValue({ from: 0, to: 2 });

    rerender(<CandleChart symbol="HISTORY" candles={[candle(40), candle(70, { o: hugePrice }), candle(100, { o: hugePrice }), candle(160), candle(220)]} onLoadBefore={onLoadBefore} />);

    expect(engine.setCandles.mock.lastCall?.[0].map((bar: ChartCandle) => bar.time)).toEqual([40, 160, 220]);
    expect(engine.setVisibleRange).toHaveBeenLastCalledWith({ from: 1, to: 3 });
    expect(screen.getByRole('status')).toHaveTextContent('已排除 2 个');
  });
});
