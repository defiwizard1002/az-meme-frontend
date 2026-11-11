import { request, requestPublicMarket } from "./api";
import { formatUnits } from "viem";
import type { WalletPosition, WalletActivity, ActivityCursor } from "./wallet-types";
import type { Candle, CandleSnapshot, Interval, Token, Trade } from "./types";

export function chooseNewerCandle(previous: Candle | undefined, next: Candle): Candle {
  if (!previous || BigInt(next.revision) >= BigInt(previous.revision)) return next;
  return previous;
}

function visibleCandles(items: Candle[], gaps: CandleSnapshot["gaps"]): Candle[] {
  const suppressed = gaps.filter((gap) => gap.reason === "PRICING_SUPPRESSED");
  return suppressed.length
    ? items.filter((item) => !suppressed.some((gap) => item.t >= gap.from && item.t < gap.to))
    : items;
}

export function snapshotCandleSeries(snapshot: CandleSnapshot): NonNullable<Candle["series"]> {
  return snapshot.candleRules?.series ?? "USD";
}

export function mergeSnapshots(
  previous: CandleSnapshot | null,
  next: CandleSnapshot,
): CandleSnapshot {
  const nextItems = visibleCandles(
    next.items.filter((item) => (item.series ?? "USD") === snapshotCandleSeries(next)),
    next.gaps,
  );
  if (nextItems !== next.items) next = { ...next, items: nextItems };
  if (
    !previous ||
    previous.tokenAddress.toLowerCase() !== next.tokenAddress.toLowerCase() ||
    previous.marketKey !== next.marketKey ||
    snapshotCandleSeries(previous) !== snapshotCandleSeries(next) ||
    previous.interval !== next.interval
  )
    return next.gaps.length > 0 && next.availability === "COMPLETE"
      ? { ...next, availability: "PARTIAL" }
      : next;
  const byTime = new Map(previous.items.map((item) => [item.t, item]));
  for (const item of next.items) byTime.set(item.t, chooseNewerCandle(byTime.get(item.t), item));
  const retracted = new Map<number, string>();
  for (const r of [...(previous.retractions ?? []), ...(next.retractions ?? [])])
    if (!retracted.has(r.t) || BigInt(r.revision) > BigInt(retracted.get(r.t)!))
      retracted.set(r.t, r.revision);
  for (const [t, revision] of retracted) {
    const bar = byTime.get(t);
    if (bar && BigInt(bar.revision) > BigInt(revision)) retracted.delete(t);
    else byTime.delete(t);
  }
  const limits = [previous.coverage, next.coverage];
  const from = limits.map((value) => value.from).filter((value): value is number => value !== null);
  const to = limits.map((value) => value.to).filter((value): value is number => value !== null);
  // A complete page does not prove that gaps in other pages have been repaired.
  const gaps = [
    ...new Map(
      [...previous.gaps, ...next.gaps].map((gap) => [`${gap.from}:${gap.to}:${gap.reason}`, gap]),
    ).values(),
  ].sort((a, b) => a.from - b.from || a.to - b.to || a.reason.localeCompare(b.reason));
  const availability =
    previous.availability === "COMPLETE" && next.availability === "COMPLETE" && gaps.length === 0
      ? "COMPLETE"
      : previous.availability === "UNAVAILABLE_BEFORE_START" &&
          next.availability === "UNAVAILABLE_BEFORE_START" &&
          byTime.size === 0
        ? "UNAVAILABLE_BEFORE_START"
        : "PARTIAL";
  return {
    ...next,
    ...(retracted.size
      ? { retractions: [...retracted].map(([t, revision]) => ({ t, revision })) }
      : { retractions: [] }),
    availability,
    gaps,
    revision: BigInt(previous.revision) > BigInt(next.revision) ? previous.revision : next.revision,
    asOfBlock: Math.max(previous.asOfBlock ?? 0, next.asOfBlock ?? 0) || null,
    coverage: {
      from: from.length ? Math.min(...from) : null,
      to: to.length ? Math.max(...to) : null,
    },
    items: visibleCandles([...byTime.values()], gaps).sort((a, b) => a.t - b.t),
  };
}

export function mergeTrades(
  current: Trade[],
  incoming: Trade[],
  baseline?: ReadonlyMap<string, Trade>,
): Trade[] {
  const existing = new Map(current.map((trade) => [trade.tradeId, trade]));
  const byId = new Map<string, Trade>();
  // Trade has no revision. A GET may refresh only identities unchanged since its request began.
  // Reverse arrival remains the tie order; repeated IDs use the last item in the batch.
  for (const trade of [...incoming].reverse()) {
    if (
      !byId.has(trade.tradeId) &&
      (!baseline || existing.get(trade.tradeId) === baseline.get(trade.tradeId))
    ) {
      byId.set(trade.tradeId, trade);
    }
  }
  for (const trade of current) if (!byId.has(trade.tradeId)) byId.set(trade.tradeId, trade);
  return [...byId.values()].sort((left, right) => right.t - left.t).slice(0, 5000);
}

export const INTERVAL_SECONDS: Record<Interval, number> = {
  "1s": 1,
  "30s": 30,
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};
export interface Holder {
  address: string;
  name: string | null;
  avatarUrl: string | null;
  twitterUsername: string | null;
  quantity: string | null;
  valueUsd: string | null;
  supplyPct: string | null;
  boughtUsd: string | null;
  soldUsd: string | null;
  buyCount: number | null;
  sellCount: number | null;
  averageBuyMarketCapUsd: string | null;
  averageSellMarketCapUsd: string | null;
  realizedPnlUsd: string | null;
  unrealizedPnlUsd: string | null;
  riskLabels: string[];
  labels: string[];
  labelSource: "LOCAL_MANUAL";
}
export interface HolderPage {
  chainId: number;
  tokenAddress: string;
  source: "GMGN" | "LOCAL";
  observedAt: number | null;
  updatedAt: number | null;
  stale: boolean;
  complete: boolean;
  coverage: "BOUNDED_TOP_100" | "LOCAL_TRACKED_WALLETS";
  error: string | null;
  items: Holder[];
  nextCursor: string | null;
}
export type LocalHolderScope = "FOLLOWING" | "SMART_MONEY" | "KOL";
export interface LocalHolderPage {
  chainId: number;
  tokenAddress: string;
  source: "LOCAL";
  updatedAt: number | null;
  complete: boolean;
  coverage: "LOCAL_TRACKED_WALLETS";
  nextCursor: string | null;
  items: Array<
    WalletPosition & {
      labels: string[];
      labelSource: "LOCAL_MANUAL";
      name?: string | null;
      supplyPct?: string | null;
      buyCount?: number | null;
      sellCount?: number | null;
      averageBuyMarketCapUsd?: string | null;
      averageSellMarketCapUsd?: string | null;
    }
  >;
}
export interface MarkerPage {
  chainId: number;
  tokenAddress: string;
  source: "LOCAL";
  updatedAt: number | null;
  complete: boolean;
  items: WalletActivity[];
  nextCursor: ActivityCursor | null;
}
export const tokenApi = {
  detail: (address: string, signal?: AbortSignal) =>
    requestPublicMarket<Token>(`/sapi/v1/meme/tokens/${address}`, { signal }),
  holders: (address: string, cursor?: string, signal?: AbortSignal) =>
    requestPublicMarket<HolderPage>(
      `/sapi/v1/meme/tokens/${address}/holders?offset=${encodeURIComponent(cursor ?? "0")}&limit=50`,
      { signal },
    ),
  markers: (
    address: string,
    fromMs: number,
    toMs: number,
    before?: ActivityCursor,
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams({ fromMs: String(fromMs), toMs: String(toMs), limit: "500" });
    if (before) {
      query.set("beforeTime", String(before.timestampMs));
      query.set("beforeId", before.eventId);
    }
    return requestPublicMarket<MarkerPage>(`/sapi/v1/meme/tokens/${address}/markers?${query}`, {
      signal,
    });
  },
  localHolders: async (
    address: string,
    scope: LocalHolderScope,
    after?: string,
    signal?: AbortSignal,
  ): Promise<HolderPage> => {
    const query = new URLSearchParams({ scope, limit: "50" });
    if (after) query.set("after", after);
    const page = await (scope === "FOLLOWING" ? request : requestPublicMarket)<LocalHolderPage>(
      `/sapi/v1/meme/tokens/${address}/local-holders?${query}`,
      { signal },
    );
    return {
      ...page,
      observedAt: page.updatedAt,
      stale: false,
      error: null,
      items: page.items.map((position) => ({
        address: position.address,
        name: position.name ?? null,
        avatarUrl: null,
        twitterUsername: null,
        quantity:
          position.quantityComplete && position.quantityAtomic !== null
            ? formatUnits(BigInt(position.quantityAtomic), position.decimals)
            : null,
        valueUsd: position.valueUsd ?? null,
        supplyPct: position.supplyPct ?? null,
        boughtUsd: position.boughtUsd,
        soldUsd: position.soldUsd,
        buyCount: position.buyCount ?? null,
        sellCount: position.sellCount ?? null,
        averageBuyMarketCapUsd: position.averageBuyMarketCapUsd ?? null,
        averageSellMarketCapUsd: position.averageSellMarketCapUsd ?? null,
        realizedPnlUsd: position.realizedPnlUsd,
        unrealizedPnlUsd: position.unrealizedPnlUsd ?? null,
        riskLabels: [],
        labels: position.labels,
        labelSource: position.labelSource,
      })),
    };
  },
};
