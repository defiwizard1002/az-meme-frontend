import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { ApiError, memeApi } from "./api";
import type { LocalEstimate, Quote } from "./types";

vi.mock("./CandleChart", () => ({ CandleChart: () => <div data-testid="chart" /> }));
const tokenAddress = `0x${"1".repeat(40)}`;
const bridgeAddress = `0x${"2".repeat(40)}`;
const inputAddress = `0x${"3".repeat(40)}`;
const token = {
  chainId: 4663,
  tokenAddress,
  symbol: "CAT",
  name: "Cat",
  launchpad: "PONS",
  stage: "GRADUATED",
  quoteAssetKey: "NATIVE",
  priceUsd: "0.1",
  marketCapUsd: "1",
  volume24hUsd: "1",
  change5m: "0",
  change24h: "0",
  holders: 1,
  ageSeconds: 1,
  pool: { poolKey: "display-source", poolType: "UNSUPPORTED", liquidityUsd: "1" },
  tradeStatus: "TRADABLE",
  riskFlags: [],
  security: {},
};
const minimum = "9.500000000000000001";
const estimate: LocalEstimate = {
  tokenAddress,
  side: "BUY",
  settlementAsset: "USDG",
  amountIn: "1",
  status: "LOCAL_ESTIMATE",
  requiresExecutionPreparation: true,
  precision: "CORE_CURVE_ESTIMATE",
  netRecipientGuaranteed: false,
  expectedAmountOut: "10.000000000000000002",
  expectedAmountOutAtomic: "10000000000000000002",
  outputDecimals: 18,
  minAmountOut: minimum,
  fees: [],
  expiresAt: Date.now() + 30_000,
};
function selectedRoute(): Quote {
  return {
    ...estimate,
    quoteId: "chosen-route",
    status: "PREPARED_ROUTE",
    simulationStatus: "NOT_SIMULATED",
    expiresAt: Date.now() + 15_000,
    routeFingerprint: "bound-route",
    routeAssets: [
      { address: inputAddress, symbol: "USDG", decimals: 18 },
      { address: bridgeAddress, symbol: "WETH", decimals: 18 },
      { address: tokenAddress, symbol: "CAT", decimals: 18 },
    ],
    routePools: [
      { poolKey: "actual-first", poolType: "UNISWAP_V3", liquidityUsd: "1" },
      { poolKey: "actual-second", poolType: "UNISWAP_V4", liquidityUsd: "1" },
    ],
    routeHops: [
      {
        poolKey: "actual-first",
        poolType: "UNISWAP_V3",
        venue: inputAddress,
        tokenIn: inputAddress,
        tokenOut: bridgeAddress,
      },
      {
        poolKey: "actual-second",
        poolType: "UNISWAP_V4",
        venue: bridgeAddress,
        tokenIn: bridgeAddress,
        tokenOut: tokenAddress,
      },
    ],
  };
}
const envelope = (result: unknown) => new Response(JSON.stringify({ rc: 0, result }));
function setup() {
  vi.stubGlobal("WebSocket", undefined);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/config"))
      return envelope({
        chainId: 4663,
        chainName: "Test",
        accountMode: "MAIN_ACCOUNT_POC",
        settlementAssets: ["USDG", "ETH"],
        defaultSlippageBps: 300,
        marketRefreshMs: { hot: 14400000, new: 300000 },
      });
    if (u.pathname.endsWith("/markets")) return envelope({ items: [token], stale: false });
    if (u.pathname.endsWith("/summary"))
      return envelope({
        quoteBalances: [{ asset: "USDG", available: "10", frozen: "0" }],
        positions: [],
      });
    if (/\/(orders|transactions|trades)$/.test(u.pathname))
      return envelope({ items: [], nextCursor: null });
    if (u.pathname.endsWith("/candles"))
      return envelope({
        chainId: 4663,
        tokenAddress,
        marketKey: "USD:USDG",
        interval: u.searchParams.get("interval"),
        syncStatus: "READY",
        availability: "COMPLETE",
        gaps: [],
        coverage: { from: null, to: null },
        revision: "1",
        asOfBlock: 1,
        source: "CHAIN",
        items: [],
      });
    return envelope(token);
  });
  const prepare = vi
    .spyOn(memeApi, "createQuote")
    .mockImplementation(async (request) =>
      request.purpose === "PREPARE_EXECUTION"
        ? { ...selectedRoute(), amountIn: request.amountIn, minAmountOut: request.minAmountOut! }
        : { ...estimate, amountIn: request.amountIn },
    );
  const execute = vi.spyOn(memeApi, "executeMainAccountTrade");
  const order = vi.spyOn(memeApi, "createOrder");
  render(<App />);
  return { prepare, execute, order };
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("route first, separate user confirmation", () => {
  it("shows the selected actual paths, exact limits and expiry as unverified before any execution", async () => {
    const { prepare, execute, order } = setup();
    const button = await screen.findByRole("button", { name: "准备交易" });
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.queryByRole("region", { name: "已选交易路径" })).not.toBeInTheDocument();
    fireEvent.click(button);
    const route = await screen.findByRole("region", { name: "已选交易路径" });
    expect(route).toHaveTextContent("USDG → WETH → CAT");
    expect(route).toHaveTextContent("UNISWAP V3");
    expect(route).toHaveTextContent("UNISWAP V4");
    expect(within(route).getAllByRole("listitem")).toHaveLength(2);
    expect(route).toHaveTextContent("估计，未经模拟");
    expect(route).toHaveTextContent("最低得到9.5 CAT");
    expect(route).toHaveTextContent("支付数量1 USDG");
    expect(route).toHaveTextContent("预计得到≈ 10 CAT");
    expect(route.querySelector("time")).toHaveAttribute("dateTime");
    expect(route).toHaveTextContent(/剩余 1[45] 秒/);
    expect(prepare.mock.calls.at(-1)?.[0]).toMatchObject({
      purpose: "PREPARE_EXECUTION",
      amountIn: "1",
      minAmountOut: minimum,
    });
    expect(screen.getByRole("button", { name: "确认提交" })).toBeEnabled();
    expect(execute).not.toHaveBeenCalled();
    expect(order).not.toHaveBeenCalled();
    expect(document.body).not.toHaveTextContent("display-source");
    expect(document.body).not.toHaveTextContent("已成交部分不会撤销");
  });

  it("does not retry or submit after preparation fails; a new explicit preparation is required", async () => {
    const { prepare, execute, order } = setup();
    const button = await screen.findByRole("button", { name: "准备交易" });
    await waitFor(() => expect(button).toBeEnabled());
    prepare.mockRejectedValueOnce(new ApiError("MEME_NO_EXECUTABLE_ROUTE", "no route", 409));
    fireEvent.click(button);
    await screen.findByRole("alert");
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "确认提交" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "已选交易路径" })).not.toBeInTheDocument();
    expect(
      prepare.mock.calls.filter(([input]) => input.purpose === "PREPARE_EXECUTION"),
    ).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
    expect(order).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "准备交易" }));
    await screen.findByRole("region", { name: "已选交易路径" });
    expect(
      prepare.mock.calls.filter(([input]) => input.purpose === "PREPARE_EXECUTION"),
    ).toHaveLength(2);
    expect(execute).not.toHaveBeenCalled();
  });

  it("invalidates the shown selection when amount changes and disables confirmation at expiry", async () => {
    vi.useFakeTimers();
    setup();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "准备交易" }));
    await act(async () => {});
    expect(screen.getByRole("region", { name: "已选交易路径" })).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(15_001));
    expect(screen.getByRole("button", { name: "路径已过期" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("买入金额"), { target: { value: "2" } });
    expect(screen.queryByRole("region", { name: "已选交易路径" })).not.toBeInTheDocument();
  });

  it("submits only the separately confirmed route binding and requires a new preparation after simulation failure", async () => {
    const { execute, order, prepare } = setup();
    const failed = {
      executionId: "mock-only",
      tokenAddress,
      tokenSymbol: "CAT",
      side: "BUY" as const,
      settlementAsset: "USDG" as const,
      amountIn: "1",
      amountOut: null,
      status: "FAILED" as const,
      txHashes: [],
      errorMessage: "所选路径模拟失败",
      createdAt: 1,
      updatedAt: 1,
    };
    execute.mockResolvedValue({ ...failed, status: "PENDING" });
    vi.spyOn(memeApi, "getAccountTransaction").mockResolvedValue(failed);
    const button = await screen.findByRole("button", { name: "准备交易" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    fireEvent.click(await screen.findByRole("button", { name: "确认提交" }));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      quoteId: "chosen-route",
      routeFingerprint: "bound-route",
      minAmountOut: minimum,
      amountIn: "1",
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "准备交易" })).toBeEnabled());
    expect(screen.queryByRole("region", { name: "已选交易路径" })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("重新准备并确认");
    expect(
      prepare.mock.calls.filter(([input]) => input.purpose === "PREPARE_EXECUTION"),
    ).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(order).not.toHaveBeenCalled();
  });
});

it("calculates 5pp from current price, shows exact minimum, and carries edited 3% through preparation", async () => {
  const { prepare, execute } = setup();
  const button = await screen.findByRole("button", { name: "准备交易" });
  await waitFor(() => expect(button).toBeEnabled());
  expect(screen.getByLabelText("滑点设置")).toHaveValue(5);
  expect(document.querySelector(".quote-details")).toHaveTextContent("价格影响0%");
  expect(document.querySelector(".quote-details")).toHaveTextContent("预计得到≈ 10 CAT");
  expect(document.querySelector(".quote-details")).toHaveTextContent("最低得到9.5 CAT");
  fireEvent.change(screen.getByLabelText("滑点设置"), { target: { value: "3" } });
  await waitFor(() => expect(button).toBeEnabled());
  expect(prepare.mock.calls.at(-1)?.[0].slippageBps).toBe(300);
  expect(document.querySelector(".quote-details")).toHaveTextContent("最低得到9.7 CAT");
  fireEvent.click(button);
  await screen.findByRole("region", { name: "已选交易路径" });
  expect(prepare.mock.calls.at(-1)?.[0]).toMatchObject({
    purpose: "PREPARE_EXECUTION",
    slippageBps: 300,
    minAmountOut: "9.700000000000000001",
  });
  expect(execute).not.toHaveBeenCalled();
});

it("updates the visible minimum with refreshed estimates but keeps a prepared commitment unchanged", async () => {
  vi.useFakeTimers();
  const { prepare, execute } = setup();
  await act(async () => {});
  prepare.mockImplementation(async (request) =>
    request.purpose === "PREPARE_EXECUTION"
      ? { ...selectedRoute(), minAmountOut: request.minAmountOut! }
      : {
          ...estimate,
          expectedAmountOut: "12.000000000000000002",
          expectedAmountOutAtomic: "12000000000000000002",
        },
  );
  await act(async () => vi.advanceTimersByTimeAsync(15001));
  expect(document.querySelector(".quote-details")).toHaveTextContent("最低得到11.4 CAT");
  fireEvent.click(screen.getByRole("button", { name: "准备交易" }));
  await act(async () => {});
  expect(prepare.mock.calls.at(-1)?.[0].minAmountOut).toBe("11.400000000000000001");
  await act(async () => vi.advanceTimersByTimeAsync(15001));
  expect(screen.getByRole("region", { name: "已选交易路径" })).toHaveTextContent(
    "最低得到11.4 CAT",
  );
  expect(execute).not.toHaveBeenCalled();
});

it("puts history in an accessible modal, removes notes and shortens display while preserving the exact bound", async () => {
  setup();
  await act(async () => {});
  expect(document.querySelector(".transaction-history")).toBeNull();
  expect(document.querySelectorAll('[role="note"]')).toHaveLength(0);
  expect(document.querySelector(".quote-details")).toHaveTextContent("≈ 10 CAT");
  screen.getByRole("button", { name: "交易记录" }).focus();
  fireEvent.click(screen.getByRole("button", { name: "交易记录" }));
  expect(screen.getByRole("dialog", { name: "交易记录" })).toHaveTextContent("暂无交易");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "交易记录" })).toHaveFocus();
});
it("refreshes stable drafts at 15 seconds without preparing transactions", async () => {
  vi.useFakeTimers();
  const { prepare } = setup();
  await act(async () => {});
  expect(prepare).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(14999));
  expect(prepare).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(prepare).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(15000));
  expect(prepare).toHaveBeenCalledTimes(3);
  expect(prepare.mock.calls.every(([request]) => request.purpose === "ESTIMATE")).toBe(true);
});
it("shows one ordinary confirmation and no separate approval CTA", async () => {
  const { execute } = setup();
  const approve = vi.spyOn(memeApi, "approveTrade");
  const button = await screen.findByRole("button", { name: "准备交易" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await screen.findByRole("button", { name: "确认提交" });
  expect(screen.queryByLabelText("代币授权")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^授权/ })).not.toBeInTheDocument();
  expect(approve).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});
it("keeps manual 45% through 15s refresh and ignores a stale pending response", async () => {
  vi.useFakeTimers();
  const { prepare } = setup();
  await act(async () => {});
  fireEvent.change(screen.getByLabelText("滑点设置"), { target: { value: "45" } });
  await act(async () => {});
  let resolve!: (value: LocalEstimate) => void;
  prepare.mockImplementationOnce(
    () =>
      new Promise<LocalEstimate>((r) => {
        resolve = r;
      }),
  );
  await act(async () => vi.advanceTimersByTimeAsync(15000));
  fireEvent.change(screen.getByLabelText("买入金额"), { target: { value: "2" } });
  fireEvent.change(screen.getByLabelText("滑点设置"), { target: { value: "35" } });
  await act(async () => {});
  await act(async () =>
    resolve({
      ...estimate,
      expectedAmountOut: "1",
      expectedAmountOutAtomic: "1000000000000000000",
    }),
  );
  expect(screen.getByLabelText("滑点设置")).toHaveValue(35);
  await act(async () => vi.advanceTimersByTimeAsync(15000));
  expect(screen.getByLabelText("滑点设置")).toHaveValue(35);
});
