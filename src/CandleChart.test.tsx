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
  const cleanScenario1 = cleanup;
  afterEach(cleanScenario1);
  const prepareScenario2 = () => {
    vi.clearAllMocks();
  };
  beforeEach(prepareScenario2);

  it("CandleChart: 3 related scenarios", async () => {
    // enables TradingView drag and zoom controls and loads OHLCV data
    await (async () => {
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
              previousClose: null,
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
              previousClose: "0.018",
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
    })();
    await cleanScenario1();
    await prepareScenario2();
    // initializes the chart even when the token has no trades yet
    await (async () => {
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

      const { rerender } = render(<CandleChart symbol="NEW" candles={[]} />);

      expect(screen.getByTestId("tradingview-chart")).toBeInTheDocument();
      expect(screen.getByText("No candles")).toBeInTheDocument();
      expect(chartMocks.setData).toHaveBeenCalledWith([]);
      rerender(<CandleChart symbol="NEW" candles={[]} failed />);
      expect(screen.queryByText("No candles")).not.toBeInTheDocument();
    })();
    await cleanScenario1();
    await prepareScenario2();
    // shows a compact animated status while Bitquery history is loading
    await (async () => {
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
      expect(screen.queryByText("No candles")).not.toBeInTheDocument();

      expect(
        screen.getByRole("status", { name: "Loading candles" }).querySelectorAll("span"),
      ).toHaveLength(3);
    })();
  });
});

describe("visible-range left history", () => {
  const candles = [100, 160].map((t) => ({
    t,
    o: "1",
    h: "1",
    l: "1",
    c: "1",
    previousClose: null,
    baseVolume: "1",
    quoteVolume: "1",
    revision: "1",
  }));
  const cleanScenario3 = () => {
    cleanup();
    vi.restoreAllMocks();
  };
  afterEach(cleanScenario3);
  const prepareScenario4 = () => {
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
  };
  beforeEach(prepareScenario4);
  it("visible-range left history: 4 related scenarios", async () => {
    // automatically fills a sparse view; coalesces and exhausts requests
    await (async () => {
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
    })();
    await cleanScenario3();
    await prepareScenario4();
    // retries a nonterminal zero only after a later interaction and loads older bars
    await (async () => {
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
      expect(screen.getByTestId("tradingview-chart")).toHaveAttribute(
        "data-first-candle-time",
        "40",
      );
      act(() => range({ from: 0, to: 10 }));
      expect(load).toHaveBeenLastCalledWith(39);
    })();
    await cleanScenario3();
    await prepareScenario4();
    // prepends genuinely older bars and preserves the viewport
    await (async () => {
      const { rerender } = render(<CandleChart symbol="A" candles={candles} />);
      const creations = chartMocks.createChart.mock.calls.length;
      rerender(<CandleChart symbol="A" candles={[{ ...candles[0]!, t: 40 }, ...candles]} />);
      expect(chartMocks.createChart).toHaveBeenCalledTimes(creations);
      expect(chartMocks.setData).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ time: 40 })]),
      );
      expect(chartMocks.setVisibleRange).toHaveBeenCalledWith({ from: 1, to: 3 });
    })();
    await cleanScenario3();
    await prepareScenario4();
    // a token/interval remount clears exhaustion and unsubscribes the previous handler
    await (async () => {
      const { act, fireEvent } = await import("@testing-library/react");
      const load = vi.fn(async () => ({ added: 0, exhausted: true }));
      const { rerender } = render(
        <CandleChart key="A:1m" symbol="A" candles={candles} onLoadBefore={load} />,
      );
      fireEvent.wheel(screen.getByTestId("tradingview-chart"));
      await act(async () =>
        chartMocks.subscribeVisibleRange.mock.calls[0]![0]({ from: 0, to: 10 }),
      );
      rerender(<CandleChart key="B:15m" symbol="B" candles={candles} onLoadBefore={load} />);
      expect(chartMocks.unsubscribeVisibleRange).toHaveBeenCalledTimes(1);
      fireEvent.wheel(screen.getByTestId("tradingview-chart"));
      await act(async () =>
        chartMocks.subscribeVisibleRange.mock.calls[1]![0]({ from: 0, to: 10 }),
      );
      expect(load).toHaveBeenCalledTimes(2);
    })();
  });
});
