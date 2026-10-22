import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { Candle } from "./types";

const chart = vi.hoisted(() => ({ setData: vi.fn() }));
vi.mock("lightweight-charts", () => ({
  CandlestickSeries: "Candlestick",
  HistogramSeries: "Histogram",
  ColorType: { Solid: "solid" },
  CrosshairMode: { Normal: 0 },
  createChart: () => ({
    addSeries: () => ({
      setData: chart.setData,
      update: vi.fn(),
      priceScale: () => ({ applyOptions: vi.fn() }),
    }),
    applyOptions: vi.fn(),
    remove: vi.fn(),
    timeScale: () => ({
      fitContent: vi.fn(),
      subscribeVisibleLogicalRangeChange: vi.fn(),
      unsubscribeVisibleLogicalRangeChange: vi.fn(),
      getVisibleLogicalRange: () => null,
      setVisibleLogicalRange: vi.fn(),
    }),
  }),
}));

const address = `0x${"1".repeat(40)}`;
const token = {
  chainId: 4663,
  tokenAddress: address,
  symbol: "HUGE",
  name: "Huge Candle",
  launchpad: "PONS",
  stage: "GRADUATED",
  quoteAssetKey: "NATIVE",
  priceUsd: "0.0184",
  priceQuote: "0.0184",
  marketCapUsd: "1000",
  volume24hUsd: "100",
  change5m: "1",
  change24h: "2",
  holders: 10,
  ageSeconds: 720,
  pool: { poolKey: "test-pool", poolType: "UNISWAP_V4", liquidityUsd: "1000" },
  tradeStatus: "TRADABLE",
  riskFlags: [],
  security: {
    isHoneypot: false,
    buyTaxPct: "0",
    sellTaxPct: "0",
    liquidityLocked: true,
    liquidityLockedPct: "100",
    liquidityBurnedPct: "0",
  },
};
const huge: Candle = {
  t: 100,
  o: "3.776570421343502e68",
  h: "3.776570421343502e68",
  l: "3.776570421343502e68",
  c: "3.776570421343502e68",
  previousClose: null,
  baseVolume: null,
  quoteVolume: null,
  revision: "1",
};

function renderMarket(items: Candle[], partial: boolean, emptyDirectory = false) {
  vi.stubGlobal("WebSocket", undefined);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    let result: unknown;
    if (url.endsWith("/config"))
      result = {
        chainId: 4663,
        chainName: "Test",
        explorerBaseUrl: "https://example.com",
        defaultSlippageBps: 300,
        marketRefreshMs: { hot: 14_400_000, new: 300_000 },
      };
    else if (url.includes("/markets"))
      result = { items: emptyDirectory ? [] : [token], stale: false };
    else if (url.endsWith(`/tokens/${address}`)) result = token;
    else if (url.includes("/candles"))
      result = {
        chainId: 4663,
        tokenAddress: address,
        marketKey: "USD:USDG",
        interval: new URL(url).searchParams.get("interval"),
        syncStatus: "READY",
        availability: partial ? "PARTIAL" : "COMPLETE",
        coverage: { from: 100, to: 220 },
        gaps: partial ? [{ from: 1, to: 99, reason: "EVENT_EXPIRED" }] : [],
        revision: "1",
        asOfBlock: 100,
        source: "CHAIN",
        items,
      };
    else if (url.includes("/trades?")) result = { items: [], nextCursor: null };
    else if (url.endsWith("/get-nonce"))
      return new Response(
        JSON.stringify({ rc: 1, mc: "ACCOUNT_UNAVAILABLE", ma: ["测试账户不可用"] }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    else throw new Error(`Unexpected request ${url}`);
    return new Response(JSON.stringify({ rc: 0, mc: "SUCCESS", ma: [], result }), {
      headers: { "content-type": "application/json" },
    });
  });
  return render(<App />);
}

describe("App candle renderability", () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    chart.setData.mockClear();
  });

  it("opens and reloads stored history from a full token link with an empty directory", async () => {
    window.history.replaceState(null, "", `/?chainId=4663&token=${address}`);
    const bars = [{ ...huge, o: "1", h: "2", l: "0.5", c: "1.5" }];
    renderMarket(bars, true, true);
    await waitFor(() =>
      expect(screen.getByTestId("tradingview-chart")).toHaveAttribute("data-candle-count", "1"),
    );
    cleanup();
    renderMarket(bars, true, true);
    await waitFor(() =>
      expect(screen.getByTestId("tradingview-chart")).toHaveAttribute("data-candle-count", "1"),
    );
    expect(screen.queryByRole("button", { name: "查看 HUGE" })).not.toBeInTheDocument();
  });

  it("filters unrenderable candles without render or partial-history warnings", async () => {
    renderMarket(
      [huge, { ...huge, t: 160, o: "1", h: "2", l: "0.5", c: "1.5", previousClose: null }],
      true,
    );

    await waitFor(() =>
      expect(screen.getByTestId("tradingview-chart")).toHaveAttribute("data-candle-count", "1"),
    );
    expect(screen.queryByText(/无法渲染|已排除|部分历史行情|最后可用行情/)).not.toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "行情状态" })).not.toBeInTheDocument();
    expect(screen.getByTestId("tradingview-chart")).toHaveAttribute("data-candle-count", "1");
  });

  it("keeps the detail, markets, and interval controls usable when no candles can render", async () => {
    renderMarket([huge, { ...huge, t: 160, c: "1e309" }], false);

    expect(await screen.findByText("暂无可渲染 K 线")).toBeVisible();
    expect(screen.queryByText(/已排除/)).not.toBeInTheDocument();
    expect(screen.getByText("暂无可渲染 K 线")).toBeVisible();
    expect(screen.getByTestId("current-price")).toBeVisible();
    expect(screen.getByRole("button", { name: "查看 HUGE" })).toBeEnabled();
    expect(screen.getByRole("region", { name: "实时成交" })).toBeVisible();
    expect(chart.setData.mock.calls.every(([bars]) => bars.length === 0)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "15m" }));
    expect(await screen.findByText("暂无可渲染 K 线")).toBeVisible();
    expect(screen.queryByText(/已排除/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "15m" })).toHaveClass("active");
  });
});
