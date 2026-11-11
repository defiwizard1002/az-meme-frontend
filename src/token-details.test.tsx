import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TokenDetails, buildTradeMarkers } from "./TokenDetails";
import type { Candle, CandleSnapshot, Token, Trade } from "./types";
import { memeApi } from "./api";
import { tokenApi } from "./token-api";
vi.mock("./api", () => ({
  requestPublicMarket: vi.fn(),
  wsBaseUrl: "ws://localhost/stream",
  memeApi: { getCandles: vi.fn(), getTrades: vi.fn(), getWsTicket: vi.fn() },
}));
vi.mock("./CandleChart", () => ({
  CandleChart: ({
    markers,
    candles,
    onLoadBefore,
  }: {
    markers: unknown[];
    candles: Candle[];
    onLoadBefore: (before: number) => Promise<unknown>;
  }) => (
    <div data-testid="chart" data-markers={markers.length} data-candles={candles.length}>
      <button onClick={() => void onLoadBefore((candles[0]?.t ?? 120) - 1)}>Earlier candles</button>
    </div>
  ),
}));
expect.extend(matchers);
const a = "0x1111111111111111111111111111111111111111",
  b = "0x2222222222222222222222222222222222222222";
const token = {
  chainId: 4663,
  tokenAddress: a,
  symbol: "TEST",
  name: "Test",
  priceUsd: null,
  marketCapUsd: null,
  volume24hUsd: null,
  change24h: null,
  holders: null,
  ageSeconds: null,
  security: { isHoneypot: null, buyTaxPct: null, sellTaxPct: null },
} as Token;
const trades = [
  {
    tradeId: "1",
    t: 120,
    side: "BUY",
    notionalUsd: "500",
    baseAmount: "50",
    priceUsd: "10",
    trader: b,
    txHash: "0xtx",
    wallets: [
      { address: b, labels: ["SMART_MONEY"], labelSource: "LOCAL_MANUAL", marketCapUsd: "15000" },
    ],
  },
] as Trade[];
const prepareScenario1 = () => {
  vi.stubGlobal("WebSocket", undefined);
  vi.spyOn(tokenApi, "detail").mockResolvedValue(token);
  vi.spyOn(tokenApi, "markers").mockRejectedValue(new Error("Unavailable"));
  vi.mocked(memeApi.getWsTicket).mockResolvedValue({
    ticket: "public-test-ticket",
    expiresAt: Date.now() + 60_000,
  });
  vi.mocked(memeApi.getCandles).mockResolvedValue({
    chainId: 4663,
    tokenAddress: a,
    marketKey: "USD:USDG",
    interval: "1m",
    syncStatus: "READY",
    availability: "COMPLETE",
    source: "CHAIN",
    coverage: { from: null, to: null },
    gaps: [],
    revision: "1",
    asOfBlock: 1,
    items: [],
  });
  vi.mocked(memeApi.getTrades).mockResolvedValue({ items: trades, nextCursor: null });
};
beforeEach(prepareScenario1);
const cleanScenario2 = () => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
};
afterEach(cleanScenario2);
it("token-details: 5 related scenarios", async () => {
  // shows actual wallets, coverage, all periods and local marker filters without invented identities
  await (async () => {
    const profile = vi.fn();
    render(<TokenDetails token={token} onProfile={profile} walletAddress={b} />);
    await screen.findByRole("button", { name: `查看钱包 ${b}` });
    fireEvent.click(screen.getByRole("button", { name: `查看钱包 ${b}` }));
    expect(profile).toHaveBeenCalledWith(b);
    for (const period of ["1s", "30s", "1m", "5m", "15m", "1h", "4h", "1d"])
      expect(screen.getByRole("button", { name: period })).toBeVisible();
    for (const label of ["Smart", "KOL", "My Trades"])
      expect(screen.getByRole("checkbox", { name: label })).toBeChecked();
    expect(screen.getByTestId("chart")).toHaveAttribute("data-markers", "1");
    expect(screen.queryByText("Views")).toBeNull();
    expect(
      buildTradeMarkers([{ ...trades[0]!, wallets: undefined }], "1m", b, {
        smart: true,
        kol: true,
        mine: true,
      }),
    ).toHaveLength(0);
  })();
  await cleanScenario2();
  await prepareScenario1();
  // pages holders and following filter does not claim absent wallets have zero holdings
  await (async () => {
    const holder = {
      address: b,
      name: null,
      quantity: "10",
      valueUsd: "20",
      supplyPct: "1",
      labels: ["KOL"],
      riskLabels: ["dev"],
      labelSource: "LOCAL_MANUAL",
    };
    const load = vi.spyOn(tokenApi, "holders").mockResolvedValue({
      chainId: 4663,
      tokenAddress: a,
      source: "GMGN",
      observedAt: 1000,
      updatedAt: 1000,
      stale: true,
      complete: false,
      coverage: "BOUNDED_TOP_100",
      error: null,
      items: [holder],
      nextCursor: "50",
    } as any);
    const local = vi.spyOn(tokenApi, "localHolders").mockRejectedValue(new Error("Unavailable"));
    render(<TokenDetails token={token} onProfile={() => {}} follows={[]} walletAddress={a} />);
    fireEvent.click(screen.getByRole("tab", { name: "Holders" }));
    await screen.findByText("Dev");
    expect(screen.getByText(/最多前 100 名/)).toBeVisible();
    expect(screen.getByText(/不代表其余额为零/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "加载更多持有人" }));
    await waitFor(() => expect(load).toHaveBeenCalledWith(a, "50", expect.any(AbortSignal)));
    fireEvent.click(screen.getByRole("button", { name: "Following" }));
    await waitFor(() =>
      expect(local).toHaveBeenCalledWith(a, "FOLLOWING", undefined, expect.any(AbortSignal)),
    );
    expect(await screen.findByText(/本地持有人暂不可用/)).toBeVisible();
    expect(screen.queryByText("Dev")).toBeNull();
  })();
  await cleanScenario2();
  await prepareScenario1();
  // ignores late detail response after switching tokens
  await (async () => {
    let resolve!: (t: Token) => void;
    vi.mocked(tokenApi.detail).mockImplementation((address) =>
      address === a
        ? new Promise((r) => {
            resolve = r;
          })
        : Promise.resolve({ ...token, tokenAddress: b, symbol: "NEW" }),
    );
    const update = vi.fn();
    const view = render(<TokenDetails token={token} onProfile={() => {}} onTokenUpdate={update} />);
    view.rerender(
      <TokenDetails
        token={{ ...token, tokenAddress: b, symbol: "NEW" }}
        onProfile={() => {}}
        onTokenUpdate={update}
      />,
    );
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ tokenAddress: b })),
    );
    await act(async () => resolve(token));
    expect(update).not.toHaveBeenCalledWith(expect.objectContaining({ tokenAddress: a }));
  })();
  await cleanScenario2();
  await prepareScenario1();
  // loads local historical marker pages and expands the range when older candles arrive
  await (async () => {
    vi.mocked(memeApi.getCandles).mockImplementation((_address, _interval, options) =>
      Promise.resolve(chartPage([bar(options?.to ? 60 : 120)])),
    );
    vi.mocked(memeApi.getTrades).mockResolvedValue({ items: [], nextCursor: null });
    const activity = {
      eventId: "one",
      chainId: 4663,
      address: b,
      token: a,
      txHash: "old-tx",
      timestampMs: 120_000,
      kind: "BUY",
      labels: ["SMART_MONEY"],
      labelSource: "LOCAL_MANUAL",
      source: "LOCAL_TRANSFERS",
    };
    const cursor = { timestampMs: 120_000, eventId: "one" };
    vi.mocked(tokenApi.markers).mockImplementation(
      async (_address, _from, _to, before) =>
        ({
          chainId: 4663,
          tokenAddress: a,
          source: "LOCAL",
          updatedAt: 120_000,
          complete: true,
          items: [
            before
              ? { ...activity, eventId: "two", txHash: "second-tx", labels: ["KOL"] }
              : activity,
          ],
          nextCursor: before ? null : cursor,
        }) as any,
    );
    render(<TokenDetails token={token} onProfile={() => {}} />);
    await screen.findByRole("button", { name: "加载更多历史标记" });
    expect(screen.getByTestId("chart")).toHaveAttribute("data-markers", "1");
    fireEvent.click(screen.getByRole("button", { name: "加载更多历史标记" }));
    await waitFor(() => expect(screen.getByTestId("chart")).toHaveAttribute("data-markers", "2"));
    expect(tokenApi.markers).toHaveBeenCalledWith(
      a,
      120_000,
      179_999,
      cursor,
      expect.any(AbortSignal),
    );
    fireEvent.click(screen.getByRole("button", { name: "Earlier candles" }));
    await waitFor(() =>
      expect(tokenApi.markers).toHaveBeenCalledWith(
        a,
        60_000,
        179_999,
        undefined,
        expect.any(AbortSignal),
      ),
    );
  })();
  await cleanScenario2();
  await prepareScenario1();
  // repairs missing stream batches, retains live candles over older reads, and reconnects publicly
  await (async () => {
    const instances: Socket[] = [];
    class Socket extends EventTarget {
      static OPEN = 1;
      readyState = 0;
      send = vi.fn();
      constructor(_url: string) {
        super();
        instances.push(this);
      }
      close() {
        this.readyState = 3;
        this.dispatchEvent(new Event("close"));
      }
      open() {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      }
      message(sequence: number, data: unknown, channel = `candle:${a}:USD:USDG:1m`) {
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              channel,
              epoch: "one",
              sequence,
              data,
            }),
          }),
        );
      }
    }
    vi.stubGlobal("WebSocket", Socket);
    vi.mocked(memeApi.getCandles).mockResolvedValue(chartPage([bar(120)]));
    const update = vi.fn();
    vi.mocked(tokenApi.detail).mockResolvedValue({
      ...token,
      website: "https://example.test",
      security: { ...token.security, top10HolderPct: "20" },
    });
    render(<TokenDetails token={token} onProfile={() => {}} onTokenUpdate={update} />);
    await waitFor(() => expect(instances).toHaveLength(1));
    await act(async () => instances[0]!.open());
    expect(JSON.parse(instances[0]!.send.mock.calls[0]![0]).channels).toContain(`market:${a}`);
    await act(async () =>
      instances[0]!.message(
        1,
        {
          items: [
            {
              chainId: 4663,
              tokenAddress: a,
              priceUsd: "2",
              priceObservedAt: 2000,
              liveRevision: "2",
              marketCapUsd: "2000",
              name: null,
              symbol: null,
              website: null,
              tradeStatus: "TRADABLE",
              security: { isHoneypot: true, top10HolderPct: null },
            },
          ],
        },
        `market:${a}`,
      ),
    );
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        priceUsd: "2",
        marketCapUsd: "2000",
        symbol: "TEST",
        name: "Test",
        website: "https://example.test",
        tradeStatus: "TRADABLE",
        security: expect.objectContaining({ isHoneypot: true, top10HolderPct: "20" }),
      }),
    );
    await act(async () =>
      instances[0]!.message(
        2,
        {
          items: [
            {
              chainId: 4663,
              tokenAddress: a,
              priceUsd: "9",
              priceObservedAt: 1000,
              liveRevision: "1",
            },
          ],
        },
        `market:${a}`,
      ),
    );
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ priceUsd: "2" }));
    const detailReads = vi.mocked(tokenApi.detail).mock.calls.length;
    await act(async () =>
      instances[0]!.message(
        4,
        {
          items: [
            {
              chainId: 4663,
              tokenAddress: a,
              priceUsd: "3",
              marketCapUsd: null,
              priceObservedAt: 3000,
              liveRevision: "3",
              security: { isHoneypot: null },
            },
          ],
        },
        `market:${a}`,
      ),
    );
    expect(tokenApi.detail).toHaveBeenCalledTimes(detailReads + 1);
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        priceUsd: "3",
        marketCapUsd: null,
        symbol: "TEST",
        website: "https://example.test",
        security: expect.objectContaining({ isHoneypot: true, top10HolderPct: "20" }),
      }),
    );
    const before = vi.mocked(memeApi.getCandles).mock.calls.length;
    await act(async () => {
      instances[0]!.message(1, bar(180));
      instances[0]!.message(3, bar(240));
    });
    await waitFor(() => expect(memeApi.getCandles).toHaveBeenCalledTimes(before + 1));
    expect(screen.getByTestId("chart")).toHaveAttribute("data-candles", "3");
    await act(async () =>
      instances[0]!.message(4, { ...bar(180), retracted: true, revision: "5" }),
    );
    expect(screen.getByTestId("chart")).toHaveAttribute("data-candles", "2");
    vi.useFakeTimers();
    await act(async () => {
      instances[0]!.close();
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(instances).toHaveLength(2);
    expect(memeApi.getWsTicket).toHaveBeenLastCalledWith(expect.any(AbortSignal), true);
  })();
});

const bar = (t: number): Candle => ({
  t,
  o: "1",
  h: "1",
  l: "1",
  c: "1",
  previousClose: null,
  baseVolume: "1",
  quoteVolume: "1",
  revision: "1",
});
const chartPage = (items: Candle[]): CandleSnapshot => ({
  chainId: 4663,
  tokenAddress: a,
  marketKey: "USD:USDG",
  interval: "1m",
  syncStatus: "READY",
  availability: "COMPLETE",
  source: "CHAIN",
  coverage: { from: 60, to: 240 },
  gaps: [],
  revision: "1",
  asOfBlock: 1,
  items,
});
