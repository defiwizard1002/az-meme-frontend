import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CandleChart } from './CandleChart';

const chartMocks = vi.hoisted(() => ({
  createChart: vi.fn(),
  setData: vi.fn(),
  update: vi.fn(),
  fitContent: vi.fn(),
  subscribeVisibleRange: vi.fn(),
  unsubscribeVisibleRange: vi.fn(),
  getVisibleRange: vi.fn(() => null),
  setVisibleRange: vi.fn(),
}));

vi.mock('lightweight-charts', () => ({
  CandlestickSeries: 'Candlestick',
  HistogramSeries: 'Histogram',
  ColorType: { Solid: 'solid' },
  CrosshairMode: { Normal: 0 },
  createChart: chartMocks.createChart,
}));

describe('CandleChart', () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enables TradingView drag and zoom controls and loads OHLCV data', () => {
    chartMocks.createChart.mockReturnValue({
      addSeries: vi.fn(() => ({
        setData: chartMocks.setData,
        update: chartMocks.update,
        priceScale: () => ({ applyOptions: vi.fn() }),
      })),
      applyOptions: vi.fn(),
      timeScale: () => ({
        fitContent: chartMocks.fitContent,
        subscribeVisibleLogicalRangeChange: chartMocks.subscribeVisibleRange,
        unsubscribeVisibleLogicalRangeChange: chartMocks.unsubscribeVisibleRange,
        getVisibleLogicalRange: chartMocks.getVisibleRange,
        setVisibleLogicalRange: chartMocks.setVisibleRange,
      }),
      remove: vi.fn(),
    });

    render(<CandleChart symbol="CASHCAT" candles={[
      {
        t: 1_789_600_000,
        o: '0.018',
        h: '0.018',
        l: '0.018',
        c: '0.018',
        baseVolume: '1200',
        quoteVolume: '0.42',
        revision: 1,
      },
      {
        t: 1_789_600_002,
        o: '0.0184',
        h: '0.0184',
        l: '0.0184',
        c: '0.0184',
        baseVolume: '900',
        quoteVolume: '0.31',
        revision: 1,
      },
    ]} />);

    expect(screen.getByTestId('tradingview-chart')).toBeInTheDocument();
    expect(chartMocks.createChart).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({
      handleScroll: expect.objectContaining({ mouseWheel: true, pressedMouseMove: true }),
      handleScale: expect.objectContaining({ mouseWheel: true, pinch: true }),
    }));
    expect(chartMocks.setData).toHaveBeenCalled();
    expect(chartMocks.setData.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ time: 1_789_600_000 }),
      expect.objectContaining({ time: 1_789_600_002, open: 0.018, low: 0.018 }),
    ]);
    expect(chartMocks.fitContent).toHaveBeenCalled();
  });

  it('initializes the chart even when the token has no trades yet', () => {
    chartMocks.createChart.mockReturnValue({
      addSeries: vi.fn(() => ({
        setData: chartMocks.setData,
        update: chartMocks.update,
        priceScale: () => ({ applyOptions: vi.fn() }),
      })),
      applyOptions: vi.fn(),
      timeScale: () => ({
        fitContent: chartMocks.fitContent,
        subscribeVisibleLogicalRangeChange: chartMocks.subscribeVisibleRange,
        unsubscribeVisibleLogicalRangeChange: chartMocks.unsubscribeVisibleRange,
        getVisibleLogicalRange: chartMocks.getVisibleRange,
        setVisibleLogicalRange: chartMocks.setVisibleRange,
      }),
      remove: vi.fn(),
    });

    render(<CandleChart symbol="NEW" candles={[]} />);

    expect(screen.getByTestId('tradingview-chart')).toBeInTheDocument();
    expect(screen.getByText('暂无成交 K 线')).toBeInTheDocument();
    expect(chartMocks.setData).toHaveBeenCalledWith([]);
  });
});
