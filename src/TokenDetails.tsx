import { amount as displayAmount, money, price } from "./display";
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
}
const EMPTY_FOLLOWS: readonly string[] = [];
const amount = (value: string | number | null | undefined, unit = "") =>
  unit === "$" ? money(value) : displayAmount(value);
const addressLabel = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
const date = (value: number | null | undefined) =>
  value ? new Date(value).toLocaleString() : "更新时间未知";
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
            label: `${[...labels].join(" / ")} ${trade.side === "BUY" ? "买" : "卖"}`,
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
  const [tab, setTab] = useState<"trades" | "holders">("trades");
  const [snapshot, setSnapshot] = useState<CandleSnapshot | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [tradeCursor, setTradeCursor] = useState<string | null>(null);
  const [tradesLoading, setTradesLoading] = useState(false);
  const [holders, setHolders] = useState<HolderPage | null>(null);
  const [holdersLoading, setHoldersLoading] = useState(false);
  const [holdersError, setHoldersError] = useState<string | null>(null);
  const [holdersRetry, setHoldersRetry] = useState(0);
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
            throw Error("代币信息与当前选择不匹配");
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
          if (!controller.signal.aborted) setDetailError("代币信息更新失败，已保留上次结果");
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
            throw Error("K 线与当前选择不匹配");
          const current = snapshotRef.current;
          saveSnapshot(
            mergeSnapshots(current?.items.length || current?.gaps.length ? current : null, page),
          );
          setChartLoading(false);
          if (page.syncStatus === "STALE" || page.syncStatus === "FAILED")
            throw Error("K 线暂时无法更新");
          setChartError(null);
          candleAttempt = 0;
          if (page.syncStatus === "BACKFILLING" || page.syncStatus === "CATCHING_UP")
            candleDirty = true;
        })
        .catch(() => {
          if (active) {
            setChartError("K 线加载失败");
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
            setTradeError("成交更新失败，正在重试");
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
        throw Error("历史 K 线与当前选择不匹配");
      if (page.syncStatus === "FAILED" || page.syncStatus === "STALE")
        throw Error("历史 K 线暂时无法加载");
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
          if (active) setTradeError("更早成交加载失败，请重试");
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
                throw Error("行情与当前代币不匹配");
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
            setStreamError("实时行情暂时中断，正在重连");
            next.close();
          }
        });
        next.addEventListener("error", () => next.close());
        next.addEventListener("close", () => {
          if (socket !== next) return;
          socket = null;
          window.clearTimeout(openTimer);
          if (active && !hidden()) setStreamError("实时行情暂时中断，正在重连");
          reconnect();
        });
      } catch {
        if (active) {
          setStreamError("实时行情暂时中断，历史仍可查看");
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
            throw Error("历史标记与当前选择不匹配");
          setHistoricalMarkers((current) => [
            ...new Map([...current, ...page.items].map((item) => [item.eventId, item])).values(),
          ]);
          cursor = page.nextCursor ?? undefined;
          setMarkerCursor(page.nextCursor);

          setMarkerError(null);
        })
        .catch(() => {
          if (!controller.signal.aborted) setMarkerError("历史标记暂不可用");
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
      setHoldersError("登录后查看关注钱包持仓");
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
          throw Error("持有人与当前选择不匹配");
        setHolders(page);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setHoldersError(
            holderScope === "ALL" ? "持有人加载失败，请重试" : "持有人暂不可用，请重试",
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
          throw Error("持有人与当前选择不匹配");
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
        if (!controller.signal.aborted) setHoldersError("更多持有人加载失败，请重试");
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
  const walletCounts = useMemo(() => {
    const counts = new Map<string, Set<string>>();
    for (const trade of trades)
      for (const wallet of trade.wallets ?? []) {
        const key = wallet.address.toLowerCase(),
          ids = counts.get(key) ?? new Set<string>();
        ids.add(trade.txHash);
        counts.set(key, ids);
      }
    return counts;
  }, [trades]);
  const holderRows = holders?.items ?? [];
  const lifecycle = token.lifecycle;
  const lifecycleLabel = lifecycle
    ? {
        CURVE: "内盘",
        NEAR_GRADUATION: "即将毕业",
        GRADUATED: "已毕业",
        SWEPT: "已迁移",
        RESCUED: "已退出",
        NOT_APPLICABLE: "不适用",
        UNKNOWN: "状态未知",
      }[lifecycle.state]
    : "状态未知";
  return (
    <section className="token-details" aria-label="Token 详情">
      <header className="token-header panel">
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
            <code>{address}</code>
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard.writeText(address).then(
                  () => setCopyState("已复制"),
                  () => setCopyState("复制失败"),
                )
              }
            >
              {copyState ?? "复制地址"}
            </button>
          </div>
          {onWatch && (
            <button type="button" aria-pressed={watched} onClick={onWatch}>
              {watched ? "已自选" : "加入自选"}
            </button>
          )}
        </div>
        {token.description && <p>{token.description}</p>}
        <nav className="social-links" aria-label="社交链接">
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
        <dl className="token-stats">
          {[
            ["价格", amount(token.priceUsd, "$")],
            ["市值", amount(token.marketCapUsd, "$")],
            ["流动性", amount(token.liquidityUsd, "$")],
            ["24h 成交额", amount(token.volume24hUsd, "$")],
            ["持有人", amount(token.holders)],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <p className="data-note">
          {marketLive ? "实时行情 · " : ""}
          {date(token.updatedAt)}
          {token.stale ? " · 数据待更新" : ""}
        </p>
        <div className="lifecycle">
          <span>
            {token.launchpad ?? "协议未知"} · {lifecycleLabel}
          </span>
          <span>
            进度：
            {lifecycle?.progressPct == null ? "未知" : `${amount(lifecycle.progressPct)}%`}
          </span>
          {lifecycle?.progressPct != null && (
            <progress max={100} value={Number(lifecycle.progressPct)} aria-label="毕业进度" />
          )}
        </div>
        {detailError && (
          <p role="alert">
            {detailError} <button onClick={() => setRetry((value) => value + 1)}>重试</button>
          </p>
        )}
      </header>
      <div className="token-workspace">
        <div className="token-main">
          <section className="chart-panel panel" aria-label="价格图表">
            <div className="chart-toolbar">
              <div className="intervals" aria-label="K 线周期">
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
              {markerError ?? (markerLoading ? "正在加载…" : null)}
              {markerCursor && (
                <button disabled={markerLoading} onClick={() => moreMarkersRef.current()}>
                  加载更多历史标记
                </button>
              )}
            </p>
            {(chartError || streamError) && (
              <p role="status">
                {chartError ?? streamError}{" "}
                <button onClick={() => setRetry((value) => value + 1)}>重新加载</button>
              </p>
            )}
          </section>
          <section className="token-activity panel">
            <div role="tablist" aria-label="代币记录">
              <button role="tab" aria-selected={tab === "trades"} onClick={() => setTab("trades")}>
                成交
              </button>
              <button
                role="tab"
                aria-selected={tab === "holders"}
                onClick={() => setTab("holders")}
              >
                Holders
              </button>
            </div>
            {tab === "trades" ? (
              <div role="tabpanel" aria-label="成交">
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        {["时间", "方向", "金额 U", "成交时市值", "钱包 / 标签", "同钱包次数"].map(
                          (title) => (
                            <th key={title}>{title}</th>
                          ),
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {trades.map((trade) => (
                        <tr key={trade.tradeId}>
                          <td>
                            <time dateTime={new Date(trade.t * 1000).toISOString()}>
                              {new Date(trade.t * 1000).toLocaleTimeString()}
                            </time>
                          </td>
                          <td className={trade.side === "BUY" ? "positive" : "negative"}>
                            {trade.side === "BUY" ? "买入" : "卖出"}
                          </td>
                          <td>{price(trade.notionalUsd)}</td>
                          <td>{amount(trade.marketCapUsd, "$")}</td>
                          <td>
                            {trade.wallets?.length
                              ? trade.wallets.map((wallet) => (
                                  <div key={wallet.address}>
                                    <button
                                      className="link-button"
                                      aria-label={`查看钱包 ${wallet.address}`}
                                      title={wallet.address}
                                      onClick={() => onProfile(wallet.address)}
                                    >
                                      {addressLabel(wallet.address)}
                                    </button>
                                    {wallet.labelSource === "LOCAL_MANUAL" &&
                                      wallet.labels
                                        .filter(
                                          (label) => label === "SMART_MONEY" || label === "KOL",
                                        )
                                        .map((label) => (
                                          <span className="identity-tag" key={label}>
                                            {label === "SMART_MONEY" ? "Smart" : label}
                                          </span>
                                        ))}
                                  </div>
                                ))
                              : "未知"}
                          </td>
                          <td>
                            {trade.wallets?.length
                              ? trade.wallets.map((wallet) => (
                                  <div key={wallet.address}>
                                    {walletCounts.get(wallet.address.toLowerCase())?.size ?? "未知"}
                                  </div>
                                ))
                              : "未知"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!trades.length && <p>{tradesLoading ? "正在加载成交" : "暂无可用成交"}</p>}
                {tradeError && <p role="alert">{tradeError}</p>}
                {tradeCursor && (
                  <button disabled={tradesLoading} onClick={() => loadTradesRef.current()}>
                    加载更多成交
                  </button>
                )}
              </div>
            ) : (
              <div role="tabpanel" aria-label="Holders">
                <div className="holder-controls" role="group" aria-label="持有人筛选">
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
                      aria-pressed={holderScope === scope}
                      onClick={() => setHolderScope(scope)}
                    >
                      {label}
                    </button>
                  ))}
                  <button
                    disabled={holdersLoading}
                    onClick={() => setHoldersRetry((value) => value + 1)}
                  >
                    刷新持有人
                  </button>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        {[
                          "钱包 / 标签",
                          "数量",
                          "价值",
                          "供应占比",
                          "累计买入 / 卖出",
                          "买入 / 卖出次数",
                          "平均买入 / 卖出市值",
                          "已实现 / 未实现盈亏",
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
                              aria-label={`查看钱包 ${holder.address}`}
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
                                <span className="risk-tag" title="GMGN 标签" key={label}>
                                  {
                                    (
                                      {
                                        dev: "Dev",
                                        sniper: "Sniper",
                                        insider: "Insider",
                                        rat_trader: "Rat",
                                        bundler: "Bundler",
                                        wash_trader: "刷量",
                                      } as Record<string, string>
                                    )[label]
                                  }
                                </span>
                              ))}
                          </td>
                          <td>{amount(holder.quantity)}</td>
                          <td>{amount(holder.valueUsd, "$")}</td>
                          <td>
                            {holder.supplyPct == null ? "未知" : `${amount(holder.supplyPct)}%`}
                          </td>
                          <td>
                            {amount(holder.boughtUsd, "$")} / {amount(holder.soldUsd, "$")}
                          </td>
                          <td>
                            {amount(holder.buyCount)} / {amount(holder.sellCount)}
                          </td>
                          <td>
                            {amount(holder.averageBuyMarketCapUsd, "$")} /{" "}
                            {amount(holder.averageSellMarketCapUsd, "$")}
                          </td>
                          <td>
                            {amount(holder.realizedPnlUsd, "$")} /{" "}
                            {amount(holder.unrealizedPnlUsd, "$")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!holderRows.length && !holdersError && (
                  <p>
                    {holdersLoading
                      ? "正在加载持有人"
                      : holderScope !== "ALL"
                        ? "暂无已跟踪持仓"
                        : "暂无持有人快照"}
                  </p>
                )}
                {holdersError && <p role="alert">{holdersError}</p>}
                {holders?.nextCursor && (
                  <button disabled={holdersLoading} onClick={moreHolders}>
                    加载更多持有人
                  </button>
                )}
              </div>
            )}
          </section>
        </div>
        <aside className="token-sidebar">
          {children}
          <TokenRiskGrid token={token} />
        </aside>
      </div>
    </section>
  );
}
