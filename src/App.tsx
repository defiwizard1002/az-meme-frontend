import { TokenLiquidity } from "./TokenLiquidity.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, azAuth, azFundApi, memeApi, setSessionToken, wsBaseUrl } from "./api";
import { CandleChart, type HistoryLoadResult } from "./CandleChart";
import { streamBatchItems, streamSequenceAction } from "./stream-batches";
import { pollOrderUntilTerminal } from "./order-tracker";
import { pollTransactionUntilTerminal } from "./transaction-tracker";
import type {
  AccountSummary,
  AccountTransaction,
  Asset,
  Candle,
  CandleSnapshot,
  Interval,
  Quote,
  QuoteDisplay,
  Token,
  Trade,
} from "./types";
import "./styles.css";
import {
  preparationInput,
  QuoteExpiredError,
  requirePreparedQuote,
  withSlippageMinimum,
  calculatedSlippage,
  latestTradePrice,
  settlementUsdPrice,
} from "./quote-flow";
import { TokenRiskLabels, TokenRiskGrid } from "./TokenRiskLabels";
import { displayAmount, positionQuantity } from "./decimal-display";
import { HistoryModal } from "./HistoryModal";
import { WalletAssets } from "./WalletAssets";

const intervals: Interval[] = ["1s", "1m", "15m", "1h", "4h"];
const ethPresets = ["0.05", "0.1", "0.25", "0.5"];
const stablePresets = ["25", "100", "250", "500"];
const pocUsdgPresets = ["1", "2", "5", "10"];
const candlePageSize = 300;

function compact(value: string | number): string {
  return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(
    Number(value),
  );
}

function money(value: string | number): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return "$0";
  return `$${Intl.NumberFormat("en", {
    notation: Math.abs(number) >= 100_000 ? "compact" : "standard",
    maximumFractionDigits: Math.abs(number) >= 1 ? 2 : 12,
    maximumSignificantDigits: Math.abs(number) < 1 ? 6 : undefined,
  }).format(number)}`;
}

function searchVolumeLabel(value: Token["volume1hUsd"]): string {
  return typeof value === "string" &&
    /^\+?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?$/.test(value) &&
    Number.isFinite(Number(value))
    ? money(value)
    : "—";
}

function readableAmount(value: string | number): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return Intl.NumberFormat("en-US", {
    maximumSignificantDigits: 7,
    useGrouping: Math.abs(number) >= 1_000,
  }).format(number);
}

function formatPercent(value: string | number): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0.00%";
  return `${number > 0 ? "+" : ""}${number.toFixed(2)}%`;
}

function TokenChange({ tokenAddress, value }: { tokenAddress: string; value: string }) {
  const previousValue = useRef(value);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (previousValue.current === value) return;
    previousValue.current = value;
    setRevision((current) => current + 1);
  }, [value]);
  return (
    <span
      key={`${tokenAddress}:${revision}`}
      className={`token-change ${revision > 0 ? "change-flash " : ""}${Number(value) >= 0 ? "positive" : "negative"}`}
    >
      {formatPercent(value)}
    </span>
  );
}

function age(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function shortAddress(value: string): string {
  return `${value.slice(0, 5)}...${value.slice(-4)}`;
}

function CopyableAddress({ value, iconOnly = false }: { value: string; iconOnly?: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 1_200);
    return () => window.clearTimeout(timer);
  }, [state]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return (
    <button
      type="button"
      className="copy-address"
      onClick={() => void copy()}
      aria-label={`复制地址 ${value}`}
      title={value}
    >
      {state === "copied"
        ? iconOnly
          ? "✓"
          : "已复制"
        : state === "failed"
          ? iconOnly
            ? "×"
            : "复制失败"
          : iconOnly
            ? "⧉"
            : shortAddress(value)}
    </button>
  );
}

function launchpadLabel(value: string | null | undefined): string | null {
  const label = value?.trim();
  return label && !/^(unknown|undefined|null|none|n\/a|未知|协议未知)$/i.test(label) ? label : null;
}

function poolLabel(poolType: string): string {
  return poolType === "UNSUPPORTED" ? "协议未知" : poolType.replaceAll("_", " ");
}

function stageLabel(token: Token): string {
  return (
    { CURVE: "内盘", GRADUATED: "已毕业", AMM: "外盘", UNKNOWN: "阶段未知" }[token.stage] ??
    "阶段未知"
  );
}

function percentageOf(value: string, percent: number): string {
  const [whole = "0", fraction = ""] = value.split(".");
  const scale = 10n ** BigInt(fraction.length);
  const units = BigInt(`${whole}${fraction}` || "0");
  const result = (units * BigInt(percent)) / 100n;
  const resultWhole = result / scale;
  const resultFraction = (result % scale)
    .toString()
    .padStart(fraction.length, "0")
    .replace(/0+$/, "");
  return resultFraction ? `${resultWhole}.${resultFraction}` : resultWhole.toString();
}

export function relativeAge(timestamp: number, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const elapsed = Math.max(0, Math.floor(nowSeconds - timestamp));
  if (elapsed < 60) return `${elapsed}s`;
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m`;
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h`;
  return `${Math.floor(elapsed / 86400)}d`;
}

interface StreamMessage<T> {
  channel: string;
  epoch: string;
  sequence: number;
  revision?: string;
  data: T;
}

interface HotMarketUpdate {
  items: Token[];
}

interface StreamBatch<T> {
  items: T[];
}

interface TradeCacheEntry {
  items: Trade[];
  nextCursor: string | null;
  initialized: boolean;
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

function candleCacheKey(tokenAddress: string, interval: Interval): string {
  return `${tokenAddress.toLowerCase()}:${interval}`;
}

function tradeCacheKey(tokenAddress: string, marketKey: string): string {
  return `${tokenAddress.toLowerCase()}:${marketKey}`;
}

function isAzLoginUpstreamFailure(cause: unknown): cause is ApiError {
  return cause instanceof ApiError && cause.code === "AZ_REQUEST_FAILED" && cause.status >= 500;
}

function privateAccountUrl(): string | null {
  // Only this user-approved deployment has a known private account entry point.
  const origin = new URL(window.location.origin);
  if (
    origin.protocol !== "https:" ||
    origin.hostname !== "dopemac-mini.tailc44fad.ts.net" ||
    origin.port !== "10000"
  )
    return null;
  origin.port = "4173";
  return origin.href;
}

function transactionUrl(explorerBaseUrl: string, txHash: string): string | null {
  if (!explorerBaseUrl || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) return null;
  return `${explorerBaseUrl.replace(/\/+$/, "")}/tx/${txHash}`;
}

function addressUrl(explorerBaseUrl: string, address: string): string | null {
  if (!explorerBaseUrl || !/^0x[a-fA-F0-9]{40}$/.test(address)) return null;
  return `${explorerBaseUrl.replace(/\/+$/, "")}/address/${address}`;
}

function tradeValueUsd(trade: Trade): string {
  const notional = trade.notionalUsd;
  if (
    typeof notional !== "string" ||
    !/^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(notional.trim())
  )
    return "—";
  const value = Number(notional);
  return Number.isFinite(value) ? money(value) : "—";
}

function normalizedDecimal(value: string): string {
  const [whole = "0", fraction = ""] = value.split(".");
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "") || "0";
  const normalizedFraction = fraction.replace(/0+$/, "");
  return normalizedFraction ? normalizedWhole + "." + normalizedFraction : normalizedWhole;
}

function matchesQuoteRequest(
  quote: QuoteDisplay,
  request: NonNullable<Parameters<typeof memeApi.createQuote>[0]>,
): boolean {
  return (
    quote.tokenAddress.toLowerCase() === request.tokenAddress.toLowerCase() &&
    quote.side === request.side &&
    quote.settlementAsset === request.settlementAsset &&
    normalizedDecimal(quote.amountIn) === normalizedDecimal(request.amountIn)
  );
}

function upsertAccountTransaction(
  items: AccountTransaction[],
  next: AccountTransaction,
): AccountTransaction[] {
  return [next, ...items.filter((item) => item.executionId !== next.executionId)].sort(
    (left, right) => right.createdAt - left.createdAt,
  );
}

function friendlyError(cause: unknown, fallback: string): string {
  if (cause instanceof SyntaxError) return `${fallback}：服务响应无效，请重试`;
  if (!(cause instanceof ApiError)) return cause instanceof Error ? cause.message : fallback;
  if (cause.code === "MEME_PRIVATE_ACCOUNT_ENTRY_REQUIRED") return cause.message;
  const messages: Record<string, string> = {
    MEME_UNAUTHORIZED: "登录已失效，请重新登录",
    MEME_GMGN_RATE_LIMITED: "行情请求较多，请稍后再试",
    MEME_MARKET_MISMATCH: "池子已更新，正在刷新行情",
    MEME_QUOTE_EXPIRED: "报价已过期，请使用最新报价",
    MEME_APPROVAL_REQUIRED: "自动授权未完成，请重新准备并确认交易",
    MEME_ATOMIC_APPROVAL_REQUIRED: "自动授权未完成，请重新准备并确认交易",
    MEME_EXECUTION_DISABLED: "当前环境暂不开放交易",
    MEME_ROUTE_STALE: "报价已过期或路由已变化，请重新确认",
    MEME_ROUTING_DISCOVERY_UNAVAILABLE: "自有池目录暂不可用",
    MEME_ROUTING_LIQUIDITY_UNAVAILABLE: "候选池流动性证据不足，暂时不能报价",
    MEME_ROUTING_BUDGET_EXCEEDED: "路由查询达到预算，请稍后重试",
    MEME_NO_EXECUTABLE_ROUTE: "所选资产与目标池之间没有可执行路径",
    MEME_MAIN_ACCOUNT_BUSY: "上一笔交易仍在处理中",
    MEME_INSUFFICIENT_MAIN_ACCOUNT_BALANCE: "可用余额不足",
    MEME_INSUFFICIENT_MAIN_ACCOUNT_GAS: "Gas 余额不足",
    MEME_UNSUPPORTED_POOL_TYPE: "当前池暂不支持交易",
  };
  return (
    messages[cause.code] ?? `${fallback}：${cause.message}（HTTP ${cause.status}，${cause.code}）`
  );
}

export function chooseNewerCandle(previous: Candle | undefined, next: Candle): Candle {
  if (!previous || BigInt(next.revision) >= BigInt(previous.revision)) return next;
  return previous;
}

function boundedMapSet<T>(map: Map<string, T>, key: string, value: T, capacity: number): void {
  map.delete(key);
  if (map.size >= capacity) map.delete(map.keys().next().value!);
  map.set(key, value);
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

function TokenMark({ token }: { token: Token }) {
  return (
    <span className="token-mark" aria-hidden="true">
      {token.symbol.slice(0, 2)}
    </span>
  );
}

export default function App({
  privyWallet,
  onLogout,
  walletRequired = false,
  connectionPending = false,
  connectionError,
  onConnect,
}: {
  privyWallet?: string;
  onLogout?: () => void;
  walletRequired?: boolean;
  connectionPending?: boolean;
  connectionError?: string | null;
  onConnect?: () => void;
} = {}) {
  const guest = walletRequired && !privyWallet;
  const [tokens, setTokens] = useState<Token[]>([]);
  const [selected, setSelected] = useState<Token | null>(null);
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [accountTransactions, setAccountTransactions] = useState<AccountTransaction[]>([]);
  const [snapshot, setSnapshot] = useState<CandleSnapshot | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [tradeNextCursor, setTradeNextCursor] = useState<string | null>(null);
  const [tradesLoading, setTradesLoading] = useState(false);
  const [tradesPaused, setTradesPaused] = useState(false);
  const [tradeFlashes, setTradeFlashes] = useState<{
    key: string;
    deadlines: Map<string, number>;
  } | null>(null);
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  const [interval, setIntervalValue] = useState<Interval>("1m");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [asset, setAsset] = useState<Asset>("ETH");
  const [amount, setAmount] = useState("0.1");
  const [activePreset, setActivePreset] = useState<string | null>("0.1");
  const [quoteState, setQuoteState] = useState<{
    value: QuoteDisplay;
    request: Parameters<typeof memeApi.createQuote>[0];
  } | null>(null);
  const [orderState, setOrderState] = useState<string | null>(null);
  useEffect(() => {
    const delay = (
      { 交易成功: 3000, "交易失败，资金已释放": 1200, 交易失败: 1800 } as Record<string, number>
    )[orderState ?? ""];
    if (delay === undefined) return;
    const timer = window.setTimeout(() => setOrderState(null), delay);
    return () => window.clearTimeout(timer);
  }, [orderState]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailPollRef = useRef<number | undefined>(undefined);
  const [listLoading, setListLoading] = useState(false);
  const listRetryTabRef = useRef<"hot" | "new">("hot");
  const [listFailed, setListFailed] = useState(false);
  const [requestedDiscoveryTab, setRequestedDiscoveryTab] = useState<"hot" | "new">("hot");
  const [loading, setLoading] = useState(true);
  const [chartLoading, setChartLoading] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [marketRetry, setMarketRetry] = useState(0);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [transactionRefreshError, setTransactionRefreshError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<{ owner: object; message: string } | null>(null);
  const [accountOriginIssue, setAccountOriginIssue] = useState(false);
  const [accountRetry, setAccountRetry] = useState(0);
  const [errorState, setErrorState] = useState<{
    message: string;
    owner?: object;
    quote?: boolean;
  } | null>(null);

  const setError = useCallback(
    (message: string | null) => setErrorState(message === null ? null : { message }),
    [],
  );
  const [chainName, setChainName] = useState("Robinhood Chain");
  const [explorerBaseUrl, setExplorerBaseUrl] = useState("");
  const [fallbackSlippageBps] = useState(500);
  const [manualSlippage, setManualSlippage] = useState<{ key: string; value: string } | null>(null);
  const [latestTrade, setLatestTrade] = useState<{
    key: string;
    trade: Trade | null;
    revision?: string;
  } | null>(null);
  const latestTradeRef = useRef(latestTrade);
  const updateLatestTrade = useCallback((head: NonNullable<typeof latestTrade>) => {
    latestTradeRef.current = head;
    setLatestTrade(head);
  }, []);
  const [orderBusy, setOrderBusy] = useState(false);
  const orderBusyRef = useRef(false);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<Token[] | null>(null);
  const [discoveryTab, setDiscoveryTab] = useState<"hot" | "new">("hot");
  const [marketRefreshMs, setMarketRefreshMs] = useState({ hot: 14_400_000, new: 300_000 });
  const discoveryIntentRef = useRef<"hot" | "new">("hot");
  const discoveryRequestRef = useRef(0);
  const [sessionReady, setSessionReady] = useState(false);
  const [accountMode, setAccountMode] = useState<"AZ_ACCOUNT" | "MAIN_ACCOUNT_POC" | null>(null);
  const [settlementAssets, setSettlementAssets] = useState<Asset[]>(["ETH", "USDC", "USDT"]);
  const [transferOpen, setTransferOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [transferDirection, setTransferDirection] = useState<"SPOT_TO_MEME" | "MEME_TO_SPOT">(
    "SPOT_TO_MEME",
  );
  const [transferAsset, setTransferAsset] = useState<Asset>("ETH");
  const [transferAmount, setTransferAmount] = useState("0.1");
  const [transferState, setTransferState] = useState<string | null>(null);
  const accountAvailable = sessionReady && account !== null && !accountError;
  const candleCacheRef = useRef(new Map<string, CandleSnapshot>());
  const tradeCacheRef = useRef(new Map<string, TradeCacheEntry>());
  const tradesPausedRef = useRef(false);
  const tradeMarketKeyRef = useRef(new Map<string, string>());
  const orderIdempotencyRef = useRef(new Map<string, string>());
  const orderPollsRef = useRef(
    new Map<string, { controller: AbortController; promise: Promise<void> }>(),
  );
  const mainAccountIdempotencyRef = useRef(new Map<string, string>());
  const transactionPollsRef = useRef(
    new Map<string, { controller: AbortController; promise: Promise<void> }>(),
  );
  const streamSocketRef = useRef<WebSocket | null>(null);
  const marketChannelsRef = useRef<string[]>([]);
  const selectionRequestRef = useRef(0);
  const candleHistoryScopeRef = useRef<{
    key: string;
    controller: AbortController;
    loading?: boolean;
    exhausted?: boolean;
    readHead?: (signal?: AbortSignal) => Promise<CandleSnapshot>;
    refresh?: () => void;
    updateHeadStatus?: (status: CandleSnapshot["syncStatus"]) => void;
  } | null>(null);
  const tradeHistoryScopeRef = useRef<{
    key: string;
    loading?: boolean;
    exhausted?: boolean;
  } | null>(null);
  const selectedTokenAddress = selected?.tokenAddress ?? null;
  const selectedTradeStatus = selected?.tradeStatus ?? null;
  const selectedMarketKey = selected ? "USD:USDG" : null;
  const activeSnapshot = selected
    ? snapshot?.tokenAddress.toLowerCase() === selected.tokenAddress.toLowerCase() &&
      snapshot.marketKey === selectedMarketKey &&
      snapshot.interval === interval
      ? snapshot
      : null
    : null;
  const activeTradeKey =
    selected && selectedMarketKey ? tradeCacheKey(selected.tokenAddress, selectedMarketKey) : null;
  const marketStreamAvailable =
    !!activeSnapshot &&
    activeSnapshot.syncStatus !== "STALE" &&
    activeSnapshot.syncStatus !== "FAILED";
  const hasTrades = trades.length > 0;
  const privateAccountHref = accountOriginIssue ? privateAccountUrl() : null;

  useEffect(() => {
    setTradeFlashes(null);
  }, [activeTradeKey, tradesPaused]);
  useEffect(() => {
    if (!tradeFlashes || tradeFlashes.key !== activeTradeKey || !tradeFlashes.deadlines.size)
      return;
    const timer = window.setTimeout(
      () => {
        setTradeFlashes((current) => {
          if (current !== tradeFlashes) return current;
          const deadlines = new Map(
            [...current.deadlines].filter(([, until]) => until > Date.now()),
          );
          return deadlines.size ? { ...current, deadlines } : null;
        });
      },
      Math.max(0, Math.min(...tradeFlashes.deadlines.values()) - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [activeTradeKey, tradeFlashes]);

  const setCachedSnapshot = useCallback(
    (
      update: CandleSnapshot | null | ((current: CandleSnapshot | null) => CandleSnapshot | null),
    ) => {
      setSnapshot((current) => {
        const next = typeof update === "function" ? update(current) : update;
        if (next) {
          boundedMapSet(
            candleCacheRef.current,
            candleCacheKey(next.tokenAddress, next.interval),
            next,
            64,
          );
          boundedMapSet(
            tradeMarketKeyRef.current,
            next.tokenAddress.toLowerCase(),
            next.marketKey,
            64,
          );
        }
        return next;
      });
    },
    [],
  );

  const quoteRequest = useMemo(() => {
    if (
      !selectedTokenAddress ||
      (selectedTradeStatus !== "TRADABLE" && accountMode !== "MAIN_ACCOUNT_POC") ||
      !/^\d+(?:\.\d+)?$/.test(amount) ||
      Number(amount) <= 0
    )
      return null;
    return {
      side,
      tokenAddress: selectedTokenAddress,
      settlementAsset: asset,
      amountIn: amount,
      slippageBps: fallbackSlippageBps,
      ...(accountMode === "MAIN_ACCOUNT_POC" ? { purpose: "ESTIMATE" as const } : {}),
    } as const;
  }, [
    accountMode,
    amount,
    asset,
    selectedTokenAddress,
    selectedTradeStatus,
    side,
    fallbackSlippageBps,
  ]);
  const error =
    errorState && (!errorState.quote || errorState.owner === quoteRequest)
      ? errorState.message
      : null;
  const quoteRequestRef = useRef(quoteRequest);
  quoteRequestRef.current = quoteRequest;
  const quoteVersionRef = useRef(0);
  const refreshExpiredQuoteRef = useRef<() => void>(() => {});
  const rawQuote = quoteState?.request === quoteRequest ? quoteState.value : null;
  const displayedPrice = activeSnapshot?.items.at(-1)?.c ?? selected?.priceUsd ?? "0";
  const draftKey = JSON.stringify([selectedTokenAddress, side, asset, amount]);
  const manualValue = manualSlippage?.key === draftKey ? manualSlippage.value : null;
  const lastPrice =
    latestTrade?.key === activeTradeKey ? latestTradePrice(latestTrade.trade) : null;
  const slipCalculation =
    rawQuote && selected
      ? calculatedSlippage(
          rawQuote,
          lastPrice ?? "",
          (rawQuote.status === "LOCAL_ESTIMATE"
            ? side === "BUY"
              ? rawQuote.inputPriceUsd
              : rawQuote.outputPriceUsd
            : undefined) ?? settlementUsdPrice(asset, selected),
        )
      : null;
  const slippageBps =
    manualValue !== null
      ? /^\d+(?:\.\d{1,2})?$/.test(manualValue)
        ? Math.round(Number(manualValue) * 100)
        : null
      : (slipCalculation?.suggestedBps ?? null);
  const slippageSupported =
    slippageBps !== null &&
    Number.isInteger(slippageBps) &&
    slippageBps >= 1 &&
    slippageBps <= 9999;
  const quote = rawQuote && slippageSupported ? withSlippageMinimum(rawQuote, slippageBps!) : null;
  // Use the current displayed tolerance on refresh, without making it a request dependency.
  const displayedSlippageRef = useRef(slippageBps);
  displayedSlippageRef.current = slippageSupported ? slippageBps : null;
  const displayedMinimumRef = useRef(quote?.minAmountOut);
  displayedMinimumRef.current = quote?.minAmountOut;
  useEffect(() => {
    setOrderState(null);
  }, [quoteRequest, accountAvailable]);

  const trackOrder = useCallback(async (orderId: string) => {
    const existing = orderPollsRef.current.get(orderId);
    if (existing) return await existing.promise;
    const controller = new AbortController();
    const promise = pollOrderUntilTerminal(orderId, {
      signal: controller.signal,
      loadOrder: memeApi.getOrder,
      onUpdate: (latest) => {
        if (latest.status === "SETTLED") {
          setOrderState("交易成功");
        } else if (latest.status === "FAILED_FINAL" && latest.fundStatus === "RELEASED") {
          setOrderState("交易失败，资金已释放");
        } else if (latest.status === "MANUAL_REVIEW") {
          setOrderState("处理中，请联系客服");
        } else if (latest.status === "SUBMISSION_UNKNOWN") {
          setOrderState("链上结果确认中");
        } else if (latest.status === "FAILED_FINAL") {
          setOrderState("资金释放中");
        } else {
          setOrderState("处理中");
        }
      },
      onTemporaryError: () => setOrderState("状态同步中"),
    })
      .then(() => undefined)
      .finally(() => orderPollsRef.current.delete(orderId));
    orderPollsRef.current.set(orderId, { controller, promise });
    return await promise;
  }, []);

  const refreshMainAccount = useCallback(async () => {
    const [summary, transactions] = await Promise.all([
      memeApi.getAccount(),
      memeApi.getAccountTransactions(),
    ]);
    setAccount(summary);
    setAccountTransactions(transactions.items);
  }, []);

  const trackMainAccountTransaction = useCallback(
    async (executionId: string) => {
      const existing = transactionPollsRef.current.get(executionId);
      if (existing) return await existing.promise;
      const controller = new AbortController();
      const promise = pollTransactionUntilTerminal(executionId, {
        signal: controller.signal,
        loadTransaction: memeApi.getAccountTransaction,
        onUpdate: (latest) => {
          setAccountTransactions((current) => upsertAccountTransaction(current, latest));
          if (latest.status === "CONFIRMED") {
            setOrderState("交易成功");
            for (const [key, value] of mainAccountIdempotencyRef.current) {
              if (value === executionId) mainAccountIdempotencyRef.current.delete(key);
            }
            void refreshMainAccount().catch((cause: unknown) => {
              setAccountError(friendlyError(cause, "余额刷新失败"));
            });
          } else if (latest.status === "FAILED" || latest.status === "PARTIAL") {
            if (latest.status === "FAILED" && latest.txHashes.length === 0) {
              setOrderState(null);
              setError(`${latest.errorMessage ?? "所选路径执行失败"}；请重试`);
            } else {
              setOrderState(latest.status === "PARTIAL" ? "部分完成，请检查交易记录" : "交易失败");
            }
            for (const [key, value] of mainAccountIdempotencyRef.current) {
              if (value === executionId) mainAccountIdempotencyRef.current.delete(key);
            }
          } else if (latest.status === "SUBMISSION_UNKNOWN") {
            setOrderState("结果待确认");
          } else {
            setOrderState("处理中");
          }
        },
        onTemporaryError: () => setOrderState("状态同步中"),
      })
        .then(() => undefined)
        .finally(() => transactionPollsRef.current.delete(executionId));
      transactionPollsRef.current.set(executionId, { controller, promise });
      return await promise;
    },
    [refreshMainAccount, setError],
  );

  useEffect(
    () => () => {
      for (const { controller } of orderPollsRef.current.values()) controller.abort();
      orderPollsRef.current.clear();
      for (const { controller } of transactionPollsRef.current.values()) controller.abort();
      transactionPollsRef.current.clear();
    },
    [],
  );

  const selectToken = useCallback(
    async (summary: Token, retry = false) => {
      const requestId = ++selectionRequestRef.current;
      setManualSlippage(null);
      window.clearTimeout(detailPollRef.current);
      setError(null);
      setMarketError(null);
      setDetailError(null);
      setDetailLoading(true);
      tradesPausedRef.current = false;
      setTradesPaused(false);
      setSelected(summary);
      let polls = 0;
      const load = async (retryRequest = false) => {
        try {
          const detail = retryRequest
            ? await memeApi.getToken(summary.tokenAddress, true)
            : await memeApi.getToken(summary.tokenAddress);
          if (requestId !== selectionRequestRef.current) return;
          setTokens((current) =>
            current.map((item) => (item.tokenAddress === detail.tokenAddress ? detail : item)),
          );
          setSearchResults(
            (current) =>
              current?.map((item) =>
                item.tokenAddress === detail.tokenAddress
                  ? { ...detail, volume1hUsd: item.volume1hUsd }
                  : item,
              ) ?? null,
          );
          setSelected(detail);
          if (detail.detailStatus === "FAILED") {
            setDetailLoading(false);
            setDetailError("详情加载失败，已保留可用数据");
          } else if (detail.detailStatus === "PENDING" || detail.detailStatus === "UPDATING") {
            if (++polls >= 60) {
              setDetailLoading(false);
              setDetailError("后台仍在补齐详情，请稍后重试");
            } else detailPollRef.current = window.setTimeout(() => void load(), 5000);
          } else setDetailLoading(false);
        } catch (cause) {
          if (requestId !== selectionRequestRef.current) return;
          setDetailLoading(false);
          setDetailError(friendlyError(cause, "详情加载失败"));
        }
      };
      await load(retry);
    },
    [setError],
  );
  useEffect(
    () => () => {
      ++selectionRequestRef.current;
      ++discoveryRequestRef.current;
      window.clearTimeout(detailPollRef.current);
    },
    [],
  );

  useEffect(() => {
    let active = true;
    Promise.all([memeApi.getConfig(), memeApi.getMarkets()])
      .then(async ([config, markets]) => {
        const params = new URLSearchParams(window.location.search);
        const address = params.get("token");
        let first = markets.items[0];
        if (address !== null) {
          if (
            !/^0x[0-9a-f]{40}$/i.test(address) ||
            (params.has("chainId") && Number(params.get("chainId")) !== config.chainId)
          )
            throw new Error("代币链接的地址或链不匹配");
          first = await memeApi.getToken(address.toLowerCase());
          if (
            first.chainId !== config.chainId ||
            first.tokenAddress.toLowerCase() !== address.toLowerCase()
          )
            throw new Error("代币响应与链接不匹配");
        }
        if (!active) return;
        setChainName(config.chainName);
        setExplorerBaseUrl(config.explorerBaseUrl);
        setMarketRefreshMs(config.marketRefreshMs ?? { hot: 14_400_000, new: 300_000 });
        const nextAccountMode = config.accountMode ?? "AZ_ACCOUNT";
        const nextSettlementAssets = config.settlementAssets?.length
          ? config.settlementAssets
          : nextAccountMode === "MAIN_ACCOUNT_POC"
            ? (["USDG", "ETH", "WETH"] as Asset[])
            : (["ETH", "USDC", "USDT"] as Asset[]);
        setAccountMode(nextAccountMode);
        setSettlementAssets(nextSettlementAssets);
        if (nextAccountMode === "MAIN_ACCOUNT_POC") {
          setAsset(nextSettlementAssets[0] ?? "USDG");
          setAmount("1");
          setActivePreset(null);
        }
        setTokens(markets.items);
        if (first) void selectToken(first);
        else setSelected(null);
      })
      .catch((cause: unknown) => active && setBootstrapError(friendlyError(cause, "加载失败")))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [selectToken]);

  useEffect(() => {
    let active = true;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing || document.visibilityState === "hidden") return;
      refreshing = true;
      const requestId = discoveryRequestRef.current;
      try {
        const result = await memeApi.getMarkets(discoveryTab);
        if (
          active &&
          requestId === discoveryRequestRef.current &&
          discoveryIntentRef.current === discoveryTab
        ) {
          setTokens(result.items);
          setSelected((current) => current ?? result.items[0] ?? null);
        }
      } catch (cause) {
        if (
          active &&
          requestId === discoveryRequestRef.current &&
          discoveryIntentRef.current === discoveryTab
        )
          setError(friendlyError(cause, "市场刷新失败"));
      } finally {
        refreshing = false;
      }
    };
    const timer = window.setInterval(
      () => void refresh(),
      tokens.length === 0 ? 1_000 : marketRefreshMs[discoveryTab],
    );
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [discoveryTab, marketRefreshMs, tokens.length, setError]);

  useEffect(() => {
    if (!activeTradeKey || !selectedTokenAddress || !selectedMarketKey) {
      setTrades([]);
      setTradeNextCursor(null);
      return;
    }
    let active = true;
    const scope = { key: activeTradeKey };
    const controller = new AbortController();
    tradeHistoryScopeRef.current = scope;
    const headAtRequest = latestTradeRef.current;
    const cached = tradeCacheRef.current.get(activeTradeKey);
    const baseline = new Map((cached?.items ?? []).map((trade) => [trade.tradeId, trade]));
    setTrades(cached?.items ?? []);
    setTradeNextCursor(cached?.nextCursor ?? null);
    setTradesLoading(true);
    void memeApi
      .getTrades(selectedTokenAddress, undefined, controller.signal)
      .then((page) => {
        if (!active) return;
        const current = tradeCacheRef.current.get(activeTradeKey);
        const existing = current?.items ?? [];
        const items = mergeTrades(existing, page.items, baseline);
        const nextCursor =
          current?.initialized && existing.length >= 100 ? current.nextCursor : page.nextCursor;
        const entry = { items, nextCursor, initialized: true };
        boundedMapSet(tradeCacheRef.current, activeTradeKey, entry, 64);
        // REST is source-position DESC, unlike the merged display array.
        if (latestTradeRef.current === headAtRequest)
          updateLatestTrade({ key: activeTradeKey, trade: page.items[0] ?? null });
        if (!tradesPausedRef.current) {
          setTrades(items);
          setTradeNextCursor(nextCursor);
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(friendlyError(cause, "成交加载失败"));
      })
      .finally(() => {
        if (active) setTradesLoading(false);
      });
    return () => {
      active = false;
      if (tradeHistoryScopeRef.current === scope) tradeHistoryScopeRef.current = null;
      controller.abort();
    };
  }, [activeTradeKey, selectedMarketKey, selectedTokenAddress, setError, updateLatestTrade]);

  useEffect(() => {
    if (!hasTrades || tradesPaused) return;
    setNowSeconds(Math.floor(Date.now() / 1000));
    const timer = window.setInterval(() => setNowSeconds(Math.floor(Date.now() / 1000)), 1_000);
    return () => window.clearInterval(timer);
  }, [hasTrades, tradesPaused]);

  useEffect(() => {
    let active = true;
    const query = search.trim();
    if (!query) {
      setSearchResults(null);
      return () => {
        active = false;
      };
    }
    setSearchResults(null);
    const timer = window.setTimeout(() => {
      void memeApi
        .searchMarkets(query)
        .then((result) => {
          if (active) setSearchResults(result.items);
        })
        .catch((cause: unknown) => {
          if (active) setError(friendlyError(cause, "搜索失败"));
        });
    }, 300);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [search, setError]);

  useEffect(() => {
    if (!accountMode || guest) return;
    let active = true;
    const controller = new AbortController();
    const fail = (cause: unknown) => {
      if (!active) return;
      active = false;
      window.clearTimeout(timer);
      controller.abort();
      setSessionToken(null);
      setAccount(null);
      setSessionReady(false);
      setAccountError(
        friendlyError(cause, accountMode === "MAIN_ACCOUNT_POC" ? "主账户连接失败" : "登录失败"),
      );
      setAccountOriginIssue(accountMode === "AZ_ACCOUNT" && isAzLoginUpstreamFailure(cause));
    };
    const timer = window.setTimeout(
      () => fail(new ApiError("MEME_ACCOUNT_TIMEOUT", "账户连接超时，请重试", 0)),
      20_000,
    );
    setSessionToken(null);
    setSessionReady(false);
    setAccount(null);
    setAccountTransactions([]);
    setTransactionRefreshError(null);
    setAccountError(null);
    setAccountOriginIssue(false);
    const login =
      accountMode === "MAIN_ACCOUNT_POC"
        ? Promise.resolve()
        : azAuth.loginMock(controller.signal).then(() => undefined);
    void login
      .then(async () => {
        if (!active) return;
        const [summary, transactions, orders] = await Promise.all([
          memeApi.getAccount(controller.signal).catch((cause: unknown) => {
            throw new Error(friendlyError(cause, "账户余额加载失败"));
          }),
          accountMode === "MAIN_ACCOUNT_POC"
            ? memeApi.getAccountTransactions(controller.signal).catch((cause: unknown) => {
                throw new Error(friendlyError(cause, "交易记录加载失败"));
              })
            : Promise.resolve({ items: [] }),
          memeApi.getOrders(controller.signal).catch((cause: unknown) => {
            throw new Error(friendlyError(cause, "订单状态恢复失败"));
          }),
        ]);
        if (!active) return;
        window.clearTimeout(timer);
        setAccount(summary);
        setAccountTransactions(transactions.items);
        setSessionReady(true);
        setAccountError(null);
        for (const transaction of transactions.items) {
          if (transaction.status === "PENDING") {
            void trackMainAccountTransaction(transaction.executionId).catch((cause: unknown) => {
              if (active) setError(friendlyError(cause, "交易状态同步失败"));
            });
          }
        }
        for (const order of orders.items) {
          if (
            order.status !== "SETTLED" &&
            !(order.status === "FAILED_FINAL" && order.fundStatus === "RELEASED")
          ) {
            void trackOrder(order.orderId).catch((cause: unknown) => {
              if (active) setError(friendlyError(cause, "订单状态恢复失败"));
            });
          }
        }
      })
      .catch(fail);
    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [accountMode, accountRetry, trackMainAccountTransaction, trackOrder, setError, guest]);

  useEffect(() => {
    if (!sessionReady || accountMode !== "MAIN_ACCOUNT_POC") return;
    const controller = new AbortController();
    let refreshing = false;
    const timer = window.setInterval(() => {
      if (refreshing || document.visibilityState === "hidden") return;
      refreshing = true;
      void memeApi
        .getAccountTransactions(controller.signal)
        .then(({ items }) => {
          if (!controller.signal.aborted) {
            setAccountTransactions(items);
            setTransactionRefreshError(null);
          }
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted)
            setTransactionRefreshError(friendlyError(cause, "交易记录刷新失败"));
        })
        .finally(() => {
          refreshing = false;
        });
    }, 5_000);
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
  }, [accountMode, sessionReady, accountRetry]);

  useEffect(() => {
    if (!selectedTokenAddress || !selectedMarketKey) return;
    let active = true;
    const controller = new AbortController();
    let refreshTimer: number | undefined;
    let attempts = 0;
    let refreshing = false;
    let pending = true;
    let lastResume = Number.NEGATIVE_INFINITY;
    const cacheKey = candleCacheKey(selectedTokenAddress, interval);
    const scope: NonNullable<typeof candleHistoryScopeRef.current> = { key: cacheKey, controller };
    candleHistoryScopeRef.current = scope;
    setHistoryError(null);
    // Only selection cleanup owns the shared GET; a recovery waiter can cancel independently.
    let headFlight: Promise<CandleSnapshot> | undefined;
    scope.readHead = (signal) => {
      if (!headFlight) {
        headFlight = memeApi
          .getCandles(selectedTokenAddress, interval, { signal: controller.signal })
          .finally(() => {
            headFlight = undefined;
          });
      }
      const flight = headFlight;
      if (!signal) return flight;
      if (signal.aborted) return Promise.reject(signal.reason);
      return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        void flight.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      });
    };
    const requestedMarketKey = selectedMarketKey;
    const cachedSnapshot = candleCacheRef.current.get(cacheKey) ?? null;
    const cached = cachedSnapshot?.marketKey === requestedMarketKey ? cachedSnapshot : null;
    setChartLoading(cached?.syncStatus !== "READY");
    setMarketError(null);
    setSnapshot(cached);
    setOrderState(null);

    const refresh = () => {
      if (!active || refreshing || document.visibilityState === "hidden") return;
      if (refreshTimer !== undefined) {
        window.clearTimeout(refreshTimer);
        refreshTimer = undefined;
      }
      refreshing = true;
      attempts += 1;
      void scope.readHead!()
        .then((result) => {
          if (!active) return;
          if (
            result.tokenAddress.toLowerCase() !== selectedTokenAddress.toLowerCase() ||
            result.interval !== interval ||
            result.marketKey !== requestedMarketKey
          )
            throw new Error("行情响应与当前代币或周期不匹配");
          const previous = candleCacheRef.current.get(cacheKey) ?? null;
          // An empty pending snapshot has no history/gaps to retain after demand completes.
          const merged = mergeSnapshots(
            previous?.items.length || previous?.gaps.length || previous?.retractions?.length
              ? previous
              : null,
            result,
          );
          setCachedSnapshot(merged);
          setChartLoading(false);
          if (result.syncStatus === "STALE" || result.syncStatus === "FAILED") {
            setMarketError("数据同步失败，后端未提供详细原因，请重试");
          } else {
            setMarketError(null);
          }
          scope.updateHeadStatus?.(result.syncStatus);
        })
        .catch((cause: unknown) => {
          if (!active) return;
          setChartLoading(false);
          setMarketError(friendlyError(cause, "行情暂时不可用"));
          pending = false;
        })
        .finally(() => {
          refreshing = false;
        });
    };
    scope.refresh = refresh;
    scope.updateHeadStatus = (status) => {
      pending = status === "BACKFILLING" || status === "CATCHING_UP";
      if (refreshTimer !== undefined) {
        window.clearTimeout(refreshTimer);
        refreshTimer = undefined;
      }
      if (active && pending && document.visibilityState !== "hidden") {
        refreshTimer = window.setTimeout(
          refresh,
          Math.min(30_000, 2_000 * 2 ** Math.min(Math.max(0, attempts - 1), 4)),
        );
      }
    };
    const resume = () => {
      if (document.visibilityState === "hidden") {
        if (refreshTimer !== undefined) {
          window.clearTimeout(refreshTimer);
          refreshTimer = undefined;
        }
      } else if (pending && Date.now() - lastResume >= 2_000) {
        lastResume = Date.now();
        refresh();
      }
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("pageshow", resume);
    refresh();
    return () => {
      active = false;
      controller.abort();
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("pageshow", resume);
      if (candleHistoryScopeRef.current === scope) candleHistoryScopeRef.current = null;
    };
  }, [selectedTokenAddress, selectedMarketKey, interval, marketRetry, setCachedSnapshot]);

  useEffect(() => {
    if (
      !selectedTokenAddress ||
      !selectedMarketKey ||
      !marketStreamAvailable ||
      typeof WebSocket === "undefined"
    )
      return;
    let socket: WebSocket | null = null;
    let disposed = false;
    let reconnectTimer: number | undefined;
    let reconnectAttempt = 0;
    let hasConnected = false;
    let connecting = false;
    let openTimer: number | undefined;
    let lastActivity = Date.now();
    let lastResume = Number.NEGATIVE_INFINITY;
    const streamState = new Map<string, { epoch: string; sequence: number }>();
    const candleChannel = `candle:${selectedTokenAddress.toLowerCase()}:${selectedMarketKey}:${interval}`;
    const tradeChannel = `trade:${selectedTokenAddress.toLowerCase()}:${selectedMarketKey}`;
    const currentTradeCacheKey = tradeCacheKey(selectedTokenAddress, selectedMarketKey);
    const marketChannel = `market:${selectedTokenAddress.toLowerCase()}`;
    const liveMarketChannel = "markets:live";
    const channels = [candleChannel, tradeChannel, marketChannel, liveMarketChannel];
    const isHidden = () => document.visibilityState === "hidden";
    marketChannelsRef.current = channels;
    const scheduleReconnect = () => {
      if (disposed || document.visibilityState === "hidden" || reconnectTimer !== undefined) return;
      const delay = Math.min(30_000, 1_000 * 2 ** reconnectAttempt);
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        void connect();
      }, delay);
    };

    const upsertCandle = (candle: Candle) => {
      setCachedSnapshot((current) => {
        if (
          !current ||
          current.tokenAddress.toLowerCase() !== selectedTokenAddress.toLowerCase() ||
          current.interval !== interval
        )
          return current;
        if ((candle.series ?? "USD") !== snapshotCandleSeries(current)) return current;
        return mergeSnapshots(current, {
          ...current,
          items: candle.retracted ? [] : [candle],
          retractions: candle.retracted ? [{ t: candle.t, revision: candle.revision }] : [],
        });
      });
    };

    const recoveryController = new AbortController();
    const recovery = new Map<
      string,
      {
        dirty: boolean;
        generation: number;
        flight: boolean;
        attempt: number;
        timer?: number;
        deadline?: number;
      }
    >();
    const recover = (channel: string, markDirty = true) => {
      const state = recovery.get(channel) ?? {
        dirty: false,
        generation: 0,
        flight: false,
        attempt: 0,
      };
      recovery.set(channel, state);
      if (markDirty) {
        state.dirty = true;
        state.generation += 1;
      }
      if (
        disposed ||
        document.visibilityState === "hidden" ||
        !state.dirty ||
        state.flight ||
        state.timer !== undefined
      )
        return;
      state.flight = true;
      const generation = state.generation;
      const deadline = new AbortController();
      state.deadline = window.setTimeout(
        () => deadline.abort(new Error("Market recovery timed out")),
        10_000,
      );
      const signal = AbortSignal.any([recoveryController.signal, deadline.signal]);
      const headAtRequest = latestTradeRef.current;
      const tradeBaseline =
        channel === tradeChannel
          ? new Map(
              (tradeCacheRef.current.get(currentTradeCacheKey)?.items ?? []).map((trade) => [
                trade.tradeId,
                trade,
              ]),
            )
          : undefined;
      const request =
        channel === candleChannel
          ? candleHistoryScopeRef.current!.readHead!(signal).then((fresh) => {
              if (
                fresh.tokenAddress.toLowerCase() !== selectedTokenAddress.toLowerCase() ||
                fresh.interval !== interval ||
                fresh.marketKey !== selectedMarketKey
              )
                throw new Error("行情恢复响应与当前代币或周期不匹配");
              if (fresh.syncStatus === "STALE" || fresh.syncStatus === "FAILED")
                throw new Error("failed candle recovery snapshot");
              if (!disposed) {
                setCachedSnapshot((current) => mergeSnapshots(current, fresh));
                candleHistoryScopeRef.current?.updateHeadStatus?.(fresh.syncStatus);
              }
            })
          : memeApi.getTrades(selectedTokenAddress, undefined, signal).then((page) => {
              if (disposed) return;
              const current = tradeCacheRef.current.get(currentTradeCacheKey);
              const items = mergeTrades(current?.items ?? [], page.items, tradeBaseline);
              const nextCursor =
                current?.initialized && page.items.length < 100
                  ? current.nextCursor
                  : page.nextCursor;
              boundedMapSet(
                tradeCacheRef.current,
                currentTradeCacheKey,
                { items, nextCursor, initialized: true },
                64,
              );
              if (latestTradeRef.current === headAtRequest)
                updateLatestTrade({ key: currentTradeCacheKey, trade: page.items[0] ?? null });
              if (!tradesPausedRef.current) {
                setTrades(items);
                setTradeNextCursor(nextCursor);
              }
            });
      void request
        .then(() => {
          if (disposed) return;
          // A second gap during an in-flight read needs another read after it.
          if (state.generation === generation) state.dirty = false;
          state.attempt = 0;
          setErrorState((current) => (current?.owner === state ? null : current));
        })
        .catch((cause: unknown) => {
          if (!disposed)
            setErrorState({
              owner: state,
              message: friendlyError(
                cause,
                channel === candleChannel ? "行情更新中断，正在恢复" : "成交更新中断，正在恢复",
              ),
            });
        })
        .finally(() => {
          window.clearTimeout(state.deadline);
          state.deadline = undefined;
          state.flight = false;
          if (disposed || document.visibilityState === "hidden" || !state.dirty) return;
          const delay = Math.min(30_000, 1000 * 2 ** Math.min(state.attempt++, 5));
          state.timer = window.setTimeout(() => {
            state.timer = undefined;
            recover(channel, false);
          }, delay);
        });
    };

    const connect = async () => {
      if (
        disposed ||
        connecting ||
        document.visibilityState === "hidden" ||
        (socket && socket.readyState < 2)
      )
        return;
      connecting = true;
      try {
        // Privy transport is ready before balance bootstrap; its ticket requires authentication.
        const { ticket } = await memeApi.getWsTicket(
          recoveryController.signal,
          !privyWallet && !accountAvailable,
        );
        if (disposed || isHidden()) return;
        const nextSocket = new WebSocket(`${wsBaseUrl}?ticket=${encodeURIComponent(ticket)}`);
        socket = nextSocket;
        streamSocketRef.current = nextSocket;
        openTimer = window.setTimeout(() => {
          if (nextSocket.readyState !== WebSocket.OPEN) nextSocket.close();
        }, 10_000);
        nextSocket.addEventListener("open", () => {
          if (disposed || socket !== nextSocket || document.visibilityState === "hidden") {
            nextSocket.close();
            return;
          }
          window.clearTimeout(openTimer);
          openTimer = undefined;
          lastActivity = Date.now();
          if (hasConnected && Date.now() - lastResume >= 2_000) {
            recover(candleChannel);
            recover(tradeChannel);
          }
          // Transport recovery does not require a new trade in an idle market.
          // Snapshot/account errors have separate owners and are not cleared here.
          setStreamError(null);
          hasConnected = true;
          reconnectAttempt = 0;
          nextSocket.send(
            JSON.stringify({
              op: "subscribe",
              channels,
            }),
          );
        });
        nextSocket.addEventListener("message", (event) => {
          if (disposed || socket !== nextSocket) return;
          lastActivity = Date.now();
          try {
            const message = JSON.parse(String(event.data)) as StreamMessage<
              | Candle
              | CandleSnapshot
              | Trade
              | Quote
              | Token
              | HotMarketUpdate
              | StreamBatch<Candle>
              | StreamBatch<Trade>
            >;
            if (channels.includes(message.channel)) setStreamError(null);
            const previous = streamState.get(message.channel);
            const action = streamSequenceAction(previous, message);
            if (action === "DUPLICATE") return;
            const requiresResync = action === "RESYNC";
            streamState.set(message.channel, { epoch: message.epoch, sequence: message.sequence });

            if (message.channel === liveMarketChannel) {
              const updates = (message.data as HotMarketUpdate).items;
              const byAddress = new Map(
                updates.map((token) => [token.tokenAddress.toLowerCase(), token]),
              );
              setTokens((current) =>
                current.map((token) => byAddress.get(token.tokenAddress.toLowerCase()) ?? token),
              );
              setSearchResults(
                (current) =>
                  current?.map((token) => {
                    const update = byAddress.get(token.tokenAddress.toLowerCase());
                    return update ? { ...update, volume1hUsd: token.volume1hUsd } : token;
                  }) ?? null,
              );
              setSelected((current) => {
                if (!current) return current;
                const update = byAddress.get(current.tokenAddress.toLowerCase());
                return update
                  ? {
                      ...current,
                      priceUsd: update.priceUsd,
                      priceQuote: update.priceQuote,
                      change24h: update.change24h,
                    }
                  : current;
              });
              return;
            }
            if (message.channel === marketChannel) {
              const refreshedToken = message.data as Token;
              setSelected((current) => ({
                ...refreshedToken,
                localLiquidity:
                  refreshedToken.localLiquidity ??
                  (current?.tokenAddress.toLowerCase() === refreshedToken.tokenAddress.toLowerCase()
                    ? current.localLiquidity
                    : undefined),
              }));
              return;
            }
            if (message.channel === candleChannel) {
              const candles = streamBatchItems(message.data as Candle | StreamBatch<Candle>);
              const current = candleCacheRef.current.get(
                candleCacheKey(selectedTokenAddress, interval),
              );
              if (
                requiresResync ||
                (current &&
                  candles.some(
                    (candle) => (candle.series ?? "USD") !== snapshotCandleSeries(current),
                  ))
              )
                recover(candleChannel);
              candles.forEach(upsertCandle);
              return;
            }
            if (message.channel === tradeChannel) {
              const batch = streamBatchItems(message.data as Trade | StreamBatch<Trade>);
              const current = tradeCacheRef.current.get(currentTradeCacheKey) ?? {
                items: [],
                nextCursor: null,
                initialized: false,
              };
              const incoming = [...batch].reverse();
              const items = mergeTrades(current.items, batch);
              boundedMapSet(tradeCacheRef.current, currentTradeCacheKey, { ...current, items }, 64);
              // Normal TRADE items retain forward producer order. Never use mergeTrades
              // for this head: timestamp ties and table sorting lose that ordering.
              const head =
                latestTradeRef.current?.key === currentTradeCacheKey
                  ? latestTradeRef.current
                  : null;
              const candidate = batch.filter((t) => !t.history && !t.correction).at(-1);
              const olderRevision =
                head?.revision &&
                message.revision &&
                BigInt(message.revision) <= BigInt(head.revision);
              const knownOlder =
                candidate &&
                candidate.tradeId !== head?.trade?.tradeId &&
                current.items.some((t) => t.tradeId === candidate.tradeId);
              if (
                !requiresResync &&
                !olderRevision &&
                !knownOlder &&
                candidate &&
                (!head?.trade || candidate.t >= head.trade.t)
              )
                updateLatestTrade({
                  key: currentTradeCacheKey,
                  trade: candidate,
                  revision: message.revision,
                });
              if (batch.some((t) => t.history || t.correction)) recover(tradeChannel);
              if (!tradesPausedRef.current) {
                setTrades(items);
                const seen = new Set(current.items.map((trade) => trade.tradeId));
                const fresh = incoming.filter(
                  (trade) =>
                    !seen.has(trade.tradeId) && trade.history !== true && trade.correction !== true,
                );
                if (
                  !requiresResync &&
                  fresh.length &&
                  !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
                ) {
                  const until = Date.now() + 700;
                  setTradeFlashes((currentFlash) => {
                    const deadlines = new Map(
                      currentFlash?.key === currentTradeCacheKey ? currentFlash.deadlines : [],
                    );
                    for (const trade of fresh) deadlines.set(trade.tradeId, until);
                    return { key: currentTradeCacheKey, deadlines };
                  });
                }
              }
              if (requiresResync) recover(tradeChannel);
            }
          } catch {
            setStreamError("实时行情暂时不可用，正在重连");
            nextSocket.close();
          }
        });
        nextSocket.addEventListener("error", () => nextSocket.close());
        nextSocket.addEventListener("close", () => {
          if (socket !== nextSocket) return;
          window.clearTimeout(openTimer);
          openTimer = undefined;
          socket = null;
          if (streamSocketRef.current === nextSocket) streamSocketRef.current = null;
          if (!disposed && !isHidden()) setStreamError("实时行情暂时不可用，正在重连");
          scheduleReconnect();
        });
      } catch (cause) {
        if (!disposed) {
          if (accountAvailable && accountMode === "AZ_ACCOUNT" && isAzLoginUpstreamFailure(cause)) {
            setSessionToken(null);
            setSessionReady(false);
            setAccount(null);
            setAccountError(friendlyError(cause, "登录失败"));
            setAccountOriginIssue(true);
            return;
          }
          if (
            accountAvailable &&
            cause instanceof ApiError &&
            (cause.status === 401 || cause.code === "MEME_UNAUTHORIZED")
          ) {
            setSessionToken(null);
            setSessionReady(false);
            setAccount(null);
            setQuoteState(null);
            setAccountError("登录已失效，请重新登录");
            return;
          }
          setStreamError("实时行情暂时不可用，历史行情仍可查看");
          scheduleReconnect();
        }
      } finally {
        connecting = false;
      }
    };

    const resume = () => {
      if (disposed) return;
      if (document.visibilityState === "hidden") {
        if (reconnectTimer !== undefined) {
          window.clearTimeout(reconnectTimer);
          reconnectTimer = undefined;
        }
        for (const state of recovery.values()) {
          if (state.timer !== undefined) {
            window.clearTimeout(state.timer);
            state.timer = undefined;
          }
        }
        return;
      }
      if (Date.now() - lastResume < 2_000) return;
      lastResume = Date.now();
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      // A quiet OPEN socket may have silently died while the browser was suspended.
      if (socket && Date.now() - lastActivity >= 30_000) {
        const retired = socket;
        socket = null;
        if (streamSocketRef.current === retired) streamSocketRef.current = null;
        window.clearTimeout(openTimer);
        openTimer = undefined;
        retired.close();
      }
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      void connect();
      const cached = candleCacheRef.current.get(candleCacheKey(selectedTokenAddress, interval));
      if (cached?.syncStatus === "BACKFILLING" || cached?.syncStatus === "CATCHING_UP")
        candleHistoryScopeRef.current?.refresh?.();
      else recover(candleChannel, !recovery.get(candleChannel)?.flight);
      recover(tradeChannel, !recovery.get(tradeChannel)?.flight);
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ op: "subscribe", channels }));
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("pageshow", resume);

    void connect();
    return () => {
      disposed = true;
      recoveryController.abort();
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("pageshow", resume);
      for (const state of recovery.values()) {
        if (state.timer !== undefined) window.clearTimeout(state.timer);
        if (state.deadline !== undefined) window.clearTimeout(state.deadline);
      }
      window.clearTimeout(openTimer);
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (streamSocketRef.current === socket) streamSocketRef.current = null;
      socket?.close();
    };
  }, [
    accountAvailable,
    accountMode,
    privyWallet,
    selectedTokenAddress,
    selectedMarketKey,
    marketStreamAvailable,
    updateLatestTrade,
    interval,
    setCachedSnapshot,
    setError,
  ]);

  useEffect(() => {
    const controller = new AbortController();
    const version = ++quoteVersionRef.current;
    let inFlight = false;
    let expiryTimer: number | undefined;
    setQuoteState(null);
    const refresh = async () => {
      if (!accountAvailable || !quoteRequest || inFlight) return;
      inFlight = true;
      try {
        const freshQuote = await memeApi.createQuote(
          { ...quoteRequest, slippageBps: displayedSlippageRef.current ?? fallbackSlippageBps },
          controller.signal,
        );
        if (
          controller.signal.aborted ||
          quoteRequestRef.current !== quoteRequest ||
          quoteVersionRef.current !== version
        )
          return;
        if (!matchesQuoteRequest(freshQuote, quoteRequest)) throw new Error("报价与当前请求不匹配");
        setQuoteState({
          value: freshQuote,
          request: quoteRequest,
        });
        setErrorState((current) => (current?.owner === quoteRequest ? null : current));
        window.clearTimeout(expiryTimer);
        expiryTimer = window.setTimeout(
          () => {
            setQuoteState(null);
            void refresh();
          },
          Math.min(2_147_483_647, Math.max(0, freshQuote.expiresAt - Date.now())),
        );
      } catch (cause) {
        if (
          !controller.signal.aborted &&
          quoteRequestRef.current === quoteRequest &&
          quoteVersionRef.current === version
        ) {
          setErrorState({
            message: friendlyError(cause, "报价暂时不可用"),
            owner: quoteRequest,
            quote: true,
          });
        }
      } finally {
        inFlight = false;
      }
    };
    const refreshExpired = () => {
      setQuoteState(null);
      void refresh();
    };
    refreshExpiredQuoteRef.current = refreshExpired;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    const socket = streamSocketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN && selectedTokenAddress)
      socket.send(JSON.stringify({ op: "subscribe", channels: marketChannelsRef.current }));
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.clearTimeout(expiryTimer);
      refreshExpiredQuoteRef.current = () => {};
    };
  }, [quoteRequest, selectedTokenAddress, accountAvailable, accountMode, fallbackSlippageBps]);

  const selectedPosition = account?.positions.find(
    (item) => item.tokenAddress.toLowerCase() === selected?.tokenAddress.toLowerCase(),
  );
  const currentBalance =
    side === "BUY"
      ? (account?.quoteBalances.find((item) => item.asset === asset)?.available ?? "0")
      : (selectedPosition?.available ?? "0");
  const loadMoreTrades = useCallback(
    (element: HTMLDivElement) => {
      if (tradesPausedRef.current) return;
      if (element.scrollHeight - element.scrollTop - element.clientHeight > 40) return;
      if (
        !activeTradeKey ||
        !selectedTokenAddress ||
        !selectedMarketKey ||
        !tradeNextCursor ||
        tradesLoading
      )
        return;
      const scope = tradeHistoryScopeRef.current;
      if (!scope || scope.key !== activeTradeKey) return;
      const baseline = new Map(
        (tradeCacheRef.current.get(activeTradeKey)?.items ?? []).map((trade) => [
          trade.tradeId,
          trade,
        ]),
      );
      setTradesLoading(true);
      void memeApi
        .getTrades(selectedTokenAddress, tradeNextCursor)
        .then((page) => {
          if (tradeHistoryScopeRef.current !== scope) return;
          const current = tradeCacheRef.current.get(activeTradeKey) ?? {
            items: [],
            nextCursor: tradeNextCursor,
            initialized: true,
          };
          const items = mergeTrades(current.items, page.items, baseline);
          const entry = {
            items,
            nextCursor: items.length >= 5000 ? null : page.nextCursor,
            initialized: true,
          };
          boundedMapSet(tradeCacheRef.current, activeTradeKey, entry, 64);
          if (!tradesPausedRef.current) setTrades(items);
          setTradeNextCursor(entry.nextCursor);
        })
        .catch((cause: unknown) => {
          if (tradeHistoryScopeRef.current === scope)
            setError(friendlyError(cause, "更早成交加载失败"));
        })
        .finally(() => {
          if (tradeHistoryScopeRef.current === scope) setTradesLoading(false);
        });
    },
    [
      activeTradeKey,
      selectedMarketKey,
      selectedTokenAddress,
      tradeNextCursor,
      tradesLoading,
      setError,
    ],
  );
  const toggleTradesPaused = useCallback(() => {
    const next = !tradesPausedRef.current;
    tradesPausedRef.current = next;
    setTradesPaused(next);
    if (!next && activeTradeKey) {
      const cached = tradeCacheRef.current.get(activeTradeKey);
      if (cached) {
        setTrades(cached.items);
        setTradeNextCursor(cached.nextCursor);
      }
      setNowSeconds(Math.floor(Date.now() / 1000));
    }
  }, [activeTradeKey]);
  const totalPosition = useMemo(
    () => account?.positions.reduce((sum, item) => sum + Number(item.valueUsd), 0) ?? 0,
    [account],
  );
  const visibleTokens = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return tokens;
    if (searchResults) return searchResults;
    return tokens.filter(
      (token) =>
        token.symbol.toLowerCase().includes(needle) ||
        token.name.toLowerCase().includes(needle) ||
        token.tokenAddress.toLowerCase().includes(needle),
    );
  }, [search, searchResults, tokens]);

  const selectDiscoveryTab = useCallback(
    async (tab: "hot" | "new", retry = false) => {
      if (tab === discoveryIntentRef.current && !retry) return;
      discoveryIntentRef.current = tab;
      setRequestedDiscoveryTab(tab);
      listRetryTabRef.current = tab;
      setListLoading(true);
      setListFailed(false);
      const requestId = ++discoveryRequestRef.current;
      // A new tab intent immediately invalidates any outstanding token detail.
      ++selectionRequestRef.current;
      window.clearTimeout(detailPollRef.current);
      setDetailLoading(false);
      setDetailError(null);
      setError(null);
      try {
        const result = await memeApi.getMarkets(tab);
        if (requestId !== discoveryRequestRef.current) return;
        setTokens(result.items);
        setDiscoveryTab(tab);
        const candidate =
          result.items.find((item) => item.tokenAddress === selected?.tokenAddress) ??
          result.items[0];
        if (candidate) void selectToken(candidate);
      } catch (cause) {
        if (requestId !== discoveryRequestRef.current) return;
        discoveryIntentRef.current = discoveryTab;
        setRequestedDiscoveryTab(discoveryTab);
        setListFailed(true);
        setError(friendlyError(cause, "市场加载失败"));
      } finally {
        if (requestId === discoveryRequestRef.current) setListLoading(false);
      }
    },
    [discoveryTab, selectToken, selected?.tokenAddress, setError],
  );
  const tradePresets = useMemo(() => {
    if (side === "BUY") {
      const values =
        accountMode === "MAIN_ACCOUNT_POC"
          ? pocUsdgPresets
          : asset === "ETH"
            ? ethPresets
            : stablePresets;
      return values.map((value) => ({ label: value, value }));
    }
    return [25, 50, 75, 100].map((percent) => ({
      label: `${percent}%`,
      value: percentageOf(currentBalance, percent),
    }));
  }, [accountMode, asset, currentBalance, side]);

  const resetTradeDraft = useCallback(() => {
    setOrderState(null);
    setManualSlippage(null);
  }, []);

  const selectSide = useCallback(
    (nextSide: "BUY" | "SELL") => {
      setSide(nextSide);
      const nextBuyAmount =
        accountMode === "MAIN_ACCOUNT_POC" ? "1" : asset === "ETH" ? "0.1" : "100";
      setAmount(nextSide === "BUY" ? nextBuyAmount : "0");
      setActivePreset(nextSide === "BUY" ? nextBuyAmount : null);
      resetTradeDraft();
    },
    [accountMode, asset, resetTradeDraft],
  );

  const loadOlderCandles = useCallback(
    async (before: number): Promise<HistoryLoadResult> => {
      if (!selected) return { added: 0, exhausted: false };
      const scope = candleHistoryScopeRef.current;
      if (!scope || scope.key !== candleCacheKey(selected.tokenAddress, interval) || scope.loading)
        return { added: 0, exhausted: false };
      if (scope.exhausted) return { added: 0, exhausted: true };
      const earliest = candleCacheRef.current.get(scope.key)?.items[0]?.t;
      if (
        !Number.isSafeInteger(before) ||
        before < 0 ||
        earliest === undefined ||
        before >= earliest
      )
        return { added: 0, exhausted: false };
      scope.loading = true;
      try {
        const cached = candleCacheRef.current.get(scope.key);
        const requestedSeries = cached ? snapshotCandleSeries(cached) : "USD";
        const result = await memeApi.getCandles(selected.tokenAddress, interval, {
          to: before,
          limit: candlePageSize,
          signal: scope.controller.signal,
          ...(cached?.candleRules ? { series: requestedSeries } : {}),
        });
        if (candleHistoryScopeRef.current !== scope) return { added: 0, exhausted: false };
        const current = candleCacheRef.current.get(scope.key);
        if (current && snapshotCandleSeries(current) !== requestedSeries)
          return { added: 0, exhausted: false };
        if (
          result.tokenAddress.toLowerCase() !== selected.tokenAddress.toLowerCase() ||
          result.interval !== interval ||
          result.marketKey !== selectedMarketKey ||
          snapshotCandleSeries(result) !== requestedSeries ||
          result.items.some((item) => item.t > before)
        )
          throw new Error("更早行情响应超出请求范围");
        const currentTimes = new Set(
          candleCacheRef.current.get(scope.key)?.items.map((item) => item.t),
        );
        const added = new Set(
          result.items
            .filter((item) => item.t < earliest && !currentTimes.has(item.t))
            .map((item) => item.t),
        ).size;
        // A completed bounded page with no earlier bars is exhausted for this scope.
        scope.exhausted =
          (added === 0 &&
            (result.syncStatus === "READY" ||
              result.availability === "UNAVAILABLE_BEFORE_START" ||
              result.gaps.some((gap) => gap.reason === "BEFORE_SCAN_START" && gap.to >= before))) ||
          result.syncStatus === "STALE" ||
          result.syncStatus === "FAILED";
        setHistoryError(
          result.syncStatus === "STALE" || result.syncStatus === "FAILED"
            ? { owner: scope, message: "数据同步失败，后端未提供详细原因，请重试" }
            : null,
        );
        setCachedSnapshot((current) =>
          candleHistoryScopeRef.current === scope ? mergeSnapshots(current, result) : current,
        );
        return { added, exhausted: scope.exhausted };
      } catch (cause) {
        if (candleHistoryScopeRef.current === scope && !scope.controller.signal.aborted) {
          setHistoryError({ owner: scope, message: friendlyError(cause, "更早行情加载失败") });
          throw cause;
        }
        return { added: 0, exhausted: false };
      } finally {
        scope.loading = false;
      }
    },
    [interval, selected, selectedMarketKey, setCachedSnapshot],
  );

  const submitOrder = useCallback(async () => {
    if (!accountAvailable || orderBusyRef.current || slippageBps === null || !slippageSupported)
      return;
    if (!quote || quote.expiresAt <= Date.now()) {
      refreshExpiredQuoteRef.current();
      return;
    }
    let executionSent = false;
    orderBusyRef.current = true;
    setOrderBusy(true);
    setError(null);
    setOrderState("提交中");
    try {
      if (accountMode === "MAIN_ACCOUNT_POC") {
        if (!quoteRequest) throw new Error("请输入有效金额");
        setOrderState("处理中");
        const input = preparationInput({ ...quoteRequest, slippageBps }, quote);
        const response = await memeApi.createQuote(input);
        if (
          quoteRequestRef.current !== quoteRequest ||
          displayedSlippageRef.current !== slippageBps ||
          displayedMinimumRef.current !== input.minAmountOut
        )
          return;
        const prepared = requirePreparedQuote(response, input);
        if (!selected) throw new Error("请选择代币");
        if (asset === "USDT") throw new Error("当前主账户未配置 USDT");
        const settlementAsset = asset;
        const requestKey = [
          prepared.quoteId,
          side,
          selected.tokenAddress.toLowerCase(),
          settlementAsset,
          normalizedDecimal(input.amountIn),
          slippageBps,
        ].join(":");
        let clientExecutionId = mainAccountIdempotencyRef.current.get(requestKey);
        if (!clientExecutionId) {
          clientExecutionId = crypto.randomUUID();
          mainAccountIdempotencyRef.current.set(requestKey, clientExecutionId);
        }
        executionSent = true;
        const transaction = await memeApi.executeMainAccountTrade({
          clientExecutionId,
          side,
          tokenAddress: selected.tokenAddress,
          settlementAsset,
          quoteId: prepared.quoteId!,
          routeFingerprint: prepared.routeFingerprint!,
          minAmountOut: input.minAmountOut!,
          amountIn: input.amountIn,
          slippageBps,
        });
        setAccountTransactions((current) => upsertAccountTransaction(current, transaction));
        setOrderState("处理中");
        await trackMainAccountTransaction(transaction.executionId);
        return;
      }
      if (!quote.quoteId) throw new Error("估计不能提交订单，请先准备交易");
      let clientOrderId = orderIdempotencyRef.current.get(quote.quoteId);
      if (!clientOrderId) {
        clientOrderId = crypto.randomUUID();
        orderIdempotencyRef.current.set(quote.quoteId, clientOrderId);
      }
      executionSent = true;
      const order = await memeApi.createOrder({
        clientOrderId,
        quoteId: quote.quoteId!,
        maxAmountIn: quote.amountIn,
        minAmountOut: quote.minAmountOut,
      });
      setOrderState("处理中");
      await trackOrder(order.orderId);
    } catch (cause) {
      if (quoteRequestRef.current !== quoteRequest) return;
      setOrderState(null);
      if (
        !executionSent &&
        (cause instanceof QuoteExpiredError ||
          (cause instanceof ApiError && cause.code === "MEME_QUOTE_EXPIRED"))
      ) {
        refreshExpiredQuoteRef.current();
        return;
      }
      setError(friendlyError(cause, "下单请求未完成"));
    } finally {
      orderBusyRef.current = false;
      setOrderBusy(false);
    }
  }, [
    accountAvailable,
    accountMode,
    asset,
    quote,
    quoteRequest,
    selected,
    side,
    slippageBps,
    slippageSupported,
    trackMainAccountTransaction,
    trackOrder,
    setError,
  ]);

  const submitTransfer = useCallback(async () => {
    if (!accountAvailable) return;
    if (!/^\d+(?:\.\d+)?$/.test(transferAmount) || Number(transferAmount) <= 0) {
      setError("请输入有效的划转金额");
      return;
    }
    setTransferState("划转中");
    setError(null);
    try {
      const from = transferDirection === "SPOT_TO_MEME" ? "SPOT" : "MEME";
      const to = from === "SPOT" ? "MEME" : "SPOT";
      if (typeof crypto.randomUUID !== "function") throw new Error("当前浏览器不支持安全划转编号");
      const randomId = crypto.randomUUID();
      const transferId = await azFundApi.transfer({
        bizId: `meme-transfer-${randomId}`,
        from,
        to,
        currency: transferAsset,
        amount: transferAmount,
      });
      const summary = await memeApi.getAccount();
      setAccount(summary);
      setTransferState(`划转成功 / ${transferId}`);
    } catch (cause) {
      setTransferState(null);
      setError(friendlyError(cause, "划转失败"));
    }
  }, [accountAvailable, transferAmount, transferAsset, transferDirection, setError]);

  if (loading) return <main className="full-state">正在加载</main>;
  if (bootstrapError)
    return <main className="full-state error-state">启动失败：{bootstrapError}</main>;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-group">
          <div className="brand">
            AZ<span>X</span>
          </div>
          <div className="product-name">
            <strong>Meme</strong>
            <span>{chainName}</span>
          </div>
        </div>
        <label className="search">
          <span className="sr-only">搜索代币名称或合约地址</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索代币或粘贴合约地址"
          />
        </label>
        {!guest && (
          <WalletAssets
            balances={account?.quoteBalances}
            error={accountError ? "账户不可用" : null}
            {...(accountMode === "MAIN_ACCOUNT_POC"
              ? {}
              : { onTransfer: () => setTransferOpen(true) })}
          />
        )}
        <button
          type="button"
          className="icon-button history-trigger"
          aria-label="交易记录"
          title="交易记录"
          onClick={() => (guest ? onConnect?.() : setHistoryOpen(true))}
        >
          <svg
            viewBox="0 0 24 24"
            width="19"
            height="19"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden="true"
          >
            <path d="M3 11a9 9 0 1 1 2.6 7M3 5v6h6M12 7v5l3 2" />
          </svg>
        </button>
        <div
          className="mock-badge"
          data-state={accountError ? "failed" : accountAvailable ? "connected" : "pending"}
        >
          <i aria-hidden="true" />
          {guest
            ? "未连接钱包"
            : accountError
              ? "账户连接失败"
              : accountAvailable
                ? "钱包已连接"
                : "钱包连接中"}
        </div>
        {onLogout && (
          <button type="button" className="icon-button logout-button" onClick={onLogout}>
            退出
          </button>
        )}
      </header>

      {accountError && (
        <div className="notice" role="alert">
          账户请求失败：{accountError}
          {accountOriginIssue && (
            <span>
              当前入口 {window.location.origin} 使用 AZ_ACCOUNT，AZ
              登录上游不可用，请检查此入口的认证服务配置。
              {privateAccountHref && (
                <a href={privateAccountHref} target="_blank" rel="noreferrer">
                  打开主账户入口（Tailscale / 私网）
                </a>
              )}
            </span>
          )}
          <button type="button" onClick={() => setAccountRetry((n) => n + 1)}>
            重试账户连接
          </button>
        </div>
      )}
      {streamError && (
        <div className="notice" role="alert">
          {streamError}
        </div>
      )}
      {error && (
        <div className="notice" role="alert">
          {error}
          <button type="button" onClick={() => setError(null)}>
            关闭
          </button>
        </div>
      )}

      <div className="workspace">
        <aside className="market-panel" aria-busy={listLoading}>
          <div className="panel-title">
            <strong>发现</strong>
            <div className="discovery-tabs">
              <button
                type="button"
                className={requestedDiscoveryTab === "hot" ? "active" : ""}
                onClick={() => void selectDiscoveryTab("hot")}
              >
                热榜
              </button>
              <button
                type="button"
                className={requestedDiscoveryTab === "new" ? "active" : ""}
                onClick={() => void selectDiscoveryTab("new")}
              >
                新币
              </button>
            </div>
          </div>
          {listLoading && (
            <div className="loading-note" role="status" aria-label="列表加载状态">
              {requestedDiscoveryTab === "hot" ? "热榜" : "新币"}列表加载中…
              {tokens.length > 0 && ` 暂显示${discoveryTab === "hot" ? "热榜" : "新币"}`}
            </div>
          )}
          {listFailed && (
            <div className="loading-note">
              列表加载失败{" "}
              <button
                type="button"
                onClick={() => void selectDiscoveryTab(listRetryTabRef.current, true)}
              >
                重试列表
              </button>
            </div>
          )}
          <div className="token-head">
            <span>代币</span>
            <span>市值</span>
            <span>{search.trim() ? "1h 量" : "24h"}</span>
            <span>持有</span>
            <span />
          </div>
          <div className="token-list">
            {!listLoading && !listFailed && visibleTokens.length === 0 && (
              <div className="empty">没有匹配的代币</div>
            )}
            {visibleTokens.map((token) => (
              <div
                key={token.tokenAddress}
                className={
                  selected?.tokenAddress === token.tokenAddress ? "token-row selected" : "token-row"
                }
              >
                <button
                  type="button"
                  className="token-select"
                  aria-label={`查看 ${token.symbol}`}
                  onClick={() => void selectToken(token)}
                >
                  <span className="row-token">
                    <TokenMark token={token} />
                    <span>
                      <b>{token.symbol}</b>
                      <small>
                        <em className={token.stage === "CURVE" ? "badge curve" : "badge graduated"}>
                          {stageLabel(token)}
                        </em>
                        {launchpadLabel(token.launchpad) && (
                          <em className="badge launchpad">{launchpadLabel(token.launchpad)}</em>
                        )}
                        <span>{age(token.ageSeconds)}</span>
                      </small>
                      <small className="token-risk">
                        <TokenRiskLabels security={token.security} />
                      </small>
                    </span>
                  </span>
                  <span>{money(token.marketCapUsd)}</span>
                  {search.trim() ? (
                    <span>{searchVolumeLabel(token.volume1hUsd)}</span>
                  ) : (
                    <TokenChange tokenAddress={token.tokenAddress} value={token.change24h} />
                  )}
                  <span>{compact(token.holders)}</span>
                </button>
                <button
                  type="button"
                  className="quick-buy"
                  aria-label={`买入 ${token.symbol}`}
                  onClick={() => {
                    void selectToken(token);
                    selectSide("BUY");
                  }}
                >
                  买
                </button>
              </div>
            ))}
          </div>
        </aside>

        <section className="chart-panel" aria-busy={detailLoading}>
          {selected && detailLoading && (
            <div
              className="loading-note"
              role="status"
              aria-label="详情加载状态"
              data-token-address={selected.tokenAddress}
            >
              {selected.symbol}{" "}
              {selected.detailStatus === "UPDATING" ? "详情更新中，显示已有数据" : "详情加载中…"}
            </div>
          )}
          {selected && detailError && (
            <div className="loading-note" role="alert">
              {detailError}{" "}
              <button type="button" onClick={() => void selectToken(selected, true)}>
                重试详情
              </button>
            </div>
          )}
          {selected ? (
            <>
              <div className="instrument">
                <div className="token-identity">
                  <TokenMark token={selected} />
                  <div>
                    <div className="token-title">
                      <strong>{selected.symbol}</strong>
                      <span
                        className={selected.stage === "CURVE" ? "badge curve" : "badge graduated"}
                      >
                        {stageLabel(selected)}
                      </span>
                      {launchpadLabel(selected.launchpad) && (
                        <span className="badge launchpad">
                          {launchpadLabel(selected.launchpad)}
                        </span>
                      )}
                      <span className="badge pool">{poolLabel(selected.pool.poolType)}</span>
                      {quote && <span className="badge executable">当前资产可报价</span>}
                    </div>
                    <small>
                      {selected.name} / <CopyableAddress value={selected.tokenAddress} />
                    </small>
                  </div>
                </div>
                <div className="market-stats">
                  <div>
                    <span>价格</span>
                    <strong data-testid="current-price">{money(displayedPrice)}</strong>
                  </div>
                  <div>
                    <span>市值</span>
                    <strong>{money(selected.marketCapUsd)}</strong>
                  </div>
                  <div>
                    <span>24h 量</span>
                    <strong>{money(selected.volume24hUsd)}</strong>
                  </div>
                  <TokenLiquidity token={selected} money={money} />
                  <div>
                    <span>持有人</span>
                    <strong>{compact(selected.holders)}</strong>
                  </div>
                </div>
              </div>
              <div className="chart-toolbar">
                <div className="intervals" aria-label="K 线周期">
                  {intervals.map((item) => (
                    <button
                      type="button"
                      className={interval === item ? "active" : ""}
                      key={item}
                      onClick={() => setIntervalValue(item)}
                    >
                      {item}
                    </button>
                  ))}
                </div>
                <span className={Number(selected.change24h) >= 0 ? "positive" : "negative"}>
                  {formatPercent(selected.change24h)} / 24h
                </span>
              </div>
              <CandleChart
                key={`${selected.tokenAddress.toLowerCase()}:${selectedMarketKey}:${interval}:${activeSnapshot ? snapshotCandleSeries(activeSnapshot) : "USD"}`}
                candles={activeSnapshot?.items ?? []}
                gaps={activeSnapshot?.gaps}
                legacy={Boolean(activeSnapshot && snapshotCandleSeries(activeSnapshot) === "USD")}
                symbol={selected.symbol}
                refreshing={
                  chartLoading ||
                  (!activeSnapshot && !marketError) ||
                  Boolean(
                    activeSnapshot &&
                    activeSnapshot.items.length === 0 &&
                    ["BACKFILLING", "CATCHING_UP"].includes(activeSnapshot.syncStatus),
                  )
                }
                historyRetry={marketRetry}
                onLoadBefore={loadOlderCandles}
              />
              {(marketError || historyError) && (
                <div className="market-retry" role="alert">
                  <span>{marketError ?? historyError?.message}</span>
                  <button type="button" onClick={() => setMarketRetry((value) => value + 1)}>
                    重试
                  </button>
                </div>
              )}
              <section className="trade-tape" aria-label="实时成交">
                <header>
                  <strong>实时成交</strong>
                  <div className="trade-actions">
                    <span className="trade-count">
                      {trades.length > 0 ? `${trades.length} 笔` : "最新成交"}
                    </span>
                    <button
                      type="button"
                      className={tradesPaused ? "trade-pause active" : "trade-pause"}
                      onClick={toggleTradesPaused}
                    >
                      {tradesPaused ? "继续" : "暂停"}
                    </button>
                  </div>
                </header>
                <div className="trade-head">
                  <span>方向 / 数量</span>
                  <span>成交价</span>
                  <span>Quote</span>
                  <span>Value</span>
                  <span>交易者</span>
                  <span>Tx</span>
                  <span>时间</span>
                </div>
                <div
                  className="trade-rows"
                  onScroll={(event) => loadMoreTrades(event.currentTarget)}
                >
                  {trades.length === 0 && (
                    <div className="trade-empty">{tradesLoading ? "正在加载成交" : "暂无成交"}</div>
                  )}
                  {trades.map((trade) => {
                    const txUrl = transactionUrl(explorerBaseUrl, trade.txHash);
                    const traderUrl = addressUrl(explorerBaseUrl, trade.trader);
                    return (
                      <div
                        className={
                          tradeFlashes?.key === activeTradeKey &&
                          tradeFlashes.deadlines.has(trade.tradeId)
                            ? "trade-row trade-flash"
                            : "trade-row"
                        }
                        key={`${activeTradeKey}:${trade.tradeId}`}
                      >
                        <span className={trade.side === "BUY" ? "positive" : "negative"}>
                          {trade.side === "BUY" ? "买" : "卖"} {compact(trade.baseAmount)}{" "}
                          {selected.symbol}
                        </span>
                        <span data-testid="trade-price">{money(trade.priceUsd)}</span>
                        <span>
                          {compact(trade.quoteAmount)} {trade.quoteAsset}
                        </span>
                        <span data-testid="trade-value">{tradeValueUsd(trade)}</span>
                        <span className="trader-address">
                          {traderUrl ? (
                            <a
                              className="trade-tx"
                              href={traderUrl}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={`打开交易者地址 ${shortAddress(trade.trader)}`}
                            >
                              {shortAddress(trade.trader)} ↗
                            </a>
                          ) : (
                            shortAddress(trade.trader)
                          )}
                          <CopyableAddress value={trade.trader} iconOnly />
                        </span>
                        <span>
                          {txUrl ? (
                            <a
                              className="trade-tx"
                              href={txUrl}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={`查看交易 ${shortAddress(trade.txHash)}`}
                            >
                              {shortAddress(trade.txHash)} ↗
                            </a>
                          ) : (
                            shortAddress(trade.txHash)
                          )}
                        </span>
                        <span>{relativeAge(trade.t, nowSeconds)}</span>
                      </div>
                    );
                  })}
                  {tradesLoading && trades.length > 0 && <div className="trade-more">正在加载</div>}
                  {!tradesLoading && tradeNextCursor && (
                    <div className="trade-more">向下滚动加载更多</div>
                  )}
                </div>
              </section>
            </>
          ) : (
            <div className="empty">请选择代币</div>
          )}
        </section>

        <aside className="trade-panel">
          {selected && <TokenRiskGrid token={selected} />}
          <div className="side-tabs">
            <button
              type="button"
              className={side === "BUY" ? "active buy" : ""}
              onClick={() => selectSide("BUY")}
            >
              买入
            </button>
            <button
              type="button"
              className={side === "SELL" ? "active sell" : ""}
              onClick={() => selectSide("SELL")}
            >
              卖出
            </button>
          </div>
          <form
            className="trade-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submitOrder();
            }}
          >
            <label>
              <span>{side === "BUY" ? "金额" : "数量"}</span>
              <span>
                可用 {guest ? "—" : readableAmount(currentBalance)}{" "}
                {side === "BUY" ? asset : selected?.symbol}
              </span>
            </label>
            <div className="amount-input">
              <input
                aria-label={side === "BUY" ? "买入金额" : "卖出数量"}
                value={amount}
                onChange={(event) => {
                  setAmount(event.target.value);
                  setActivePreset(null);
                  resetTradeDraft();
                }}
                inputMode="decimal"
              />
              {side === "BUY" ? (
                <select
                  aria-label="支付资产"
                  value={asset}
                  onChange={(event) => {
                    const nextAsset = event.target.value as Asset;
                    setAsset(nextAsset);
                    const nextAmount =
                      accountMode === "MAIN_ACCOUNT_POC"
                        ? "1"
                        : nextAsset === "ETH"
                          ? "0.1"
                          : "100";
                    setAmount(nextAmount);
                    setActivePreset(nextAmount);
                    resetTradeDraft();
                  }}
                >
                  {settlementAssets.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              ) : (
                <span className="amount-unit">{selected?.symbol}</span>
              )}
            </div>
            {side === "SELL" && (
              <label className="settlement">
                <span>结算资产</span>
                <select
                  aria-label="结算资产"
                  value={asset}
                  onChange={(event) => {
                    setAsset(event.target.value as Asset);
                    resetTradeDraft();
                  }}
                >
                  {settlementAssets.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </label>
            )}
            <div className="presets">
              {tradePresets.map((preset) => (
                <button
                  type="button"
                  className={activePreset === preset.label ? "active" : ""}
                  key={preset.label}
                  onClick={() => {
                    setAmount(preset.value);
                    setActivePreset(preset.label);
                    resetTradeDraft();
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <dl className="quote-details">
              <div>
                <dt>预计得到</dt>
                <dd>
                  {rawQuote ? (
                    <span title={rawQuote.expectedAmountOut}>
                      ≈ {displayAmount(rawQuote.expectedAmountOut)}{" "}
                      {side === "BUY" ? selected?.symbol : asset}
                    </span>
                  ) : (
                    "等待报价"
                  )}
                </dd>
              </div>
              <div>
                <dt>最低得到</dt>
                <dd>
                  {quote ? (
                    <span title={quote.minAmountOut}>
                      {displayAmount(quote.minAmountOut)}{" "}
                      {side === "BUY" ? selected?.symbol : asset}
                    </span>
                  ) : (
                    "等待滑点"
                  )}
                </dd>
              </div>
              <div>
                <dt>
                  <label htmlFor="slippage">滑点</label>
                </dt>
                <dd>
                  <input
                    id="slippage"
                    aria-label="滑点百分比"
                    inputMode="decimal"
                    value={manualValue ?? (slippageBps === null ? "" : String(slippageBps / 100))}
                    placeholder="等待最新成交"
                    onChange={(event) =>
                      setManualSlippage({ key: draftKey, value: event.target.value })
                    }
                  />{" "}
                  %
                  {manualValue !== null && (
                    <button type="button" onClick={() => setManualSlippage(null)}>
                      自动
                    </button>
                  )}
                </dd>
              </div>
            </dl>
            {slippageBps !== null && !slippageSupported && (
              <p role="status">滑点须在 0.01%–99.99% 内，请手动调整</p>
            )}
            {guest ? (
              <button
                type="button"
                className="primary"
                disabled={connectionPending && !connectionError}
                onClick={onConnect}
              >
                {connectionPending && !connectionError ? "连接中…" : "连接钱包"}
              </button>
            ) : (
              <button
                type="submit"
                className="primary"
                aria-busy={orderBusy || !quote || quote.expiresAt <= Date.now()}
                disabled={
                  !accountAvailable ||
                  !selected ||
                  !quoteRequest ||
                  !quote ||
                  quote.expiresAt <= Date.now() ||
                  orderBusy ||
                  (side === "SELL" && Number(currentBalance) <= 0)
                }
              >
                {accountError
                  ? "账户连接失败"
                  : !sessionReady
                    ? accountMode === "MAIN_ACCOUNT_POC"
                      ? "等待主账户"
                      : "等待登录"
                    : orderBusy
                      ? "处理中"
                      : !quote || quote.expiresAt <= Date.now()
                        ? "更新报价中"
                        : side === "BUY"
                          ? "买入"
                          : "卖出"}
              </button>
            )}
            {connectionError && <p role="alert">{connectionError}</p>}
            {orderState && <p role="status">{orderState}</p>}
          </form>

          <div className="positions">
            <div className="positions-head">
              <strong>我的持仓</strong>
              <span className="positive">{guest ? "连接钱包后查看" : money(totalPosition)}</span>
            </div>
            {account?.positions.map((position) => {
              const cost = Number(position.costUsd);
              const pnl =
                cost > 0 ? `${((Number(position.valueUsd) / cost - 1) * 100).toFixed(0)}%` : "-";
              return (
                <div className="position" key={position.tokenAddress}>
                  <span>
                    <b>{position.symbol}</b>
                    <small>{positionQuantity(position.available)} 枚</small>
                  </span>
                  <span
                    className={
                      cost > 0 && Number(position.valueUsd) >= cost ? "positive" : "negative"
                    }
                  >
                    {pnl}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(
                        tokens.find(
                          (token) =>
                            token.tokenAddress.toLowerCase() ===
                            position.tokenAddress.toLowerCase(),
                        ) ?? null,
                      );
                      selectSide("SELL");
                    }}
                  >
                    卖
                  </button>
                </div>
              );
            })}
          </div>
        </aside>
      </div>

      {historyOpen && (
        <HistoryModal
          items={accountTransactions}
          error={transactionRefreshError ?? accountError}
          loading={!sessionReady}
          onClose={() => setHistoryOpen(false)}
          explorer={explorerBaseUrl}
        />
      )}

      {accountMode === "AZ_ACCOUNT" && transferOpen && (
        <div
          className="drawer-backdrop"
          role="presentation"
          onMouseDown={() => setTransferOpen(false)}
        >
          <section
            className="account-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="transfer-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <strong id="transfer-title">Meme Account 划转</strong>
                <span>仅站内记账，不触发链上交易</span>
              </div>
              <button type="button" aria-label="关闭划转" onClick={() => setTransferOpen(false)}>
                ×
              </button>
            </header>
            <label>
              方向
              <select
                aria-label="划转方向"
                value={transferDirection}
                onChange={(event) => {
                  setTransferDirection(event.target.value as typeof transferDirection);
                  setTransferState(null);
                }}
              >
                <option value="SPOT_TO_MEME">Spot → Meme</option>
                <option value="MEME_TO_SPOT">Meme → Spot</option>
              </select>
            </label>
            <label>
              资产
              <select
                aria-label="划转资产"
                value={transferAsset}
                onChange={(event) => {
                  setTransferAsset(event.target.value as Asset);
                  setTransferState(null);
                }}
              >
                <option>ETH</option>
                <option>USDC</option>
                <option>USDT</option>
              </select>
            </label>
            <label>
              金额
              <input
                aria-label="划转金额"
                value={transferAmount}
                inputMode="decimal"
                onChange={(event) => {
                  setTransferAmount(event.target.value);
                  setTransferState(null);
                }}
              />
            </label>
            <button
              type="button"
              className="primary"
              disabled={!accountAvailable || Boolean(transferState?.startsWith("划转中"))}
              onClick={submitTransfer}
            >
              {transferState ?? "确认划转"}
            </button>
          </section>
        </div>
      )}
    </main>
  );
}
