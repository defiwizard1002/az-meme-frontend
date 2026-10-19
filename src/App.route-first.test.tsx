import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
        positions: [{ tokenAddress, symbol: "CAT", available: "10", valueUsd: "1", costUsd: "1" }],
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
  const prepare = vi.spyOn(memeApi, "createQuote").mockImplementation(async (request) =>
    request.purpose === "PREPARE_EXECUTION"
      ? {
          ...selectedRoute(),
          side: request.side,
          settlementAsset: request.settlementAsset,
          amountIn: request.amountIn,
          minAmountOut: request.minAmountOut!,
        }
      : {
          ...estimate,
          side: request.side,
          settlementAsset: request.settlementAsset,
          amountIn: request.amountIn,
        },
  );
  const transaction = {
    executionId: "mock-only",
    tokenAddress,
    tokenSymbol: "CAT",
    side: "BUY" as const,
    settlementAsset: "USDG" as const,
    amountIn: "1",
    amountOut: "10",
    status: "CONFIRMED" as const,
    txHashes: ["mock-hash"],
    createdAt: 1,
    updatedAt: 1,
    errorMessage: null,
  };
  const execute = vi.spyOn(memeApi, "executeMainAccountTrade").mockResolvedValue(transaction);
  vi.spyOn(memeApi, "getAccountTransaction").mockResolvedValue(transaction);
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

describe("single action trading", () => {
  it("shows the current estimate and one Buy action without technical details", async () => {
    setup();
    await waitFor(() =>
      expect(screen.getByText("买入", { selector: "button.primary" })).toBeEnabled(),
    );
    const form = document.querySelector(".trade-form")!;
    expect(form).toHaveTextContent("预计得到≈ 10 CAT");
    expect(form).not.toHaveTextContent(
      /最低得到|价格影响|建议滑点|滑点设置|容忍度依据|确认期限|已选交易路径|未经模拟|预估 Gas|准备交易|确认提交|重新估计/,
    );
  });
  it.each(["BUY", "SELL"] as const)(
    "one %s action prepares then executes exactly once",
    async (side) => {
      const { prepare, execute, order } = setup();
      const approve = vi.spyOn(memeApi, "approveTrade");
      await waitFor(() => expect(document.querySelector("button.primary")).toBeEnabled());
      if (side === "SELL") {
        fireEvent.click(screen.getByRole("button", { name: "卖出" }));
        fireEvent.change(screen.getByLabelText("卖出数量"), { target: { value: "1" } });
        await waitFor(() => expect(document.querySelector("button.primary")).toBeEnabled());
      }
      fireEvent.click(document.querySelector("button.primary")!);
      fireEvent.click(document.querySelector("button.primary")!);
      await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
      const inputs = prepare.mock.calls.filter(([r]) => r.purpose === "PREPARE_EXECUTION");
      expect(inputs).toHaveLength(1);
      expect(execute.mock.calls[0]![0]).toMatchObject({
        side,
        amountIn: "1",
        quoteId: "chosen-route",
        routeFingerprint: "bound-route",
        minAmountOut: inputs[0]![0].minAmountOut,
        slippageBps: inputs[0]![0].slippageBps,
      });
      expect(order).not.toHaveBeenCalled();
      expect(approve).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: /^授权|确认提交/ })).not.toBeInTheDocument();
      await screen.findByText("交易成功");
    },
  );
  it("keeps preparation errors and waits for another user action", async () => {
    const { prepare, execute } = setup();
    await waitFor(() => expect(document.querySelector("button.primary")).toBeEnabled());
    prepare.mockRejectedValueOnce(new ApiError("MEME_NO_EXECUTABLE_ROUTE", "no route", 409));
    fireEvent.click(document.querySelector("button.primary")!);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBeTruthy();
    await act(async () => {});
    expect(execute).not.toHaveBeenCalled();
    expect(prepare.mock.calls.filter(([r]) => r.purpose === "PREPARE_EXECUTION")).toHaveLength(1);
    fireEvent.click(screen.getByText("买入", { selector: "button.primary" }));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  });
  it.each(["amount", "side", "asset"])(
    "discards a preparation after changing %s and keeps busy until it ends",
    async (change) => {
      const { prepare, execute } = setup();
      await waitFor(() => expect(document.querySelector("button.primary")).toBeEnabled());
      let resolve!: (q: Quote) => void;
      prepare.mockImplementationOnce(
        () =>
          new Promise<Quote>((r) => {
            resolve = r;
          }),
      );
      fireEvent.click(document.querySelector("button.primary")!);
      expect(document.querySelector("button.primary")).toBeDisabled();
      if (change === "amount")
        fireEvent.change(screen.getByLabelText("买入金额"), { target: { value: "2" } });
      if (change === "side") fireEvent.click(screen.getByRole("button", { name: "卖出" }));
      if (change === "asset")
        fireEvent.change(screen.getByLabelText("支付资产"), { target: { value: "ETH" } });
      expect(document.querySelector("button.primary")).toBeDisabled();
      await act(async () => resolve(selectedRoute()));
      expect(execute).not.toHaveBeenCalled();
      if (change === "amount") {
        await waitFor(() => expect(document.querySelector("button.primary")).toBeEnabled());
        fireEvent.click(document.querySelector("button.primary")!);
        await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
        expect(execute.mock.calls[0]![0].amountIn).toBe("2");
      }
    },
  );
  it("does not automatically resend after execution fails", async () => {
    const { execute, prepare } = setup();
    await waitFor(() => expect(document.querySelector("button.primary")).toBeEnabled());
    execute.mockRejectedValueOnce(new ApiError("MEME_ROUTE_STALE", "stale route", 409));
    fireEvent.click(document.querySelector("button.primary")!);
    await screen.findByRole("alert");
    await waitFor(() => expect(document.querySelector("button.primary")).toBeEnabled());
    expect(execute).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls.filter(([r]) => r.purpose === "PREPARE_EXECUTION")).toHaveLength(1);
  });
  it("refreshes the visible estimate every 15 seconds without executing", async () => {
    vi.useFakeTimers();
    const { prepare, execute } = setup();
    await act(async () => {});
    prepare.mockImplementation(async (request) => ({
      ...estimate,
      amountIn: request.amountIn,
      expectedAmountOut: "12.000000000000000002",
      expectedAmountOutAtomic: "12000000000000000002",
    }));
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(document.querySelector(".quote-details")).toHaveTextContent("预计得到≈ 12 CAT");
    expect(prepare.mock.calls.every(([r]) => r.purpose === "ESTIMATE")).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
  it("submits the same single action from the form", async () => {
    const { execute } = setup();
    await waitFor(() => expect(document.querySelector("button.primary")).toBeEnabled());
    fireEvent.submit(document.querySelector(".trade-form")!);
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  });
});
