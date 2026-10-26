import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "./App";
import { memeApi } from "./api";
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
    else if (u.pathname.endsWith("/orders") || u.pathname.endsWith("/transactions"))
      result = { items: [], nextCursor: null };
    else if (u.pathname.endsWith("/trades"))
      result = {
        items: [
          {
            tradeId: "4663:tx:1",
            txHash: "tx",
            t: 1,
            side: "BUY",
            priceUsd: "1",
            baseAmount: "1",
            quoteAmount: "1",
            quoteAsset: "USDG",
            trader: token.tokenAddress,
          },
        ],
        nextCursor: null,
      };
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
        status: "LOCAL_ESTIMATE",
        requiresExecutionPreparation: true,
        precision: "CORE_CURVE_ESTIMATE",
        netRecipientGuaranteed: false,
        fees: [],
        expectedAmountOutAtomic: "1100000",
        outputDecimals: 6,
        inputPriceUsd: "1",
        expectedAmountOut: "1.1",
        minAmountOut: "0.97",
        expiresAt: Date.now() + 30000,
        routePools: [{ poolKey: "actual-v3", poolType: "UNISWAP_V3" }],
        routeAssets: [{ address: token.tokenAddress, symbol: "PONS" }],
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

it("shows computed slippage/minimum; manual edit survives delayed quote and price refresh; input resets", async () => {
  setup();
  render(<App />);
  const slip = await screen.findByRole("textbox", { name: "滑点百分比" });
  await waitFor(() => expect(slip).toHaveValue("15"));
  expect(screen.getByTitle("0.935")).toBeInTheDocument();
  let resolve!: (q: Awaited<ReturnType<typeof memeApi.createQuote>>) => void;
  const create = vi.spyOn(memeApi, "createQuote").mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const amount = screen.getByRole("textbox", { name: "买入金额" });
  fireEvent.change(amount, { target: { value: "2" } });
  await waitFor(() => expect(create).toHaveBeenCalled());
  fireEvent.change(slip, { target: { value: "7.25" } });
  await act(async () =>
    resolve({
      ...create.mock.calls[0]![0],
      status: "LOCAL_ESTIMATE",
      requiresExecutionPreparation: true,
      precision: "CORE_CURVE_ESTIMATE",
      netRecipientGuaranteed: false,
      fees: [],
      expectedAmountOut: "2.2",
      expectedAmountOutAtomic: "2200000",
      outputDecimals: 6,
      minAmountOut: "0",
      inputPriceUsd: "1",
      expiresAt: Date.now() + 60000,
    } as Awaited<ReturnType<typeof memeApi.createQuote>>),
  );
  expect(slip).toHaveValue("7.25");
  expect(screen.getByTitle("2.0405")).toBeInTheDocument();
  fireEvent.change(amount, { target: { value: "3" } });
  expect(slip).toHaveValue("");
});
it("missing trade does not use stale token/candle/quote price; manual path remains available", async () => {
  setup();
  vi.spyOn(memeApi, "getTrades").mockResolvedValue({ items: [], nextCursor: null });
  render(<App />);
  const slip = await screen.findByRole("textbox", { name: "滑点百分比" });
  await screen.findByTitle("1.1");
  expect(slip).toHaveValue("");
  expect(screen.getByRole("button", { name: "更新报价中" })).toBeDisabled();
  fireEvent.change(slip, { target: { value: "5" } });
  expect(screen.getByTitle("1.045")).toBeInTheDocument();
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!).toBeEnabled();
});
it("binds displayed minimum and tolerance to preparation and execution without a real trade", async () => {
  setup();
  const execute = vi
    .spyOn(memeApi, "executeMainAccountTrade")
    .mockImplementation(() => new Promise(() => {}));
  const create = vi.spyOn(memeApi, "createQuote");
  render(<App />);
  const slip = await screen.findByRole("textbox", { name: "滑点百分比" });
  await waitFor(() => expect(slip).toHaveValue("15"));
  create.mockImplementation(
    async (input) =>
      ({
        ...input,
        quoteId: "prepared",
        expectedAmountOut: "1.1",
        minAmountOut: input.minAmountOut!,
        expiresAt: Date.now() + 60000,
        routeFingerprint: "route",
        routePools: [{ poolKey: "p", poolType: "UNISWAP_V3", liquidityUsd: "1" }],
        routeAssets: [
          { address: token.tokenAddress, symbol: "A", decimals: 6 },
          { address: token.tokenAddress, symbol: "B", decimals: 6 },
        ],
        fees: [],
      }) as Awaited<ReturnType<typeof memeApi.createQuote>>,
  );
  fireEvent.click(document.querySelector<HTMLButtonElement>('button[type="submit"]')!);
  await waitFor(() => expect(execute).toHaveBeenCalled());
  expect(create.mock.lastCall?.[0]).toMatchObject({
    purpose: "PREPARE_EXECUTION",
    slippageBps: 1500,
    minAmountOut: "0.935",
  });
  expect(execute.mock.lastCall?.[0]).toMatchObject({ slippageBps: 1500, minAmountOut: "0.935" });
});

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  delayedClose = false;
  sent: string[] = [];
  listeners = new Map<string, Array<(event: Event) => void>>();
  constructor(_url: string) {
    Socket.instances.push(this);
  }
  addEventListener(name: string, listener: (event: Event) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  emit(name: string, event: Event) {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
  open() {
    this.readyState = 1;
    this.emit("open", new Event("open"));
  }
  receive(data: unknown) {
    this.emit("message", { data: JSON.stringify(data) } as MessageEvent);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    if (this.readyState >= 2) return;
    this.readyState = this.delayedClose ? 2 : 3;
    if (!this.delayedClose) this.emit("close", new Event("close"));
  }
}

it("latest event push updates automatic value even when table paused; historical/late events do not overwrite manual or latest price", async () => {
  setup();
  Socket.instances = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.spyOn(memeApi, "getWsTicket").mockResolvedValue({
    ticket: "test",
    expiresAt: Date.now() + 60000,
  });
  render(<App />);
  const slip = await screen.findByRole("textbox", { name: "滑点百分比" });
  await waitFor(() => expect(slip).toHaveValue("15"));
  await waitFor(() => expect(Socket.instances.length).toBeGreaterThan(0));
  const socket = Socket.instances.at(-1)!;
  await act(async () => socket.open());
  const channels = socket.sent.flatMap((s) => JSON.parse(s).channels ?? []) as string[];
  const channel = channels.find((c) => c.includes("trade"))!;
  expect(channel).toBeTruthy();
  const push = (seq: number, t: number, p: string) =>
    socket.receive({
      channel,
      epoch: "e",
      sequence: seq,
      data: {
        tradeId: `4663:tx:${seq}`,
        txHash: "tx",
        t,
        side: "BUY",
        priceUsd: p,
        baseAmount: "1",
        quoteAmount: "1",
        quoteAsset: "USDG",
        trader: token.tokenAddress,
      },
    });
  fireEvent.click(screen.getByRole("button", { name: "暂停" }));
  await act(async () => push(1, 2, "2"));
  expect(slip).toHaveValue("125");
  expect(document.querySelector('button[type="submit"]')).toBeDisabled();
  fireEvent.change(slip, { target: { value: "8" } });
  await act(async () => push(2, 3, "3"));
  expect(slip).toHaveValue("8");
  fireEvent.click(screen.getByRole("button", { name: "自动" }));
  expect(slip).toHaveValue("235");
  await act(async () => push(3, 1, "0.1"));
  expect(slip).toHaveValue("235");
});

it("rejects late previous-token quote and resets manual on token/side changes", async () => {
  setup();
  const second = {
    ...token,
    tokenAddress: `0x${"2".repeat(40)}`,
    symbol: "SECOND",
    name: "Second",
  };
  vi.spyOn(memeApi, "getMarkets").mockResolvedValue({
    items: [token, second],
    stale: false,
  } as Awaited<ReturnType<typeof memeApi.getMarkets>>);
  vi.spyOn(memeApi, "getToken").mockImplementation(
    async (address) =>
      ({
        ...token,
        tokenAddress: address,
        symbol: address === second.tokenAddress ? "SECOND" : "PONS",
      }) as Awaited<ReturnType<typeof memeApi.getToken>>,
  );
  let resolve!: (q: Awaited<ReturnType<typeof memeApi.createQuote>>) => void;
  const create = vi.spyOn(memeApi, "createQuote").mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  render(<App />);
  const slip = await screen.findByRole("textbox", { name: "滑点百分比" });
  await waitFor(() => expect(create).toHaveBeenCalled());
  const oldResolve = resolve;
  const oldRequest = create.mock.calls[0]![0];
  fireEvent.change(slip, { target: { value: "8" } });
  fireEvent.click(screen.getByText("SECOND"));
  expect(slip).toHaveValue("");
  await act(async () =>
    oldResolve({
      ...oldRequest,
      status: "LOCAL_ESTIMATE",
      requiresExecutionPreparation: true,
      precision: "CORE_CURVE_ESTIMATE",
      netRecipientGuaranteed: false,
      fees: [],
      expectedAmountOut: "1.1",
      expectedAmountOutAtomic: "1100000",
      outputDecimals: 6,
      minAmountOut: "0",
      expiresAt: Date.now() + 60000,
    } as Awaited<ReturnType<typeof memeApi.createQuote>>),
  );
  expect(slip).toHaveValue("");
  expect(screen.queryByTitle("1.1")).not.toBeInTheDocument();
  fireEvent.change(slip, { target: { value: "8" } });
  fireEvent.click(screen.getByRole("button", { name: "卖出" }));
  expect(slip).toHaveValue("");
});
it("manual edit during preparation prevents a stale prepared tolerance from executing", async () => {
  setup();
  const execute = vi.spyOn(memeApi, "executeMainAccountTrade");
  render(<App />);
  const slip = await screen.findByRole("textbox", { name: "滑点百分比" });
  await waitFor(() => expect(slip).toHaveValue("15"));
  let resolve!: (q: Awaited<ReturnType<typeof memeApi.createQuote>>) => void;
  const create = vi.spyOn(memeApi, "createQuote").mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  fireEvent.click(document.querySelector<HTMLButtonElement>('button[type="submit"]')!);
  await waitFor(() => expect(create).toHaveBeenCalled());
  fireEvent.change(slip, { target: { value: "9" } });
  await act(async () =>
    resolve({
      ...create.mock.calls[0]![0],
      quoteId: "old",
      expectedAmountOut: "1.1",
      fees: [],
      minAmountOut: "0.935",
      expiresAt: Date.now() + 60000,
    } as Awaited<ReturnType<typeof memeApi.createQuote>>),
  );
  expect(execute).not.toHaveBeenCalled();
  expect(slip).toHaveValue("9");
});

it("REST keeps the producer's newest-first head across same-second different transactions", async () => {
  setup();
  const trade = (id: string, priceUsd: string) => ({
    tradeId: `4663:${id}:1`,
    txHash: id,
    t: 10,
    priceUsd,
    side: "BUY" as const,
    baseAmount: "1",
    quoteAmount: "1",
    quoteAsset: "USDG",
    trader: token.tokenAddress,
  });
  vi.spyOn(memeApi, "getTrades").mockResolvedValue({
    items: [trade("a", "2"), trade("z", "1")],
    nextCursor: null,
  });
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText("滑点百分比")).toHaveValue("125"));
});

it("ordered WS same-second batch beats delayed REST; older revision cannot replace it and manual survives next batch", async () => {
  setup();
  Socket.instances = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.spyOn(memeApi, "getWsTicket").mockResolvedValue({
    ticket: "test",
    expiresAt: Date.now() + 60000,
  });
  let resolve!: (v: Awaited<ReturnType<typeof memeApi.getTrades>>) => void;
  vi.spyOn(memeApi, "getTrades").mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const trade = (id: string, priceUsd: string) => ({
    tradeId: `4663:${id}:1`,
    txHash: id,
    t: 10,
    priceUsd,
    side: "BUY" as const,
    baseAmount: "1",
    quoteAmount: "1",
    quoteAsset: "USDG",
    trader: token.tokenAddress,
  });
  render(<App />);
  const slip = await screen.findByLabelText("滑点百分比");
  await waitFor(() => expect(Socket.instances.length).toBeGreaterThan(0));
  const oldRest = resolve;
  const socket = Socket.instances.at(-1)!;
  await act(async () => socket.open());
  const channel = socket.sent
    .flatMap((s) => JSON.parse(s).channels ?? [])
    .find((c: string) => c.startsWith("trade:"));
  const push = (sequence: number, revision: string, items: ReturnType<typeof trade>[]) =>
    socket.receive({ channel, epoch: "ordered", sequence, revision, data: { items } });
  await act(async () => push(1, "100", [trade("z", "1"), trade("a", "2")]));
  await waitFor(() => expect(slip).toHaveValue("125"));
  await act(async () =>
    oldRest({ items: [trade("older", "1"), trade("oldest", "0.9")], nextCursor: null }),
  );
  expect(slip).toHaveValue("125");
  await act(async () => push(2, "99", [trade("backfill", "3")]));
  expect(slip).toHaveValue("125");
  fireEvent.change(slip, { target: { value: "8" } });
  await act(async () => push(3, "200", [trade("next1", "2.5"), trade("next2", "3")]));
  expect(slip).toHaveValue("8");
  fireEvent.click(screen.getByRole("button", { name: "自动" }));
  expect(slip).toHaveValue("235");
});

it("selects a holding absent from the market list and sells its exact personal available balance", async () => {
  setup();
  const held = { ...token, tokenAddress: `0x${"2".repeat(40)}`, symbol: "TETSU" } as Awaited<
    ReturnType<typeof memeApi.getToken>
  >;
  vi.spyOn(memeApi, "getAccount").mockResolvedValue({
    quoteBalances: [{ asset: "USDG", available: "10", frozen: "0" }],
    positions: [
      {
        tokenAddress: held.tokenAddress,
        symbol: held.symbol,
        available: "1779.447123456789123456",
        costUsd: "0",
        valueUsd: "0.009",
      },
    ],
  });
  const get = vi
    .spyOn(memeApi, "getToken")
    .mockImplementation(async (address) =>
      address === held.tokenAddress ? held : (token as typeof held),
    );
  const quotes = vi.spyOn(memeApi, "createQuote");
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "卖" }));
  fireEvent.click(screen.getByRole("button", { name: "100%" }));
  expect(screen.getByRole("textbox", { name: "卖出数量" })).toHaveValue("1779.447123456789123456");
  await waitFor(() => expect(get).toHaveBeenCalledWith(held.tokenAddress));
  await waitFor(() =>
    expect(quotes).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenAddress: held.tokenAddress,
        side: "SELL",
        amountIn: "1779.447123456789123456",
      }),
      expect.anything(),
    ),
  );
  expect(document.querySelector(".amount-unit")).toHaveTextContent("TETSU");
  expect(screen.queryByText("处理中")).toBeNull();
});
it("clears preparing status when draft changes before execution", async () => {
  setup();
  const execute = vi.spyOn(memeApi, "executeMainAccountTrade");
  render(<App />);
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "滑点百分比" })).toHaveValue("15"),
  );
  let resolve!: (value: Awaited<ReturnType<typeof memeApi.createQuote>>) => void;
  vi.spyOn(memeApi, "createQuote").mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  fireEvent.click(document.querySelector<HTMLButtonElement>('button[type="submit"]')!);
  fireEvent.change(screen.getByRole("textbox", { name: "买入金额" }), { target: { value: "2" } });
  await act(async () => resolve({} as Awaited<ReturnType<typeof memeApi.createQuote>>));
  expect(execute).not.toHaveBeenCalled();
  expect(screen.queryByText("处理中")).toBeNull();
});
