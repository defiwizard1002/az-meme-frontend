import { DesignIcon } from "./DesignIcon";
import Views from "./Callout";
import { Portfolio } from "./Portfolio";
import { amount as displayAmount, money, percent, compactMoney, age } from "./display";
import { mergeLiveToken } from "./discovery";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { memeApi, wsBaseUrl } from "./api";
import { CandleChart, type ChartTradeMarker, type HistoryLoadResult } from "./CandleChart";
import { TokenRiskGrid } from "./TokenRiskLabels";
import {
  INTERVAL_SECONDS,
  mergeSnapshots,
  mergeTrades,
  snapshotCandleSeries,
  tokenApi,
  type HolderPage,
  type LocalHolderScope,
} from "./token-api";
import { streamBatchItems, streamSequenceAction } from "./stream-batches";
import type { ActivityCursor, WalletActivity } from "./wallet-types";
import type { Candle, CandleSnapshot, Interval, Token, Trade } from "./types";

interface Props {
  token: Token;
  walletAddress?: string | null;
  follows?: readonly string[];
  onProfile: (address: string) => void;
  onWatch?: () => void;
  watched?: boolean;
  onTokenUpdate?: (token: Token) => void;
  children?: ReactNode;
  onSell?: (address: string) => void;
  explorerBaseUrl?: string;
}
const EMPTY_FOLLOWS: readonly string[] = [];
const amount = (value: string | number | null | undefined, unit = "") =>
  unit === "$" ? compactMoney(value) : displayAmount(value);
const addressLabel = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
const date = (value: number | null | undefined) =>
  value ? new Date(value).toLocaleString() : "Update time unknown";
function TradeValue({ value }: { value: string | null | undefined }) {
  return (
    <span className="trade-value">
      {compactMoney(value)
        .split(/(\.\d+)/)
        .map((part, index) => (part.startsWith(".") ? <small key={index}>{part}</small> : part))}
    </span>
  );
}
function socialUrl(raw: string | null | undefined, kind: string): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (kind === "X" && /^[\w@]{1,16}$/.test(value))
    return `https://x.com/${value.replace(/^@/, "")}`;
  if (kind === "Telegram" && /^[\w@]+$/.test(value))
    return `https://t.me/${value.replace(/^@/, "")}`;
  return /^https?:\/\//i.test(value) ? value : null;
}
export function buildTradeMarkers(
  trades: Pick<Trade, "t" | "side" | "txHash" | "wallets">[],
  interval: Interval,
  walletAddress: string | null | undefined,
  filters: { smart: boolean; kol: boolean; mine: boolean },
): ChartTradeMarker[] {
  return trades.flatMap((trade) => {
    const labels = new Set<string>();
    for (const wallet of trade.wallets ?? []) {
      if (wallet.labelSource !== "LOCAL_MANUAL") continue;
      if (filters.smart && wallet.labels.includes("SMART_MONEY")) labels.add("Smart");
      if (filters.kol && wallet.labels.includes("KOL")) labels.add("KOL");
      if (filters.mine && walletAddress?.toLowerCase() === wallet.address.toLowerCase())
        labels.add("My");
    }
    return labels.size
      ? [
          {
            time: Math.floor(trade.t / INTERVAL_SECONDS[interval]) * INTERVAL_SECONDS[interval],
            side: trade.side,
            label: `${[...labels].join(" / ")} ${trade.side === "BUY" ? "Buy" : "Sell"}`,
          },
        ]
      : [];
  });
}
// A token switch unmounts all outstanding reads and private view state before the next token loads.
export function TokenDetails(props: Props) {
  return (
    <TokenWorkspace
      key={`${props.token.chainId}:${props.token.tokenAddress.toLowerCase()}:${props.walletAddress?.toLowerCase() ?? "guest"}`}
      {...props}
    />
  );
}
function TokenWorkspace({
  token: initial,
  walletAddress,
  follows = EMPTY_FOLLOWS,
  onProfile,
  onWatch,
  watched = false,
  onTokenUpdate,
  children,
  onSell,
  explorerBaseUrl,
}: Props) {
  const address = initial.tokenAddress.toLowerCase();
  const chainId = initial.chainId;
  const [detail, setDetail] = useState<Token | null>(null);
  const token = detail ?? initial;
  const detailRef = useRef(initial);
  const liveFieldsRef = useRef<Partial<Token>>({});
  const refreshDetailRef = useRef<() => void>(() => {});
  const [marketLive, setMarketLive] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [interval, setInterval] = useState<Interval>("1m");
  const [tab, setTab] = useState<"views" | "trades" | "holders" | "safety" | "positions">("views");
  const [snapshot, setSnapshot] = useState<CandleSnapshot | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [tradeCursor, setTradeCursor] = useState<string | null>(null);
  const [tradesLoading, setTradesLoading] = useState(false);
  const [holders, setHolders] = useState<HolderPage | null>(null);
  const [holdersLoading, setHoldersLoading] = useState(false);
  const [holdersError, setHoldersError] = useState<string | null>(null);
  const [holdersRetry, setHoldersRetry] = useState(0);
  const [holderRisk, setHolderRisk] = useState<string | null>(null);
  const [holderScope, setHolderScope] = useState<"ALL" | LocalHolderScope>("ALL");
  const [chartLoading, setChartLoading] = useState(true);
  const [chartError, setChartError] = useState<string | null>(null);
  const [tradeError, setTradeError] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [markerFilters, setMarkerFilters] = useState({ smart: true, kol: true, mine: true });
  const [copyState, setCopyState] = useState<string | null>(null);
  const [historicalMarkers, setHistoricalMarkers] = useState<WalletActivity[]>([]);
  const [markerCursor, setMarkerCursor] = useState<ActivityCursor | null>(null);
  const [markerLoading, setMarkerLoading] = useState(false);
  const [markerError, setMarkerError] = useState<string | null>(null);
  const moreMarkersRef = useRef<() => void>(() => {});

  const chartCache = useRef(new Map<Interval, CandleSnapshot>());
  const snapshotRef = useRef<CandleSnapshot | null>(null);
  const tradesRef = useRef<Trade[]>([]);
  const tradeCursorRef = useRef<string | null>(null);
  const olderTradesRef = useRef(false);
  const updateRef = useRef(onTokenUpdate);
  const loadBeforeRef = useRef<(before: number) => Promise<HistoryLoadResult>>(async () => ({
    added: 0,
    exhausted: false,
  }));
  const loadTradesRef = useRef<() => void>(() => {});
  const holderController = useRef<AbortController | null>(null);
  useEffect(() => {
    updateRef.current = onTokenUpdate;
  }, [onTokenUpdate]);

  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    const refresh = () => {
      if (loading || document.visibilityState === "hidden") return;
      loading = true;
      const previousSecurity = detailRef.current.security;
      void tokenApi
        .detail(address, controller.signal)
        .then((value) => {
          if (controller.signal.aborted) return;
          if (value.chainId !== chainId || value.tokenAddress.toLowerCase() !== address)
            throw Error("Token response does not match the current selection");
          const newerRisk = Object.fromEntries(
            Object.entries(detailRef.current.security).filter(
              ([key, field]) =>
                field != null && field !== previousSecurity[key as keyof Token["security"]],
            ),
          );
          const merged = {
            ...mergeLiveToken(value, { ...liveFieldsRef.current, chainId, tokenAddress: address }),
            security: {
              ...detailRef.current.security,
              ...Object.fromEntries(
                Object.entries(value.security).filter(([, field]) => field != null),
              ),
              ...newerRisk,
            },
          };
          detailRef.current = merged;
          setDetail(merged);
          setDetailError(null);
          updateRef.current?.(merged);
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setDetailError("Token update failed. Showing the last result");
        })
        .finally(() => {
          loading = false;
        });
    };
    refreshDetailRef.current = refresh;
    refresh();
    const timer = window.setInterval(refresh, 15 * 60_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [address, chainId, retry]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let candleFlight = false,
      tradeFlight = false,
      historyFlight = false;
    let candleDirty = false,
      tradeDirty = false;
    let candleAttempt = 0,
      tradeAttempt = 0;
    let candleTimer: number | undefined,
      tradeTimer: number | undefined,
      reconnectTimer: number | undefined,
      openTimer: number | undefined;
    let socket: WebSocket | null = null;
    let connecting = false,
      reconnectAttempt = 0,
      lastActivity = Date.now(),
      lastResume = 0;
    const sequences = new Map<string, { epoch: string; sequence: number }>();
    const cached = chartCache.current.get(interval) ?? null;
    snapshotRef.current = cached;
    setSnapshot(cached);
    setChartLoading(!cached);
    setChartError(null);
    const marketKey = cached?.marketKey ?? "USD:USDG";
    const candleChannel = `candle:${address}:${marketKey}:${interval}`;
    const tradeChannel = `trade:${address}:${marketKey}`;
    const marketChannel = `market:${address}`;
    const hidden = () => document.visibilityState === "hidden";
    const saveSnapshot = (value: CandleSnapshot) => {
      snapshotRef.current = value;
      chartCache.current.set(interval, value);
      setSnapshot(value);
    };
    const recoverCandles = () => {
      candleDirty = true;
      if (!active || hidden() || candleFlight) return;
      window.clearTimeout(candleTimer);
      candleTimer = undefined;
      candleFlight = true;
      candleDirty = false;
      void memeApi
        .getCandles(address, interval, { signal: controller.signal })
        .then((page) => {
          if (!active) return;
          if (
            page.chainId !== chainId ||
            page.tokenAddress.toLowerCase() !== address ||
            page.interval !== interval ||
            page.marketKey !== marketKey
          )
            throw Error("Candles do not match the current selection");
          const current = snapshotRef.current;
          saveSnapshot(
            mergeSnapshots(current?.items.length || current?.gaps.length ? current : null, page),
          );
          setChartLoading(false);
          if (page.syncStatus === "STALE" || page.syncStatus === "FAILED")
            throw Error("Candles are temporarily unavailable");
          setChartError(null);
          candleAttempt = 0;
          if (page.syncStatus === "BACKFILLING" || page.syncStatus === "CATCHING_UP")
            candleDirty = true;
        })
        .catch(() => {
          if (active) {
            setChartError("Candles failed to load");
            setChartLoading(false);
            candleDirty = true;
          }
        })
        .finally(() => {
          candleFlight = false;
          if (active && candleDirty && !hidden())
            candleTimer = window.setTimeout(
              recoverCandles,
              Math.min(30_000, 2_000 * 2 ** Math.min(candleAttempt++, 4)),
            );
        });
    };
    const recoverTrades = () => {
      tradeDirty = true;
      if (!active || hidden() || tradeFlight) return;
      window.clearTimeout(tradeTimer);
      tradeTimer = undefined;
      tradeFlight = true;
      tradeDirty = false;
      setTradesLoading(true);
      const baseline = new Map(tradesRef.current.map((trade) => [trade.tradeId, trade]));
      void memeApi
        .getTrades(address, undefined, controller.signal)
        .then((page) => {
          if (!active) return;
          tradesRef.current = mergeTrades(tradesRef.current, page.items, baseline);
          setTrades(tradesRef.current);
          if (!olderTradesRef.current) {
            tradeCursorRef.current = page.nextCursor;
            setTradeCursor(page.nextCursor);
          }
          setTradeError(null);
          tradeAttempt = 0;
        })
        .catch(() => {
          if (active) {
            setTradeError("Trade update failed. Retrying");
            tradeDirty = true;
          }
        })
        .finally(() => {
          tradeFlight = false;
          if (active) setTradesLoading(false);
          if (active && tradeDirty && !hidden())
            tradeTimer = window.setTimeout(
              recoverTrades,
              Math.min(30_000, 1_000 * 2 ** Math.min(tradeAttempt++, 5)),
            );
        });
    };
    loadBeforeRef.current = async (before) => {
      const current = snapshotRef.current;
      const series = current ? snapshotCandleSeries(current) : undefined;
      const page = await memeApi.getCandles(address, interval, {
        to: before,
        limit: 300,
        series,
        signal: controller.signal,
      });
      if (!active) return { added: 0, exhausted: false };
      if (
        page.chainId !== chainId ||
        page.tokenAddress.toLowerCase() !== address ||
        page.interval !== interval ||
        page.marketKey !== marketKey ||
        (series && snapshotCandleSeries(page) !== series)
      )
        throw Error("Historical candles do not match the current selection");
      if (page.syncStatus === "FAILED" || page.syncStatus === "STALE")
        throw Error("Historical candles are unavailable");
      const count = snapshotRef.current?.items.length ?? 0;
      const merged = mergeSnapshots(snapshotRef.current, page);
      saveSnapshot(merged);
      return {
        added: Math.max(0, merged.items.length - count),
        exhausted: page.items.length === 0 && page.syncStatus === "READY",
      };
    };
    loadTradesRef.current = () => {
      const cursor = tradeCursorRef.current;
      if (!cursor || historyFlight || !active) return;
      historyFlight = true;
      setTradesLoading(true);
      const baseline = new Map(tradesRef.current.map((trade) => [trade.tradeId, trade]));
      void memeApi
        .getTrades(address, cursor, controller.signal)
        .then((page) => {
          if (!active) return;
          olderTradesRef.current = true;
          tradesRef.current = mergeTrades(tradesRef.current, page.items, baseline);
          setTrades(tradesRef.current);
          tradeCursorRef.current = tradesRef.current.length >= 5000 ? null : page.nextCursor;
          setTradeCursor(tradeCursorRef.current);
          setTradeError(null);
        })
        .catch(() => {
          if (active) setTradeError("Earlier trades failed to load. Try again");
        })
        .finally(() => {
          historyFlight = false;
          if (active) setTradesLoading(false);
        });
    };
    const reconnect = () => {
      if (!active || hidden() || reconnectTimer !== undefined || typeof WebSocket === "undefined")
        return;
      reconnectTimer = window.setTimeout(
        () => {
          reconnectTimer = undefined;
          void connect();
        },
        Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt++, 5)),
      );
    };
    const connect = async () => {
      if (
        !active ||
        hidden() ||
        connecting ||
        (socket && socket.readyState < 2) ||
        typeof WebSocket === "undefined"
      )
        return;
      connecting = true;
      try {
        const { ticket } = await memeApi.getWsTicket(controller.signal, true);
        if (!active || hidden()) return;
        const next = new WebSocket(`${wsBaseUrl}?ticket=${encodeURIComponent(ticket)}`);
        socket = next;
        openTimer = window.setTimeout(() => {
          if (next.readyState !== WebSocket.OPEN) next.close();
        }, 10_000);
        next.addEventListener("open", () => {
          if (!active || socket !== next) {
            next.close();
            return;
          }
          window.clearTimeout(openTimer);
          lastActivity = Date.now();
          reconnectAttempt = 0;
          setStreamError(null);
          next.send(
            JSON.stringify({
              op: "subscribe",
              channels: [candleChannel, tradeChannel, marketChannel],
            }),
          );
          recoverCandles();
          recoverTrades();
        });
        next.addEventListener("message", (event) => {
          if (!active || socket !== next) return;
          lastActivity = Date.now();
          try {
            const message = JSON.parse(String(event.data)) as {
              channel: string;
              epoch: string;
              sequence: number;
              data: Candle | Trade | Token | { items: Candle[] | Trade[] };
            };
            if (![candleChannel, tradeChannel, marketChannel].includes(message.channel)) return;
            const action = streamSequenceAction(sequences.get(message.channel), message);
            if (action === "DUPLICATE") return;
            sequences.set(message.channel, { epoch: message.epoch, sequence: message.sequence });
            if (message.channel === marketChannel) {
              const incoming = streamBatchItems(message.data as Token | { items: Token[] }).find(
                (item) => item.tokenAddress?.toLowerCase() === address,
              );
              if (!incoming) return;
              if (incoming.chainId !== chainId || incoming.tokenAddress.toLowerCase() !== address)
                throw Error("Market data does not match this token");
              const fields = Object.fromEntries(
                (
                  [
                    "priceUsd",
                    "priceObservedAt",
                    "priceSource",
                    "liveRevision",
                    "asOfBlock",
                    "priceQuote",
                    "marketCapUsd",
                    "liquidityUsd",
                    "volume1hUsd",
                    "volume24hUsd",
                    "change1h",
                    "change24h",
                    "change5m",
                    "tradeStatus",
                    "pool",
                    "quoteAssetKey",
                    "stage",
                    "lifecycle",
                  ] as const
                )
                  .filter((key) => key in incoming)
                  .map((key) => [key, incoming[key]]),
              ) as Partial<Token>;
              if (fields.stage === "UNKNOWN") delete fields.stage;
              if (fields.lifecycle?.state === "UNKNOWN") delete fields.lifecycle;
              const security = {
                ...detailRef.current.security,
                ...Object.fromEntries(
                  Object.entries(incoming.security ?? {}).filter(([, value]) => value != null),
                ),
              };
              const merged = mergeLiveToken(detailRef.current, {
                ...fields,
                security,
                chainId,
                tokenAddress: address,
              });
              if (merged === detailRef.current) return;
              liveFieldsRef.current = { ...liveFieldsRef.current, ...fields };
              detailRef.current = merged;
              setDetail(merged);
              setMarketLive(true);
              updateRef.current?.(merged);
              if (action === "RESYNC") refreshDetailRef.current();
            } else if (message.channel === candleChannel) {
              const batch = streamBatchItems(message.data as Candle | { items: Candle[] });
              const current = snapshotRef.current;
              if (current) {
                const matching = batch.filter(
                  (bar) => (bar.series ?? "USD") === snapshotCandleSeries(current),
                );
                saveSnapshot(
                  mergeSnapshots(current, {
                    ...current,
                    items: matching.filter((bar) => !bar.retracted),
                    retractions: matching
                      .filter((bar) => bar.retracted)
                      .map((bar) => ({ t: bar.t, revision: bar.revision })),
                  }),
                );
                if (matching.length !== batch.length) recoverCandles();
              }
              if (action === "RESYNC" || !current) recoverCandles();
            } else {
              const batch = streamBatchItems(message.data as Trade | { items: Trade[] });
              tradesRef.current = mergeTrades(tradesRef.current, batch);
              setTrades(tradesRef.current);
              // One shared page read per burst fills wallet identities absent from raw stream records.
              if (tradeTimer === undefined)
                tradeTimer = window.setTimeout(() => {
                  tradeTimer = undefined;
                  recoverTrades();
                }, 500);
            }
          } catch {
            setStreamError("Live market data disconnected. Reconnecting");
            next.close();
          }
        });
        next.addEventListener("error", () => next.close());
        next.addEventListener("close", () => {
          if (socket !== next) return;
          socket = null;
          window.clearTimeout(openTimer);
          if (active && !hidden()) setStreamError("Live market data disconnected. Reconnecting");
          reconnect();
        });
      } catch {
        if (active) {
          setStreamError("Live market data disconnected. History remains available");
          reconnect();
        }
      } finally {
        connecting = false;
      }
    };
    const resume = () => {
      if (hidden()) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
        return;
      }
      if (Date.now() - lastResume < 2_000) return;
      lastResume = Date.now();
      if (socket && Date.now() - lastActivity >= 30_000) {
        const retired = socket;
        socket = null;
        retired.close();
      }
      window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      recoverCandles();
      recoverTrades();
      void connect();
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("pageshow", resume);
    recoverCandles();
    recoverTrades();
    void connect();
    return () => {
      active = false;
      controller.abort();
      socket?.close();
      for (const timer of [candleTimer, tradeTimer, reconnectTimer, openTimer])
        window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("pageshow", resume);
    };
  }, [address, chainId, interval, retry]);

  const earliestCandle = snapshot?.items[0]?.t;
  useEffect(() => {
    const candles = snapshotRef.current?.items;
    if (earliestCandle === undefined || !candles?.length) {
      setHistoricalMarkers([]);
      setMarkerCursor(null);

      setMarkerLoading(false);
      setMarkerError(null);
      return;
    }
    const controller = new AbortController();
    const fromMs = earliestCandle * 1000;
    const toMs = (candles.at(-1)!.t + INTERVAL_SECONDS[interval]) * 1000 - 1;
    let cursor: ActivityCursor | undefined;
    let loading = false;
    setHistoricalMarkers([]);
    setMarkerCursor(null);

    const load = () => {
      if (loading || controller.signal.aborted) return;
      loading = true;
      setMarkerLoading(true);
      void tokenApi
        .markers(address, fromMs, toMs, cursor, controller.signal)
        .then((page) => {
          if (controller.signal.aborted) return;
          if (
            page.chainId !== chainId ||
            page.tokenAddress.toLowerCase() !== address ||
            page.source !== "LOCAL"
          )
            throw Error("Historical markers do not match the current selection");
          setHistoricalMarkers((current) => [
            ...new Map([...current, ...page.items].map((item) => [item.eventId, item])).values(),
          ]);
          cursor = page.nextCursor ?? undefined;
          setMarkerCursor(page.nextCursor);

          setMarkerError(null);
        })
        .catch(() => {
          if (!controller.signal.aborted) setMarkerError("Historical markers unavailable");
        })
        .finally(() => {
          loading = false;
          if (!controller.signal.aborted) setMarkerLoading(false);
        });
    };
    moreMarkersRef.current = load;
    load();
    return () => controller.abort();
  }, [address, chainId, earliestCandle, interval, retry]);

  useEffect(() => {
    if (tab !== "holders") return;
    const controller = new AbortController();
    holderController.current = controller;
    setHolders(null);
    if (holderScope === "FOLLOWING" && !walletAddress) {
      setHoldersLoading(false);
      setHoldersError("Connect wallet to view following positions");
      return () => controller.abort();
    }
    setHoldersLoading(true);
    setHoldersError(null);
    const read =
      holderScope === "ALL"
        ? tokenApi.holders(address, undefined, controller.signal)
        : tokenApi.localHolders(address, holderScope, undefined, controller.signal);
    void read
      .then((page) => {
        if (controller.signal.aborted) return;
        if (page.chainId !== chainId || page.tokenAddress.toLowerCase() !== address)
          throw Error("Holders do not match the current selection");
        setHolders(page);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setHoldersError(
            holderScope === "ALL"
              ? "Holders failed to load. Try again"
              : "Filtered holders unavailable. Try again",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setHoldersLoading(false);
      });
    return () => {
      controller.abort();
    };
  }, [address, chainId, tab, holdersRetry, holderScope, walletAddress, follows]);
  const moreHolders = () => {
    const cursor = holders?.nextCursor,
      controller = holderController.current;
    if (!cursor || !controller || holdersLoading) return;
    setHoldersLoading(true);
    const read =
      holderScope === "ALL"
        ? tokenApi.holders(address, cursor, controller.signal)
        : tokenApi.localHolders(address, holderScope, cursor, controller.signal);
    void read
      .then((page) => {
        if (controller.signal.aborted) return;
        if (page.chainId !== chainId || page.tokenAddress.toLowerCase() !== address)
          throw Error("Holders do not match the current selection");
        setHolders((current) => ({
          ...page,
          items: [
            ...new Map(
              [...(current?.items ?? []), ...page.items].map((item) => [
                item.address.toLowerCase(),
                item,
              ]),
            ).values(),
          ],
        }));
        setHoldersError(null);
      })
      .catch(() => {
        if (!controller.signal.aborted) setHoldersError("More holders failed to load. Try again");
      })
      .finally(() => {
        if (!controller.signal.aborted) setHoldersLoading(false);
      });
  };
  const markers = useMemo(() => {
    const grouped = new Map<string, Pick<Trade, "t" | "side" | "txHash" | "wallets">>();
    for (const activity of historicalMarkers) {
      if (activity.kind !== "BUY" && activity.kind !== "SELL") continue;
      const key = `${activity.txHash}:${activity.kind}`;
      const current = grouped.get(key);
      grouped.set(key, {
        t: Math.floor(activity.timestampMs / 1000),
        side: activity.kind,
        txHash: activity.txHash,
        wallets: [
          ...(current?.wallets ?? []),
          {
            address: activity.address,
            labels: activity.labels ?? [],
            labelSource: activity.labelSource ?? "LOCAL_MANUAL",
            marketCapUsd: activity.marketCapUsd ?? null,
          },
        ],
      });
    }
    for (const trade of trades)
      if (!grouped.has(`${trade.txHash}:${trade.side}`))
        grouped.set(`${trade.txHash}:${trade.side}`, trade);
    return buildTradeMarkers([...grouped.values()], interval, walletAddress, markerFilters);
  }, [trades, historicalMarkers, interval, walletAddress, markerFilters]);
  const holderRows = (holders?.items ?? []).filter(
    (holder) => !holderRisk || holder.riskLabels.includes(holderRisk),
  );
  const lifecycle = token.lifecycle;
  const lifecycleLabel = lifecycle
    ? {
        CURVE: "On curve",
        NEAR_GRADUATION: "Graduating soon",
        GRADUATED: "Graduated",
        SWEPT: "Migrated",
        RESCUED: "Rescued",
        NOT_APPLICABLE: "Not applicable",
        UNKNOWN: "Status unknown",
      }[lifecycle.state]
    : "Status unknown";
  return (
    <section className="token-details" aria-label="Token details">
      <header
        className="token-header panel"
        title={`${marketLive ? "Live market · " : ""}${date(token.updatedAt)}${token.stale ? " · Data delayed" : ""}`}
      >
        <div className="token-heading">
          {token.logo && (
            <img
              key={token.logo}
              className="token-logo"
              src={token.logo}
              alt=""
              style={{ display: "none" }}
              onLoad={(event) => {
                event.currentTarget.style.display = "";
              }}
              onError={(event) => {
                event.currentTarget.style.display = "none";
              }}
            />
          )}
          <div>
            <h2>
              {token.symbol ?? addressLabel(address)} <small>{token.name}</small>
            </h2>
            <code title={address}>{addressLabel(address)}</code>
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard.writeText(address).then(
                  () => setCopyState("Copied"),
                  () => setCopyState("Copy failed"),
                )
              }
            >
              {copyState ?? "Copy address"}
            </button>
            <nav className="social-links" aria-label="Social links">
              {[
                ["Website", token.website],
                ["X", token.twitterUsername],
                ["Telegram", token.telegram],
                ["Discord", token.discord],
              ].map(([label, value]) => {
                const href = socialUrl(value, label!);
                return href ? (
                  <a key={label} href={href} target="_blank" rel="noreferrer">
                    {label}
                  </a>
                ) : null;
              })}
            </nav>
            {lifecycle?.state !== "UNKNOWN" &&
              lifecycle?.state !== "NOT_APPLICABLE" &&
              lifecycle && (
                <div className="lifecycle" title={token.launchpad ?? undefined}>
                  <span>{lifecycleLabel}</span>
                  {lifecycle.progressPct != null && (
                    <progress
                      max={100}
                      value={Number(lifecycle.progressPct)}
                      aria-label="Graduation progress"
                    />
                  )}
                </div>
              )}
          </div>
          {onWatch && (
            <button
              type="button"
              aria-label={watched ? "Remove from watchlist" : "Add to watchlist"}
              aria-pressed={watched}
              onClick={onWatch}
            >
              <DesignIcon name="star" filled={watched} />
            </button>
          )}
        </div>
        {token.description && <p>{token.description}</p>}

        <dl className="token-stats">
          {[
            ["Market cap", amount(token.marketCapUsd, "$")],
            ["Price", money(token.priceUsd)],
            ["24h change", percent(token.change24h)],
            ["24h volume", amount(token.volume24hUsd, "$")],
            ["Liquidity", amount(token.liquidityUsd, "$")],
            ["Holders", amount(token.holders)],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {detailError && (
          <p role="alert">
            {detailError} <button onClick={() => setRetry((value) => value + 1)}>Retry</button>
          </p>
        )}
      </header>
      <div className="token-workspace">
        <div className="token-main">
          <section className="chart-panel panel" aria-label="Price chart">
            <div className="chart-toolbar">
              <div className="intervals" aria-label="Candle interval">
                {(Object.keys(INTERVAL_SECONDS) as Interval[]).map((value) => (
                  <button
                    key={value}
                    aria-pressed={interval === value}
                    onClick={() => setInterval(value)}
                  >
                    {value}
                  </button>
                ))}
              </div>
              <div className="marker-filters">
                {[
                  ["smart", "Smart"],
                  ["kol", "KOL"],
                  ["mine", "My Trades"],
                ].map(([key, label]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={markerFilters[key as keyof typeof markerFilters]}
                      onChange={(event) =>
                        setMarkerFilters((current) => ({
                          ...current,
                          [key!]: event.target.checked,
                        }))
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
            <CandleChart
              key={`${address}:${interval}:${snapshot?.candleRules?.series ?? "USD"}`}
              candles={snapshot?.items ?? []}
              gaps={snapshot?.gaps}
              symbol={token.symbol ?? addressLabel(address)}
              refreshing={chartLoading}
              failed={chartError !== null}
              markers={markers}
              historyRetry={retry}
              onLoadBefore={(before) => loadBeforeRef.current(before)}
            />
            <p className="data-note">
              {markerError ?? (markerLoading ? "Loading…" : null)}
              {markerCursor && (
                <button disabled={markerLoading} onClick={() => moreMarkersRef.current()}>
                  Load more historical markers
                </button>
              )}
            </p>
            {(chartError || streamError) && (
              <p role="status">
                {chartError ?? streamError}{" "}
                <button onClick={() => setRetry((value) => value + 1)}>Reload</button>
              </p>
            )}
          </section>
          <section className="token-activity panel">
            <div role="tablist" aria-label="Token activity">
              <button role="tab" aria-selected={tab === "views"} onClick={() => setTab("views")}>
                Views
              </button>
              <button role="tab" aria-selected={tab === "trades"} onClick={() => setTab("trades")}>
                Trades
              </button>
              <button
                role="tab"
                aria-selected={tab === "holders"}
                onClick={() => setTab("holders")}
              >
                Holders
              </button>
              <button role="tab" aria-selected={tab === "safety"} onClick={() => setTab("safety")}>
                Safety
              </button>
              <button
                role="tab"
                aria-selected={tab === "positions"}
                onClick={() => setTab("positions")}
              >
                Positions
              </button>
            </div>
            {tab === "safety" ? (
              <div role="tabpanel" aria-label="Safety">
                <TokenRiskGrid token={token} />
              </div>
            ) : tab === "positions" ? (
              <div role="tabpanel" aria-label="Positions">
                <Portfolio
                  walletAddress={walletAddress ?? undefined}
                  tokenFilter={address}
                  explorerBaseUrl={explorerBaseUrl}
                  onSell={onSell ?? (() => {})}
                />
              </div>
            ) : tab === "views" ? (
              <Views key={`${chainId}:${address}`} tokenAddress={address} chainId={chainId} />
            ) : tab === "trades" ? (
              <div role="tabpanel" aria-label="Trades">
                <div className="table-scroll">
                  <table className="trades-table">
                    <thead>
                      <tr>
                        {["Time", "Side", "Amount", "MC", "Trader"].map((title) => (
                          <th key={title}>{title}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {trades.map((trade) => (
                        <tr key={trade.tradeId} data-trade-id={trade.tradeId}>
                          <td>
                            <time
                              dateTime={new Date(trade.t * 1000).toISOString()}
                              title={new Date(trade.t * 1000).toLocaleString()}
                            >
                              {age(Math.max(0, Math.floor(Date.now() / 1000 - trade.t)))}
                            </time>
                          </td>
                          <td className={trade.side === "BUY" ? "positive" : "negative"}>
                            {trade.side === "BUY" ? "Buy" : "Sell"}
                          </td>
                          <td
                            className={trade.side === "BUY" ? "positive" : "negative"}
                            title={trade.notionalUsd}
                          >
                            <TradeValue value={trade.notionalUsd} />
                          </td>
                          <td title={trade.marketCapUsd ?? undefined}>
                            <TradeValue value={trade.marketCapUsd} />
                          </td>
                          <td>
                            {trade.trader ? (
                              <div className="trade-wallet">
                                <button
                                  className="link-button"
                                  aria-label={`查看钱包 ${trade.trader}`}
                                  title={trade.trader}
                                  onClick={() => onProfile(trade.trader!)}
                                >
                                  {addressLabel(trade.trader)}
                                </button>
                                {trade.wallets
                                  ?.find(
                                    (wallet) =>
                                      wallet.address.toLowerCase() === trade.trader!.toLowerCase(),
                                  )
                                  ?.labels.map((label) => (
                                    <span className="identity-tag" key={label}>
                                      {label === "SMART_MONEY" ? "Smart" : label}
                                    </span>
                                  ))}
                              </div>
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!trades.length && <p>{tradesLoading ? "Loading trades" : "No trades"}</p>}
                {tradeError && <p role="alert">{tradeError}</p>}
                {tradeCursor && (
                  <button disabled={tradesLoading} onClick={() => loadTradesRef.current()}>
                    Load more trades
                  </button>
                )}
              </div>
            ) : (
              <div role="tabpanel" aria-label="Holders">
                <div className="holder-controls" role="group" aria-label="Holder filters">
                  {(
                    [
                      ["ALL", "All"],
                      ["FOLLOWING", "Following"],
                      ["SMART_MONEY", "Smart"],
                      ["KOL", "KOL"],
                    ] as const
                  ).map(([scope, label]) => (
                    <button
                      key={scope}
                      aria-pressed={!holderRisk && holderScope === scope}
                      onClick={() => {
                        setHolderRisk(null);
                        setHolderScope(scope);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                  {[
                    ["dev", "Dev"],
                    ["sniper", "Snipers"],
                    ["insider", "Insiders"],
                  ].map(([risk, label]) => (
                    <button
                      key={risk}
                      aria-pressed={holderRisk === risk}
                      title="Filters currently loaded holders; load more to include additional rows"
                      onClick={() => {
                        setHolderScope("ALL");
                        setHolderRisk(risk);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                  <button
                    disabled={holdersLoading}
                    onClick={() => setHoldersRetry((value) => value + 1)}
                  >
                    Refresh
                  </button>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        {[
                          "Wallet / labels",
                          "Remaining",
                          "Bought / avg MC",
                          "Sold / avg MC",
                          "PnL",
                        ].map((title) => (
                          <th key={title}>{title}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {holderRows.map((holder) => (
                        <tr key={holder.address}>
                          <td>
                            <button
                              className="link-button"
                              aria-label={`View wallet ${holder.address}`}
                              title={holder.address}
                              onClick={() => onProfile(holder.address)}
                            >
                              {holder.name ?? addressLabel(holder.address)}
                            </button>
                            {holder.labelSource === "LOCAL_MANUAL" &&
                              holder.labels
                                .filter((label) => label === "SMART_MONEY" || label === "KOL")
                                .map((label) => (
                                  <span className="identity-tag" key={label}>
                                    {label === "SMART_MONEY" ? "Smart" : label}
                                  </span>
                                ))}
                            {holder.riskLabels
                              .filter((label) =>
                                [
                                  "dev",
                                  "sniper",
                                  "insider",
                                  "rat_trader",
                                  "bundler",
                                  "wash_trader",
                                ].includes(label),
                              )
                              .map((label) => (
                                <span className="risk-tag" title="GMGN label" key={label}>
                                  {
                                    (
                                      {
                                        dev: "Dev",
                                        sniper: "Sniper",
                                        insider: "Insider",
                                        rat_trader: "Rat",
                                        bundler: "Bundler",
                                        wash_trader: "Wash",
                                      } as Record<string, string>
                                    )[label]
                                  }
                                </span>
                              ))}
                          </td>
                          <td title={`Amount ${holder.quantity ?? "—"}`}>
                            {amount(holder.valueUsd, "$")}
                            <small>{percent(holder.supplyPct)} of supply</small>
                          </td>
                          <td>
                            {amount(holder.boughtUsd, "$")} /{" "}
                            {amount(holder.averageBuyMarketCapUsd, "$")}
                            <small>{amount(holder.buyCount)} buys</small>
                          </td>
                          <td>
                            {amount(holder.soldUsd, "$")} /{" "}
                            {amount(holder.averageSellMarketCapUsd, "$")}
                            <small>{amount(holder.sellCount)} sells</small>
                          </td>
                          <td>
                            {amount(holder.realizedPnlUsd, "$")}
                            <small>unrealized {amount(holder.unrealizedPnlUsd, "$")}</small>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!holderRows.length && !holdersError && (
                  <p>
                    {holdersLoading
                      ? "Loading holders"
                      : holderScope !== "ALL"
                        ? "No tracked positions"
                        : "No holder snapshot"}
                  </p>
                )}
                {holdersError && <p role="alert">{holdersError}</p>}
                {holders?.nextCursor && (
                  <button disabled={holdersLoading} onClick={moreHolders}>
                    Load more holders
                  </button>
                )}
              </div>
            )}
          </section>
        </div>
        <aside className="token-sidebar">{children}</aside>
      </div>
    </section>
  );
}
