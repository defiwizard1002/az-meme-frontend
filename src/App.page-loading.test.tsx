import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { HistoryLoadResult } from "./CandleChart";
import { azAuth, memeApi } from "./api";
import type { Candle, CandleSnapshot, Token, Trade } from "./types";

const chart = vi.hoisted(() => ({
  current: null as {
    candles: Candle[];
    symbol: string;
    onLoadBefore: (before: number) => Promise<HistoryLoadResult>;
  } | null,
}));
vi.mock("./CandleChart", () => ({
  CandleChart: (props: NonNullable<typeof chart.current>) => {
    chart.current = props;
    return (
      <div aria-label={`${props.symbol} K 线图`}>
        {props.candles.map((item) => item.t).join(",")}
      </div>
    );
  },
}));

const tokenA: Token = {
  chainId: 4663,
  tokenAddress: `0x${"1".repeat(40)}`,
  symbol: "AAA",
  name: "Token A",
  launchpad: "PONS",
  stage: "GRADUATED",
  quoteAssetKey: "NATIVE",
  priceQuote: "11",
  priceUsd: "11",
  marketCapUsd: "1000",
  volume24hUsd: "100",
  change5m: "1",
  change24h: "2",
  holders: 10,
  ageSeconds: 60,
  pool: { poolKey: "pool-a", poolType: "UNISWAP_V4", liquidityUsd: "1000" },
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
const tokenB: Token = {
  ...tokenA,
  tokenAddress: `0x${"2".repeat(40)}`,
  symbol: "BBB",
  name: "Token B",
  priceUsd: "22",
};
const summary = {
  quoteBalances: [
    { asset: "ETH" as const, available: "10", frozen: "0" },
    { asset: "USDG" as const, available: "10", frozen: "0" },
  ],
  positions: [],
};
const auth = {
  userId: "test-user",
  accountId: "test-account",
  loginStatus: "LOGGED_IN",
  expiresAt: 9999999999999,
};

function candle(t: number, price: string): Candle {
  return {
    t,
    o: price,
    h: price,
    l: price,
    c: price,
    previousClose: null,
    baseVolume: "1",
    quoteVolume: "1",
    revision: "1",
  };
}
function snapshot(
  token: Token,
  interval: CandleSnapshot["interval"] = "1m",
  items = [candle(token === tokenA ? 100 : 200, token.priceUsd)],
): CandleSnapshot {
  return {
    chainId: 4663,
    tokenAddress: token.tokenAddress,
    marketKey: "USD:USDG",
    interval,
    syncStatus: "READY",
    availability: "COMPLETE",
    coverage: { from: items[0]?.t ?? null, to: items.at(-1)?.t ?? null },
    gaps: [],
    revision: "1",
    asOfBlock: 100,
    source: "CHAIN",
    items,
  };
}
function trade(id: string, t: number, price: string): Trade {
  return {
    tradeId: id,
    t,
    side: "BUY",
    priceUsd: price,
    baseAmount: "1",
    quoteAmount: "1",
    quoteAsset: "USDG",
    trader: `0x${"3".repeat(40)}`,
    txHash: `0x${"4".repeat(64)}`,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

import Entry from "./Entry";
import type { ComponentProps, ReactNode } from "react";
class ControlledSocket {
  static readonly OPEN = 1;
  static instances: ControlledSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  listeners = new Map<string, Array<(event: Event) => void>>();
  constructor(_url: string) {
    ControlledSocket.instances.push(this);
  }
  addEventListener(name: string, listener: (event: Event) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  emit(name: string, event: Event) {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
  send(payload: string) {
    this.sent.push(payload);
  }
  open() {
    this.readyState = 1;
    this.emit("open", new Event("open"));
  }
  receive(data: unknown) {
    this.emit("message", { data: JSON.stringify(data) } as MessageEvent);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", new Event("close"));
  }
}

function setup(mode: "AZ_ACCOUNT" | "MAIN_ACCOUNT_POC", withSocket = false) {
  chart.current = null;
  ControlledSocket.instances = [];
  vi.stubGlobal("WebSocket", withSocket ? ControlledSocket : undefined);
  vi.spyOn(azAuth, "loginMock").mockResolvedValue(auth);
  vi.spyOn(memeApi, "getConfig").mockResolvedValue({
    chainId: 4663,
    chainName: "Test",
    explorerBaseUrl: "",
    defaultSlippageBps: 300,
    marketRefreshMs: { hot: 14_400_000, new: 300_000 },
    accountMode: mode,
    mainAccountAddress: null,
    settlementAssets: mode === "MAIN_ACCOUNT_POC" ? ["USDG", "ETH"] : ["ETH"],
  });
  vi.spyOn(memeApi, "getMarkets").mockResolvedValue({ items: [tokenA, tokenB], stale: false });
  vi.spyOn(memeApi, "getToken").mockImplementation(async (address) =>
    address === tokenA.tokenAddress ? tokenA : tokenB,
  );
  vi.spyOn(memeApi, "getAccount").mockResolvedValue(summary);
  vi.spyOn(memeApi, "getAccountTransactions").mockResolvedValue({ items: [] });
  vi.spyOn(memeApi, "getOrders").mockResolvedValue({ items: [], nextCursor: null });
  vi.spyOn(memeApi, "getWsTicket").mockResolvedValue({ ticket: "test", expiresAt: 9999999999999 });
  vi.spyOn(memeApi, "getCandles").mockImplementation(async (address, interval) =>
    snapshot(address === tokenA.tokenAddress ? tokenA : tokenB, interval),
  );
  vi.spyOn(memeApi, "getTrades").mockImplementation(async (address, cursor) => ({
    items: [
      address === tokenA.tokenAddress
        ? trade(cursor ? "a-old" : "a-new", cursor ? 50 : 100, "11")
        : trade(cursor ? "b-old" : "b-new", cursor ? 150 : 200, "22"),
    ],
    nextCursor: cursor ? null : address === tokenA.tokenAddress ? "a-cursor" : "b-cursor",
  }));
  vi.spyOn(memeApi, "createQuote").mockImplementation(async (input) => ({
    ...input,
    quoteId: "quote",
    expectedAmountOut: "100",
    minAmountOut: "95",
    fees: [],
    expiresAt: 9999999999999,
    routeFingerprint: "chosen",
    routeAssets: [
      { address: "input", symbol: "USDG", decimals: 18 },
      { address: input.tokenAddress, symbol: "AAA", decimals: 18 },
    ],
    routePools: [{ poolKey: "actual", poolType: "UNISWAP_V3", liquidityUsd: "1" }],
  }));
  vi.spyOn(memeApi, "createOrder").mockResolvedValue({
    orderId: "order",
    status: "SETTLED",
    fundStatus: "SETTLED",
  });
  vi.spyOn(memeApi, "getOrder").mockResolvedValue({
    orderId: "order",
    status: "SETTLED",
    fundStatus: "SETTLED",
  });
  const transaction = {
    executionId: "execution",
    tokenAddress: tokenA.tokenAddress,
    tokenSymbol: tokenA.symbol,
    side: "BUY" as const,
    settlementAsset: "USDG" as const,
    amountIn: "1",
    amountOut: "100",
    status: "CONFIRMED" as const,
    txHashes: [],
    errorMessage: null,
    createdAt: 1,
    updatedAt: 1,
  };
  vi.spyOn(memeApi, "executeMainAccountTrade").mockResolvedValue(transaction);
  vi.spyOn(memeApi, "getAccountTransaction").mockResolvedValue(transaction);
}

const sdk = vi.hoisted(() => ({
  ready: false,
  authenticated: false,
  walletsReady: false,
  user: {
    id: "user-one",
    linkedAccounts: [
      {
        type: "wallet",
        walletClientType: "privy",
        chainType: "ethereum",
        address: "0x1111111111111111111111111111111111111111",
        id: "wallet-one",
      },
    ],
  },
  wallet: { walletClientType: "privy", address: "0x1111111111111111111111111111111111111111" },
  login: vi.fn(),
  logout: vi.fn(),
  getAccessToken: vi.fn(),
  generateAuthorizationSignature: vi.fn(),
  createWallet: vi.fn(),
}));
vi.mock("@privy-io/react-auth", () => ({
  PrivyProvider: ({ children }: { children: ReactNode }) => children,
  usePrivy: () => ({ ...sdk, login: () => sdk.login(), logout: () => sdk.logout() }),
  useWallets: () => ({ ready: sdk.walletsReady, wallets: sdk.walletsReady ? [sdk.wallet] : [] }),
  useAuthorizationSignature: () => sdk,
  useCreateWallet: () => ({ createWallet: () => sdk.createWallet() }),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sdk.ready = false;
  sdk.authenticated = false;
  sdk.walletsReady = false;
});

describe("page loading continuity", () => {
  it("preserves selected market and DOM through config, SDK restore and ordinary rerender", async () => {
    setup("MAIN_ACCOUNT_POC");
    const config = await memeApi.getConfig();
    const pending = deferred<typeof config>();
    vi.mocked(memeApi.getConfig)
      .mockClear()
      .mockResolvedValueOnce(config)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(config);
    const view = render(<Entry />);
    await screen.findByLabelText("AAA K 线图");
    fireEvent.click(screen.getByRole("button", { name: "查看 BBB" }));
    await screen.findByLabelText("BBB K 线图");
    const workspace = document.querySelector(".workspace");
    const chartNode = screen.getByLabelText("BBB K 线图");
    await act(async () => pending.resolve({ ...config, privy: { appId: "test", clientId: null } }));
    await waitFor(() =>
      expect(document.querySelector(".mock-badge")).toHaveTextContent("正在恢复登录会话"),
    );
    expect(document.querySelector(".workspace")).toBe(workspace);
    sdk.ready = true;
    sdk.authenticated = true;
    sdk.walletsReady = true;
    view.rerender(<Entry />);
    await waitFor(() =>
      expect(document.querySelector(".mock-badge")).toHaveAttribute("data-state", "connected"),
    );
    view.rerender(<Entry />);
    expect(document.querySelector(".workspace")).toBe(workspace);
    expect(screen.getByLabelText("BBB K 线图")).toBe(chartNode);
    expect(memeApi.getMarkets).toHaveBeenCalledTimes(1);
    expect(memeApi.getConfig).toHaveBeenCalledTimes(2);
  });
  it("clears private data on identity change without remounting markets and ignores old account responses", async () => {
    setup("MAIN_ACCOUNT_POC");
    const props: ComponentProps<typeof App> = {
      walletRequired: true,
      privyWallet: tokenA.tokenAddress,
      accountIdentity: "one",
    };
    vi.mocked(memeApi.getAccount).mockResolvedValue({
      ...summary,
      positions: [
        {
          tokenAddress: tokenA.tokenAddress,
          symbol: "PRIVATE",
          available: "7.25",
          costUsd: "5",
          valueUsd: "8",
        },
      ],
    });
    const view = render(<App {...props} />);
    await waitFor(() => expect(document.querySelector(".positions")).toHaveTextContent("PRIVATE"));
    fireEvent.click(screen.getByRole("button", { name: "查看 BBB" }));
    await screen.findByLabelText("BBB K 线图");
    const workspace = document.querySelector(".workspace");
    const late = deferred<Awaited<ReturnType<typeof memeApi.getAccount>>>();
    vi.mocked(memeApi.getAccount).mockReturnValue(late.promise);
    view.rerender(<App {...props} accountIdentity="two" privyWallet={tokenB.tokenAddress} />);
    expect(document.querySelector(".positions")).not.toHaveTextContent("PRIVATE");
    view.rerender(<App walletRequired accountIdentity="guest" />);
    await act(async () =>
      late.resolve({
        ...summary,
        positions: [
          {
            tokenAddress: tokenB.tokenAddress,
            symbol: "LATE",
            available: "9",
            costUsd: "5",
            valueUsd: "8",
          },
        ],
      }),
    );
    expect(document.querySelector(".positions")).not.toHaveTextContent("LATE");
    expect(document.querySelector(".workspace")).toBe(workspace);
    expect(screen.getByLabelText("BBB K 线图")).toBeTruthy();
    expect(memeApi.getMarkets).toHaveBeenCalledTimes(1);
  });
  it("switches tokens without restarting bootstrap and leaves detail failures local and retryable", async () => {
    setup("MAIN_ACCOUNT_POC");
    render(<App walletRequired />);
    await screen.findByLabelText("AAA K 线图");
    const workspace = document.querySelector(".workspace");
    vi.mocked(memeApi.getToken).mockRejectedValueOnce(new Error("detail unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "查看 BBB" }));
    await screen.findByText(/detail unavailable/);
    expect(document.querySelector(".workspace")).toBe(workspace);
    expect(screen.queryByText("正在加载", { exact: true })).toBeNull();
    expect(memeApi.getMarkets).toHaveBeenCalledTimes(1);
    expect(memeApi.getConfig).toHaveBeenCalledTimes(1);
  });
});
