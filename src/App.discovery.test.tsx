import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { memeApi } from "./api";
import type { Token } from "./types";

vi.mock("./CandleChart", () => ({ CandleChart: () => <div data-testid="chart" /> }));

function token(digit: string): Token {
  return {
    chainId: 4663,
    tokenAddress: `0x${digit.repeat(40)}`,
    // Deliberately identical labels: matching symbols does not prove list identity.
    symbol: "SAME",
    name: "Same label",
    launchpad: "PONS",
    stage: "GRADUATED",
    quoteAssetKey: "NATIVE",
    priceQuote: "1",
    priceUsd: "1",
    marketCapUsd: "1",
    volume24hUsd: "1",
    change5m: "0",
    change24h: "0",
    holders: 1,
    ageSeconds: 1,
    pool: { poolKey: digit, poolType: "UNISWAP_V2", liquidityUsd: "1" },
    tradeStatus: "TRADABLE",
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
}
const lists = { hot: [token("1"), token("2")], new: [token("3"), token("4")] };
const identity = (item: Token) => `${item.chainId}:${item.tokenAddress.toLowerCase()}`;
type Fiber = {
  memoizedProps?: { token?: Token };
  child?: Fiber;
  sibling?: Fiber;
};
function rows() {
  // The UI has no address attribute. Read the rendered TokenMark's real props,
  // rather than infer addresses from the mocked response or duplicate symbols.
  return [...document.querySelectorAll(".token-row")].map((row) => {
    const key = Object.keys(row).find((name) => name.startsWith("__reactFiber"))!;
    const fiber = (row as unknown as Record<string, Fiber>)[key]!;
    const find = (node: Fiber | undefined): Token | undefined => {
      if (!node) return undefined;
      return node.memoizedProps?.token ?? find(node.child) ?? find(node.sibling);
    };
    const item = find(fiber.child);
    if (!item) throw new Error("Rendered row has no token identity");
    return identity(item);
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tabButton = (tab: "hot" | "new") =>
  screen.getByRole("button", { name: tab === "hot" ? "热榜" : "新币" });
async function expectList(tab: "hot" | "new") {
  await waitFor(() => {
    expect(tabButton(tab)).toHaveClass("active");
    expect(rows()).toEqual(lists[tab].map(identity));
    expect(document.querySelectorAll(".token-row .token-select")).toHaveLength(2);
  });
}
async function setup() {
  vi.stubGlobal("WebSocket", undefined);
  const envelope = (result: unknown) => new Response(JSON.stringify({ rc: 0, result }));
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/config"))
      return envelope({
        chainId: 4663,
        chainName: "Test",
        accountMode: "MAIN_ACCOUNT_POC",
        settlementAssets: ["USDG"],
        defaultSlippageBps: 300,
        marketRefreshMs: { hot: 14_400_000, new: 300_000 },
      });
    if (url.pathname.endsWith("/summary")) return envelope({ quoteBalances: [], positions: [] });
    if (/\/(orders|transactions|trades)$/.test(url.pathname))
      return envelope({ items: [], nextCursor: null });
    if (url.pathname.endsWith("/candles"))
      return envelope({
        chainId: 4663,
        tokenAddress: url.pathname.split("/").at(-2),
        marketKey: "USD:USDG",
        interval: "1m",
        syncStatus: "READY",
        availability: "COMPLETE",
        gaps: [],
        coverage: { from: null, to: null },
        revision: "1",
        asOfBlock: 1,
        source: "CHAIN",
        items: [],
      });
    throw new Error(`Unexpected discovery test request: ${url.pathname}`);
  });
  // Discovery assertions must not race an unrelated 300ms quote refresh.
  vi.spyOn(memeApi, "createQuote").mockImplementation(async (request) => ({
    ...request,
    status: "LOCAL_ESTIMATE",
    requiresExecutionPreparation: true,
    precision: "CORE_CURVE_ESTIMATE",
    netRecipientGuaranteed: false,
    expectedAmountOut: "1",
    expectedAmountOutAtomic: "1000000000000000000",
    outputDecimals: 18,
    minAmountOut: "0.8",
    fees: [],
    expiresAt: Date.now() + 30_000,
  }));
  const markets = vi
    .spyOn(memeApi, "getMarkets")
    .mockImplementation(async (tab = "hot") => ({ items: lists[tab], stale: false }));
  const detail = vi.spyOn(memeApi, "getToken").mockImplementation(async (address) => {
    const item = [...lists.hot, ...lists.new].find((item) => item.tokenAddress === address);
    if (!item) throw new Error(`Unexpected detail address: ${address}`);
    return item;
  });
  render(<App />);
  await expectList("hot");
  return { markets, detail };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("discovery hot/new switching", () => {
  it("renders the exact chain/address list through hot → new → hot twice", async () => {
    const { markets } = await setup();
    for (const tab of ["new", "hot", "new", "hot"] as const) {
      await waitFor(() => expect(tabButton(tab)).toBeEnabled());
      fireEvent.click(tabButton(tab));
      await expectList(tab);
    }
    expect(markets.mock.calls.map(([tab = "hot"]) => tab)).toEqual([
      "hot",
      "new",
      "hot",
      "new",
      "hot",
    ]);
  });

  it("can switch back while the new token DETAIL is intentionally unresolved", async () => {
    const { detail } = await setup();
    const held = deferred<Token>();
    detail.mockImplementationOnce(() => held.promise);
    try {
      fireEvent.click(tabButton("new"));
      await expectList("new");
      expect(detail).toHaveBeenLastCalledWith(lists.new[0]!.tokenAddress);
      // This is independence from a pending operation, not a millisecond SLA.
      expect(tabButton("hot"), "Token detail must not disable discovery navigation").toBeEnabled();
      fireEvent.click(tabButton("hot"));
      await expectList("hot");
    } finally {
      await act(async () => held.resolve(lists.new[0]!));
    }
    expect(document.querySelectorAll(".token-row.selected")).toHaveLength(1);
    expect(document.querySelector(".token-row.selected")).toBe(
      document.querySelectorAll(".token-row")[0],
    );
  });

  it("keeps the final requested hot list after opposite clicks and a late new response", async () => {
    const { markets } = await setup();
    const held = deferred<{ items: Token[]; stale: boolean }>();
    markets.mockImplementationOnce(() => held.promise);
    fireEvent.click(tabButton("new"));
    expect(markets).toHaveBeenLastCalledWith("new");
    fireEvent.click(tabButton("hot"));
    // If hot is fetched, its normal response completes before the held new one.
    await act(async () => {});
    await act(async () => held.resolve({ items: lists.new, stale: false }));
    await waitFor(() => expect(tabButton("new")).toBeEnabled());
    expect(rows()).toEqual(lists.hot.map(identity));
    expect(document.querySelectorAll(".token-row.selected")).toHaveLength(1);
    expect(tabButton("hot")).toHaveClass("active");
  });

  it("keeps existing rows while loading or failed, then recovers on another click", async () => {
    const { markets } = await setup();
    const held = deferred<{ items: Token[]; stale: boolean }>();
    markets.mockImplementationOnce(() => held.promise);
    fireEvent.click(tabButton("new"));
    expect(tabButton("new")).toHaveClass("active");
    expect(rows()).toEqual(lists.hot.map(identity));
    expect(screen.getByRole("status", { name: "列表加载状态" })).toHaveTextContent(
      "新币列表加载中",
    );
    expect(screen.queryByText("没有匹配的代币")).not.toBeInTheDocument();
    await act(async () => held.reject(new Error("Discovery list unavailable")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Discovery list unavailable");
    await expectList("hot");
    expect(tabButton("new")).toBeEnabled();
    fireEvent.click(tabButton("new"));
    await expectList("new");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

it("shows current token detail loading, then success clears it", async () => {
  const { detail } = await setup();
  const held = deferred<Token>();
  detail.mockImplementationOnce(() => held.promise);
  fireEvent.click(document.querySelectorAll(".token-select")[1]!);
  expect(screen.getByRole("status", { name: "详情加载状态" })).toHaveTextContent("SAME 详情加载中");
  await act(async () => held.resolve(lists.hot[1]!));
  expect(screen.queryByRole("status", { name: "详情加载状态" })).not.toBeInTheDocument();
});
it("separates detail failure from loading and retries the selected token", async () => {
  const { detail } = await setup();
  detail.mockRejectedValueOnce(new Error("Details unavailable"));
  fireEvent.click(document.querySelectorAll(".token-select")[1]!);
  expect(await screen.findByText("Details unavailable")).toBeInTheDocument();
  expect(screen.queryByRole("status", { name: "详情加载状态" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重试详情" }));
  await waitFor(() => expect(screen.queryByText("Details unavailable")).not.toBeInTheDocument());
  expect(detail).toHaveBeenLastCalledWith(lists.hot[1]!.tokenAddress, true);
});
it("a late previous detail cannot clear the current token spinner or overwrite its identity", async () => {
  const { detail } = await setup();
  const old = deferred<Token>();
  const current = deferred<Token>();
  detail.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => current.promise);
  fireEvent.click(document.querySelectorAll(".token-select")[1]!);
  fireEvent.click(document.querySelectorAll(".token-select")[0]!);
  await act(async () => old.resolve(lists.hot[1]!));
  expect(screen.getByRole("status", { name: "详情加载状态" })).toBeInTheDocument();
  expect(document.querySelector(".token-row.selected")).toBe(
    document.querySelectorAll(".token-row")[0],
  );
  await act(async () => current.resolve(lists.hot[0]!));
  expect(screen.queryByRole("status", { name: "详情加载状态" })).not.toBeInTheDocument();
});

it("keeps loading for a pending background result, polls to completion, and stops on unmount", async () => {
  const { detail } = await setup();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    detail.mockResolvedValueOnce({ ...lists.hot[1]!, detailStatus: "PENDING" });
    fireEvent.click(document.querySelectorAll(".token-select")[1]!);
    await act(async () => {});
    expect(screen.getByRole("status", { name: "详情加载状态" })).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.queryByRole("status", { name: "详情加载状态" })).not.toBeInTheDocument();
    const calls = detail.mock.calls.length;
    cleanup();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(detail).toHaveBeenCalledTimes(calls);
  } finally {
    vi.useRealTimers();
  }
});
