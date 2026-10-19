import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CandleChart } from "./CandleChart";

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

vi.mock("lightweight-charts", () => ({
  CandlestickSeries: "Candlestick",
  HistogramSeries: "Histogram",
  ColorType: { Solid: "solid" },
  CrosshairMode: { Normal: 0 },
  createChart: chartMocks.createChart,
}));

describe("CandleChart", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enables TradingView drag and zoom controls and loads OHLCV data", () => {
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

    render(
      <CandleChart
        symbol="CASHCAT"
        candles={[
          {
            t: 1_789_600_000,
            o: "0.018",
            h: "0.018",
            l: "0.018",
            c: "0.018",
            baseVolume: "1200",
            quoteVolume: "0.42",
            revision: "1",
          },
          {
            t: 1_789_600_002,
            o: "0.0184",
            h: "0.0184",
            l: "0.0184",
            c: "0.0184",
            baseVolume: "900",
            quoteVolume: "0.31",
            revision: "1",
          },
        ]}
      />,
    );

    expect(screen.getByTestId("tradingview-chart")).toBeInTheDocument();
    expect(chartMocks.createChart).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({
        handleScroll: expect.objectContaining({ mouseWheel: true, pressedMouseMove: true }),
        handleScale: expect.objectContaining({ mouseWheel: true, pinch: true }),
        timeScale: expect.objectContaining({ barSpacing: 3, minBarSpacing: 0.5 }),
      }),
    );
    expect(chartMocks.setData).toHaveBeenCalled();
    expect(chartMocks.setData.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ time: 1_789_600_000 }),
      expect.objectContaining({ time: 1_789_600_002, open: 0.018, low: 0.018, close: 0.0184 }),
    ]);
    expect(chartMocks.fitContent).toHaveBeenCalled();
  });

  it("initializes the chart even when the token has no trades yet", () => {
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

    expect(screen.getByTestId("tradingview-chart")).toBeInTheDocument();
    expect(screen.getByText("暂无成交 K 线")).toBeInTheDocument();
    expect(chartMocks.setData).toHaveBeenCalledWith([]);
  });

  it("shows a compact animated status while Bitquery history is loading", () => {
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

    render(<CandleChart symbol="JEV" candles={[]} refreshing />);

    expect(
      screen.getByRole("status", { name: "正在加载行情" }).querySelectorAll("span"),
    ).toHaveLength(3);
  });
});

describe("visible-range left history", () => {
  const candles = [100, 160].map((t) => ({
    t,
    o: "1",
    h: "1",
    l: "1",
    c: "1",
    baseVolume: "1",
    quoteVolume: "1",
    revision: "1",
  }));
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    chartMocks.createChart.mockReturnValue({
      addSeries: () => ({
        setData: chartMocks.setData,
        update: chartMocks.update,
        priceScale: () => ({ applyOptions: vi.fn() }),
      }),
      applyOptions: vi.fn(),
      remove: vi.fn(),
      timeScale: () => ({
        fitContent: chartMocks.fitContent,
        subscribeVisibleLogicalRangeChange: chartMocks.subscribeVisibleRange,
        unsubscribeVisibleLogicalRangeChange: chartMocks.unsubscribeVisibleRange,
        getVisibleLogicalRange: () => ({ from: 0, to: 2 }),
        setVisibleLogicalRange: chartMocks.setVisibleRange,
      }),
    });
  });
  it("automatically fills a sparse view; coalesces and exhausts requests", async () => {
    const { act, fireEvent } = await import("@testing-library/react");
    let finish!: (result: { added: number; exhausted: boolean }) => void;
    const load = vi.fn(
      () =>
        new Promise<{ added: number; exhausted: boolean }>((resolve) => {
          finish = resolve;
        }),
    );
    render(<CandleChart symbol="A" candles={candles} onLoadBefore={load} />);
    const range = chartMocks.subscribeVisibleRange.mock.calls[0]![0];
    act(() => range({ from: 0, to: 10 }));
    expect(load).toHaveBeenCalledExactlyOnceWith(99);
    fireEvent.wheel(screen.getByTestId("tradingview-chart"));
    act(() => range({ from: 8, to: 10 }));
    expect(load).toHaveBeenCalledTimes(1);
    act(() => {
      range({ from: 0, to: 10 });
      range({ from: -1, to: 10 });
    });
    expect(load).toHaveBeenCalledExactlyOnceWith(99);
    await act(async () => finish({ added: 0, exhausted: true }));
    act(() => range({ from: -2, to: 10 }));
    fireEvent.wheel(screen.getByTestId("tradingview-chart"));
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("retries a nonterminal zero only after a later interaction and loads older bars", async () => {
    const { act, fireEvent } = await import("@testing-library/react");
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let finish!: (result: { added: number; exhausted: boolean }) => void;
    const load = vi.fn(
      () =>
        new Promise<{ added: number; exhausted: boolean }>((resolve) => {
          finish = resolve;
        }),
    );
    const { rerender } = render(<CandleChart symbol="A" candles={candles} onLoadBefore={load} />);
    const canvas = screen.getByTestId("tradingview-chart");
    const range = chartMocks.subscribeVisibleRange.mock.calls[0]![0];
    fireEvent.wheel(canvas);
    act(() => {
      range({ from: 0, to: 10 });
      range({ from: -1, to: 10 });
    });
    expect(load).toHaveBeenCalledExactlyOnceWith(99);
    await act(async () => finish({ added: 0, exhausted: false }));
    act(() => range({ from: 0, to: 10 }));
    fireEvent.wheel(canvas);
    expect(load).toHaveBeenCalledTimes(1);
    now += 1_000;
    fireEvent.wheel(canvas);
    expect(load).toHaveBeenCalledTimes(2);
    act(() => range({ from: -1, to: 10 }));
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => finish({ added: 1, exhausted: false }));
    rerender(
      <CandleChart
        symbol="A"
        candles={[{ ...candles[0]!, t: 40 }, ...candles]}
        onLoadBefore={load}
      />,
    );
    expect(screen.getByTestId("tradingview-chart")).toHaveAttribute("data-first-candle-time", "40");
    act(() => range({ from: 0, to: 10 }));
    expect(load).toHaveBeenLastCalledWith(39);
  });
  it("prepends genuinely older bars and preserves the viewport", async () => {
    const { rerender } = render(<CandleChart symbol="A" candles={candles} />);
    rerender(<CandleChart symbol="A" candles={[{ ...candles[0]!, t: 40 }, ...candles]} />);
    expect(chartMocks.setData).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ time: 40 })]),
    );
    expect(chartMocks.setVisibleRange).toHaveBeenCalledWith({ from: 1, to: 3 });
  });
  it("a token/interval remount clears exhaustion and unsubscribes the previous handler", async () => {
    const { act, fireEvent } = await import("@testing-library/react");
    const load = vi.fn(async () => ({ added: 0, exhausted: true }));
    const { rerender } = render(
      <CandleChart key="A:1m" symbol="A" candles={candles} onLoadBefore={load} />,
    );
    fireEvent.wheel(screen.getByTestId("tradingview-chart"));
    await act(async () => chartMocks.subscribeVisibleRange.mock.calls[0]![0]({ from: 0, to: 10 }));
    rerender(<CandleChart key="B:15m" symbol="B" candles={candles} onLoadBefore={load} />);
    expect(chartMocks.unsubscribeVisibleRange).toHaveBeenCalledTimes(1);
    fireEvent.wheel(screen.getByTestId("tradingview-chart"));
    await act(async () => chartMocks.subscribeVisibleRange.mock.calls[1]![0]({ from: 0, to: 10 }));
    expect(load).toHaveBeenCalledTimes(2);
  });
});
