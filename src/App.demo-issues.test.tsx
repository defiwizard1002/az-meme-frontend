import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { ApiError, memeApi } from "./api";
vi.mock("lightweight-charts", () => ({
  CandlestickSeries: "c",
  HistogramSeries: "v",
  ColorType: { Solid: "solid" },
  CrosshairMode: { Normal: 0 },
  createChart: () => ({
    addSeries: () => ({
      setData: vi.fn(),
      update: vi.fn(),
      priceScale: () => ({ applyOptions: vi.fn() }),
    }),
    applyOptions: vi.fn(),
    remove: vi.fn(),
    timeScale: () => ({
      fitContent: vi.fn(),
      getVisibleLogicalRange: () => null,
      setVisibleLogicalRange: vi.fn(),
      subscribeVisibleLogicalRangeChange: vi.fn(),
      unsubscribeVisibleLogicalRangeChange: vi.fn(),
    }),
  }),
}));
const token = {
  chainId: 4663,
  tokenAddress: `0x${"1".repeat(40)}`,
  symbol: "PONS",
  name: "Pons",
  launchpad: "PONS",
  stage: "GRADUATED",
  quoteAssetKey: "NATIVE",
  priceQuote: "0",
  priceUsd: "1",
  marketCapUsd: "1",
  volume24hUsd: "1",
  change5m: "0",
  change24h: "0",
  holders: 1,
  ageSeconds: 1,
  pool: { poolKey: "source-pool", poolType: "UNSUPPORTED", liquidityUsd: "1" },
  tradeStatus: "UNSUPPORTED_POOL_TYPE",
  riskFlags: [],
  security: {
    isHoneypot: null,
    buyTaxPct: null,
    sellTaxPct: null,
    liquidityLocked: null,
    liquidityLockedPct: null,
    liquidityBurnedPct: null,
  },
};
const envelope = (result: unknown) => new Response(JSON.stringify({ rc: 0, result }));
function setup() {
  vi.stubGlobal("WebSocket", undefined);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const u = new URL(String(input));
    let result: unknown;
    if (u.pathname.endsWith("/config"))
      result = {
        chainId: 4663,
        chainName: "Test",
        accountMode: "MAIN_ACCOUNT_POC",
        settlementAssets: ["USDG", "ETH", "WETH"],
        defaultSlippageBps: 300,
        marketRefreshMs: { hot: 14400000, new: 300000 },
      };
    else if (u.pathname.endsWith("/markets")) result = { items: [token], stale: false };
    else if (u.pathname.endsWith("/summary"))
      result = { quoteBalances: [{ asset: "USDG", available: "10", frozen: "0" }], positions: [] };
    else if (
      u.pathname.endsWith("/orders") ||
      u.pathname.endsWith("/transactions") ||
      u.pathname.endsWith("/trades")
    )
      result = { items: [], nextCursor: null };
    else if (u.pathname.endsWith("/candles"))
      result = {
        chainId: 4663,
        tokenAddress: token.tokenAddress,
        marketKey: "USD:USDG",
        interval: u.searchParams.get("interval"),
        syncStatus: "READY",
        availability: "COMPLETE",
        gaps: [],
        coverage: { from: 1, to: 1 },
        revision: "1",
        asOfBlock: 1,
        source: "CHAIN",
        items: [],
      };
    else if (u.pathname.endsWith("/quotes"))
      result = {
        ...JSON.parse(String(init?.body)),
        quoteId: "q",
        expectedAmountOut: "1",
        minAmountOut: "0.97",
        expiresAt: Date.now() + 30000,
        routePools: [{ poolKey: "actual-v3", poolType: "UNISWAP_V3" }],
        routeAssets: [{ address: token.tokenAddress, symbol: "PONS" }],
        fees: [],
      };
    else result = token;
    return envelope(result);
  });
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("demo issues regression", () => {
  it("product recovery explains empty syncing charts using actual last trade time", async () => {
    setup();
    vi.spyOn(memeApi, "getCandles").mockResolvedValue({
      chainId: 4663,
      tokenAddress: token.tokenAddress,
      marketKey: "USD:USDG",
      interval: "1m",
      source: "CHAIN",
      syncStatus: "BACKFILLING",
      availability: "PARTIAL",
      coverage: { from: null, to: null },
      gaps: [],
      revision: "1",
      asOfBlock: 1,
      items: [],
    });
    vi.spyOn(memeApi, "getTrades").mockResolvedValue({
      items: [
        {
          tradeId: "real",
          t: 1791712814,
          side: "BUY",
          priceUsd: "1",
          baseAmount: "1",
          quoteAmount: "1",
          quoteAsset: "USDG",
          trader: token.tokenAddress,
          txHash: "tx",
        },
      ],
      nextCursor: null,
    });
    render(<App />);
    await screen.findByText("主账户已连接");
    await act(async () => {});
    expect(screen.queryByRole("status", { name: "行情状态" })).not.toBeInTheDocument();
    expect(screen.getByRole("figure")).toHaveAttribute("aria-busy", "true");
    expect(document.body).not.toHaveTextContent(/BACKFILLING|cursor|raw/);
  });
  it("product recovery hides intermediate route assets while preserving final output without obsolete split notes", async () => {
    setup();
    vi.spyOn(memeApi, "createQuote").mockImplementation(
      async (input) =>
        ({
          ...input,
          quoteId: "split",
          expectedAmountOut: "100",
          minAmountOut: "94.09",
          expiresAt: Date.now() + 30000,
          routePools: [
            { poolKey: "first", poolType: "UNISWAP_V3" },
            { poolKey: "second", poolType: "UNISWAP_V4" },
          ],
          routeAssets: [
            { address: "a", symbol: "USDG", decimals: 18 },
            { address: "b", symbol: "WETH", decimals: 18 },
            { address: token.tokenAddress, symbol: "PONS", decimals: 18 },
          ],
          fees: [],
        }) as never,
    );
    render(<App />);
    await screen.findByText("主账户已连接");
    await act(async () => {});
    expect(document.querySelector(".quote-details")).not.toHaveTextContent(/路由|→|WETH/);
    expect(document.querySelector(".quote-details")).toHaveTextContent("100 PONS");
    fireEvent.click(document.querySelector("button.primary")!);
    await act(async () => {});
    expect(memeApi.createQuote).toHaveBeenLastCalledWith(
      expect.objectContaining({ purpose: "PREPARE_EXECUTION", minAmountOut: "94.09" }),
    );
    expect(
      screen.queryByText("交易可能分步完成；中途失败时，已成交部分不会撤销。"),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("滑点设置")).not.toBeInTheDocument();
  });
  it("shows token identity and unknown protocol without exposing internal pool labels", async () => {
    setup();
    render(<App />);
    await screen.findByText("主账户已连接");
    await act(async () => {});
    const title = document.querySelector(".token-title")!;
    expect(title).toHaveTextContent("协议未知");
    expect(title).toHaveTextContent("当前资产可报价");
    expect(title.querySelector("strong")).toHaveTextContent(/^PONS$/);
    expect(title).not.toHaveTextContent("来源池");
    expect(title).not.toHaveTextContent("UNSUPPORTED");
  });
  it("hides coverage internals and route hops while preserving actionable failures and quote limits", async () => {
    setup();
    vi.spyOn(memeApi, "getCandles").mockResolvedValue({
      chainId: 4663,
      tokenAddress: token.tokenAddress,
      marketKey: "USD:USDG",
      interval: "1m",
      source: "CHAIN",
      syncStatus: "READY",
      availability: "PARTIAL",
      coverage: { from: null, to: null },
      gaps: [{ from: 1, to: 2, reason: "BEFORE_SCAN_START" }],
      revision: "1",
      asOfBlock: 1,
      items: [],
    });
    vi.spyOn(memeApi, "createQuote").mockResolvedValue({
      chainId: 4663,
      tokenAddress: token.tokenAddress,
      settlementAsset: "USDG",
      side: "BUY",
      amountIn: "1",
      slippageBps: 300,
      quoteId: "q",
      expectedAmountOut: "1",
      minAmountOut: "0.97",
      expiresAt: Date.now() + 30000,
      routePools: [
        { poolKey: "first", poolType: "UNISWAP_V3" },
        { poolKey: "second", poolType: "UNISWAP_V4" },
      ],
      routeAssets: [],
      fees: [],
    } as never);
    render(<App />);
    await screen.findByText("主账户已连接");
    await act(async () => {});
    expect(document.body).not.toHaveTextContent("历史 K 线部分缺失");
    expect(document.body).not.toHaveTextContent("扫描起点");
    expect(document.body).not.toHaveTextContent(/第\s*\d+\s*跳|执行方式|每跳/);
    expect(screen.queryByText("最低得到")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("滑点设置")).not.toBeInTheDocument();
  });
  it("keeps configured fallback slippage and invalidates the quote when amount changes", async () => {
    setup();
    const quotes = vi.spyOn(memeApi, "createQuote");
    render(<App />);
    await screen.findByText("主账户已连接");
    await act(async () => {});
    const first = quotes.mock.calls.at(-1)![0];
    expect(first.slippageBps).toBe(2000);
    fireEvent.change(screen.getByLabelText("买入金额"), { target: { value: "2" } });
    await act(async () => {});
    expect(quotes.mock.calls.at(-1)?.[0]).toMatchObject({ amountIn: "2", slippageBps: 2000 });
    expect(quotes.mock.calls.at(-1)?.[0]).not.toBe(first);
  });
  it("keeps account connected and automatically retries records after a body timeout", async () => {
    vi.useFakeTimers();
    setup();
    const records = vi.spyOn(memeApi, "getAccountTransactions").mockResolvedValue({ items: [] });
    render(<App />);
    await act(async () => {});
    expect(screen.getByText("主账户已连接")).toBeInTheDocument();
    records.mockRejectedValueOnce(
      new ApiError("MEME_REQUEST_TIMEOUT", "HTTP 200: 请求超时，请稍后重试", 200),
    );
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(screen.getByText("主账户已连接")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "交易记录" }));
    expect(screen.getByRole("alert")).toHaveTextContent("交易记录刷新失败");
    expect(screen.getByRole("alert")).not.toHaveTextContent("账户请求失败");
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(records).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("keeps the initial chart mounted with an accessible loading overlay until the real request completes", async () => {
    setup();
    let finish!: (x: Response) => void;
    const fallback = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
      String(input).includes("/candles?")
        ? new Promise<Response>((r) => {
            finish = r;
          })
        : fallback(input, init),
    );
    render(<App />);
    await screen.findByText("主账户已连接");
    const canvas = screen.getByTestId("tradingview-chart");
    expect(screen.getByRole("figure")).toHaveAttribute("aria-busy", "true");
    expect(
      screen.getByRole("status", { name: "正在加载行情" }).querySelectorAll("span"),
    ).toHaveLength(3);
    await act(async () =>
      finish(
        envelope({
          chainId: 4663,
          tokenAddress: token.tokenAddress,
          marketKey: "USD:USDG",
          interval: "1m",
          syncStatus: "READY",
          availability: "COMPLETE",
          coverage: { from: null, to: null },
          gaps: [],
          revision: "1",
          asOfBlock: 1,
          source: "CHAIN",
          items: [],
        }),
      ),
    );
    expect(screen.getByTestId("tradingview-chart")).toBe(canvas);
    expect(screen.getByRole("figure")).toHaveAttribute("aria-busy", "false");
  });
  it("removes obsolete split notes while preserving the quote and trade action", async () => {
    setup();
    vi.spyOn(memeApi, "createQuote").mockImplementation(
      async (input) =>
        ({
          ...input,
          chainId: 4663,
          quoteId: "split",
          expectedAmountOut: "100",
          minAmountOut: "94.09",
          expiresAt: Date.now() + 30000,
          routePools: [
            { poolKey: "first", poolType: "UNISWAP_V3" },
            { poolKey: "second", poolType: "UNISWAP_V4" },
          ],
          routeAssets: [],
          fees: [],
        }) as never,
    );
    render(<App />);
    await screen.findByText("主账户已连接");
    await act(async () => {});
    expect(
      screen.queryByText("交易可能分步完成；中途失败时，已成交部分不会撤销。"),
    ).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/第\s*\d+\s*跳|执行方式|每跳|first|second/);
    expect(document.querySelector("button.primary")).toBeEnabled();
  });
  it("uses shared slippage without obsolete cumulative split notes", async () => {
    setup();
    vi.spyOn(memeApi, "createQuote").mockImplementation(
      async (input) =>
        ({
          ...input,
          chainId: 4663,
          quoteId: "split",
          expectedAmountOut: "100",
          minAmountOut: "94.09",
          expiresAt: Date.now() + 30000,
          routePools: [
            { poolKey: "first", poolType: "UNISWAP_V3" },
            { poolKey: "second", poolType: "UNISWAP_V4" },
          ],
          routeAssets: [],
          fees: [],
        }) as never,
    );
    render(<App />);
    await screen.findByText("主账户已连接");
    await act(async () => {});
    expect(screen.queryByLabelText("滑点设置")).not.toBeInTheDocument();
    expect(
      screen.queryByText("拆分执行时，累计滑点可能高于所设值；最终以最低得到为准。"),
    ).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("交易滑点上限");
    expect(document.querySelector(".quote-details")).toHaveTextContent("100 PONS");
    fireEvent.click(document.querySelector("button.primary")!);
    await act(async () => {});
    expect(memeApi.createQuote).toHaveBeenLastCalledWith(
      expect.objectContaining({ purpose: "PREPARE_EXECUTION", minAmountOut: "94.09" }),
    );
  });
});

it("holds positive small quantities in the UI and keeps the exact 100% sell input", async () => {
  setup();
  vi.spyOn(memeApi, "getAccount").mockResolvedValue({
    quoteBalances: [{ asset: "USDG", available: "10", frozen: "0" }],
    positions: [
      {
        tokenAddress: token.tokenAddress,
        symbol: "PONS",
        available: "0.003860795207337225",
        costUsd: "0",
        valueUsd: "0.001",
      },
      {
        tokenAddress: `0x${"2".repeat(40)}`,
        symbol: "DUST",
        available: "0.000006486365974824",
        costUsd: "0",
        valueUsd: "0.0009",
      },
    ],
  });
  render(<App />);
  await screen.findByText("主账户已连接");
  expect(screen.getByText("0.003 枚")).toBeInTheDocument();
  expect(screen.getByText("<0.001 枚")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "卖出" }));
  fireEvent.click(screen.getByRole("button", { name: "100%" }));
  expect(screen.getByRole("textbox", { name: "卖出数量" })).toHaveValue("0.003860795207337225");
});
