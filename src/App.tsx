import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, azAuth, azFundApi, memeApi, setSessionToken, wsBaseUrl } from './api';
import { CandleChart, type HistoryLoadResult } from './CandleChart';
import { streamBatchItems, streamSequenceAction } from './stream-batches';
import { pollOrderUntilTerminal } from './order-tracker';
import { pollTransactionUntilTerminal } from './transaction-tracker';
import type { AccountSummary, AccountTransaction, Asset, Candle, CandleSnapshot, Interval, Quote, Token, Trade } from './types';
import './styles.css';

const intervals: Interval[] = ['1s', '1m', '15m', '1h', '4h'];
const ethPresets = ['0.05', '0.1', '0.25', '0.5'];
const stablePresets = ['25', '100', '250', '500'];
const pocUsdgPresets = ['1', '2', '5', '10'];
const candlePageSize = 300;

function compact(value: string | number): string {
  return Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value));
}

function money(value: string | number): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return '$0';
  return `$${Intl.NumberFormat('en', {
    notation: Math.abs(number) >= 100_000 ? 'compact' : 'standard',
    maximumFractionDigits: Math.abs(number) >= 1 ? 2 : 12,
    maximumSignificantDigits: Math.abs(number) < 1 ? 6 : undefined,
  }).format(number)}`;
}

function readableAmount(value: string | number): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return Intl.NumberFormat('en-US', {
    maximumSignificantDigits: 7,
    useGrouping: Math.abs(number) >= 1_000,
  }).format(number);
}

function formatPercent(value: string | number): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0.00%';
  return `${number > 0 ? '+' : ''}${number.toFixed(2)}%`;
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
      className={`token-change ${revision > 0 ? 'change-flash ' : ''}${Number(value) >= 0 ? 'positive' : 'negative'}`}
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
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = window.setTimeout(() => setState('idle'), 1_200);
    return () => window.clearTimeout(timer);
  }, [state]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
  };
  return (
    <button type="button" className="copy-address" onClick={() => void copy()} aria-label={`复制地址 ${value}`} title={value}>
      {state === 'copied' ? (iconOnly ? '✓' : '已复制') : state === 'failed' ? (iconOnly ? '×' : '复制失败') : iconOnly ? '⧉' : shortAddress(value)}
    </button>
  );
}

function poolLabel(poolType: string): string {
  return poolType.replaceAll('_', ' ');
}

function stageLabel(token: Token): string {
  return token.stage === 'GRADUATED' ? '已毕业' : '内盘';
}

function percentageOf(value: string, percent: number): string {
  const [whole = '0', fraction = ''] = value.split('.');
  const scale = 10n ** BigInt(fraction.length);
  const units = BigInt(`${whole}${fraction}` || '0');
  const result = (units * BigInt(percent)) / 100n;
  const resultWhole = result / scale;
  const resultFraction = (result % scale).toString().padStart(fraction.length, '0').replace(/0+$/, '');
  return resultFraction ? `${resultWhole}.${resultFraction}` : resultWhole.toString();
}

interface SecurityLabel {
  text: string;
  tone: 'safe' | 'warning' | 'danger' | 'neutral';
}

function securityPercent(value: string): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(number);
}

function securityLabels(token: Token): SecurityLabel[] {
  const labels: SecurityLabel[] = [];
  const { buyTaxPct, sellTaxPct, liquidityBurnedPct, liquidityLockedPct, liquidityLocked, isHoneypot } = token.security;
  if (buyTaxPct !== null && sellTaxPct !== null && buyTaxPct === sellTaxPct) {
    labels.push({ text: `税 ${securityPercent(buyTaxPct)}%`, tone: Number(buyTaxPct) > 0 ? 'warning' : 'safe' });
  } else {
    if (buyTaxPct !== null) labels.push({ text: `买税 ${securityPercent(buyTaxPct)}%`, tone: Number(buyTaxPct) > 0 ? 'warning' : 'safe' });
    if (sellTaxPct !== null) labels.push({ text: `卖税 ${securityPercent(sellTaxPct)}%`, tone: Number(sellTaxPct) > 0 ? 'warning' : 'safe' });
  }
  if (liquidityBurnedPct !== null && Number(liquidityBurnedPct) > 0) {
    labels.push({ text: `已燃烧 ${securityPercent(liquidityBurnedPct)}%`, tone: 'safe' });
  }
  if (liquidityLockedPct !== null && Number(liquidityLockedPct) > 0) {
    labels.push({ text: `已锁仓 ${securityPercent(liquidityLockedPct)}%`, tone: 'safe' });
  } else if (liquidityLocked === true && !(liquidityBurnedPct !== null && Number(liquidityBurnedPct) > 0)) {
    labels.push({ text: '已锁池', tone: 'safe' });
  }
  if (isHoneypot === false) labels.push({ text: '非蜜罐', tone: 'safe' });
  if (isHoneypot === true) labels.push({ text: '蜜罐风险', tone: 'danger' });
  return labels.length > 0 ? labels : [{ text: '安全数据待确认', tone: 'neutral' }];
}

export function relativeAge(timestamp: number, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const elapsed = Math.max(0, Math.floor(nowSeconds - timestamp));
  if (elapsed < 60) return `${elapsed}s`;
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m`;
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h`;
  return `${Math.floor(elapsed / 86400)}d`;
}

function quoteLabel(token: Token): string {
  if (token.quoteAssetKey === 'NATIVE') return 'ETH';
  if (token.quoteAssetKey === 'OTHER') return token.pool.quoteTokenSymbol ?? 'OTHER';
  return token.quoteAssetKey;
}

interface StreamMessage<T> {
  channel: string;
  epoch: string;
  sequence: number;
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

function candleCacheKey(tokenAddress: string, interval: Interval): string {
  return `${tokenAddress.toLowerCase()}:${interval}`;
}

function tradeCacheKey(tokenAddress: string, marketKey: string): string {
  return `${tokenAddress.toLowerCase()}:${marketKey}`;
}

function isAzLoginUpstreamFailure(cause: unknown): cause is ApiError {
  return cause instanceof ApiError && cause.code === 'AZ_REQUEST_FAILED' && cause.status >= 500;
}

function privateAccountUrl(): string | null {
  // Only this user-approved deployment has a known private account entry point.
  const origin = new URL(window.location.origin);
  if (origin.protocol !== 'https:' || origin.hostname !== 'dopemac-mini.tailc44fad.ts.net' || origin.port !== '10000') return null;
  origin.port = '4173';
  return origin.href;
}

function transactionUrl(explorerBaseUrl: string, txHash: string): string | null {
  if (!explorerBaseUrl || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) return null;
  return `${explorerBaseUrl.replace(/\/+$/, '')}/tx/${txHash}`;
}

function addressUrl(explorerBaseUrl: string, address: string): string | null {
  if (!explorerBaseUrl || !/^0x[a-fA-F0-9]{40}$/.test(address)) return null;
  return `${explorerBaseUrl.replace(/\/+$/, '')}/address/${address}`;
}

function tradeValueUsd(trade: Trade): string {
  const notional = trade.notionalUsd;
  if (typeof notional !== 'string' || !/^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(notional.trim())) return '—';
  const value = Number(notional);
  return Number.isFinite(value) ? money(value) : '—';
}

function normalizedDecimal(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  const normalizedWhole = whole.replace(/^0+(?=\d)/, '') || '0';
  const normalizedFraction = fraction.replace(/0+$/, '');
  return normalizedFraction ? normalizedWhole + '.' + normalizedFraction : normalizedWhole;
}

function matchesQuoteRequest(quote: Quote, request: NonNullable<Parameters<typeof memeApi.createQuote>[0]>): boolean {
  return quote.tokenAddress.toLowerCase() === request.tokenAddress.toLowerCase()
    && quote.side === request.side
    && quote.settlementAsset === request.settlementAsset
    && normalizedDecimal(quote.amountIn) === normalizedDecimal(request.amountIn);
}

function upsertAccountTransaction(items: AccountTransaction[], next: AccountTransaction): AccountTransaction[] {
  return [next, ...items.filter((item) => item.executionId !== next.executionId)]
    .sort((left, right) => right.createdAt - left.createdAt);
}

function friendlyError(cause: unknown, fallback: string): string {
  if (cause instanceof SyntaxError) return `${fallback}：服务响应无效，请重试`;
  if (!(cause instanceof ApiError)) return cause instanceof Error ? cause.message : fallback;
  const messages: Record<string, string> = {
    MEME_UNAUTHORIZED: '登录已失效，请重新登录',
    MEME_GMGN_RATE_LIMITED: '行情请求较多，请稍后再试',
    MEME_MARKET_MISMATCH: '池子已更新，正在刷新行情',
    MEME_QUOTE_EXPIRED: '报价已过期，请使用最新报价',
    MEME_EXECUTION_DISABLED: '当前环境暂不开放交易',
    MEME_MAIN_ACCOUNT_BUSY: '上一笔交易仍在处理中',
    MEME_INSUFFICIENT_MAIN_ACCOUNT_BALANCE: '可用余额不足',
    MEME_INSUFFICIENT_MAIN_ACCOUNT_GAS: 'Gas 余额不足',
    MEME_UNSUPPORTED_POOL_TYPE: '当前池暂不支持交易',
  };
  return messages[cause.code] ?? `${fallback}：${cause.message}（HTTP ${cause.status}，${cause.code}）`;
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

export function mergeSnapshots(previous: CandleSnapshot | null, next: CandleSnapshot): CandleSnapshot {
  if (!previous
    || previous.tokenAddress.toLowerCase() !== next.tokenAddress.toLowerCase()
    || previous.marketKey !== next.marketKey
    || previous.interval !== next.interval) return next.gaps.length > 0 && next.availability === 'COMPLETE'
      ? { ...next, availability: 'PARTIAL' }
      : next;
  const byTime = new Map(previous.items.map((item) => [item.t, item]));
  for (const item of next.items) byTime.set(item.t, chooseNewerCandle(byTime.get(item.t), item));
  const limits = [previous.coverage, next.coverage];
  const from = limits.map((value) => value.from).filter((value): value is number => value !== null);
  const to = limits.map((value) => value.to).filter((value): value is number => value !== null);
  // A complete page does not prove that gaps in other pages have been repaired.
  const gaps = [...new Map([...previous.gaps, ...next.gaps]
    .map((gap) => [`${gap.from}:${gap.to}:${gap.reason}`, gap])).values()]
    .sort((a, b) => a.from - b.from || a.to - b.to || a.reason.localeCompare(b.reason));
  const availability = previous.availability === 'COMPLETE' && next.availability === 'COMPLETE' && gaps.length === 0
    ? 'COMPLETE'
    : previous.availability === 'UNAVAILABLE_BEFORE_START' && next.availability === 'UNAVAILABLE_BEFORE_START' && byTime.size === 0
      ? 'UNAVAILABLE_BEFORE_START'
      : 'PARTIAL';
  return { ...next,
    availability,
    gaps,
    revision: BigInt(previous.revision) > BigInt(next.revision) ? previous.revision : next.revision,
    asOfBlock: Math.max(previous.asOfBlock ?? 0, next.asOfBlock ?? 0) || null,
    coverage: { from: from.length ? Math.min(...from) : null, to: to.length ? Math.max(...to) : null },
    items: [...byTime.values()].sort((a, b) => a.t - b.t) };
}

function TokenMark({ token }: { token: Token }) {
  return <span className="token-mark" aria-hidden="true">{token.symbol.slice(0, 2)}</span>;
}

export default function App() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [selected, setSelected] = useState<Token | null>(null);
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [accountTransactions, setAccountTransactions] = useState<AccountTransaction[]>([]);
  const [snapshot, setSnapshot] = useState<CandleSnapshot | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [tradeNextCursor, setTradeNextCursor] = useState<string | null>(null);
  const [tradesLoading, setTradesLoading] = useState(false);
  const [tradesPaused, setTradesPaused] = useState(false);
  const [tradeFlashes, setTradeFlashes] = useState<{ key: string; deadlines: Map<string, number> } | null>(null);
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  const [interval, setIntervalValue] = useState<Interval>('1m');
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [asset, setAsset] = useState<Asset>('ETH');
  const [amount, setAmount] = useState('0.1');
  const [activePreset, setActivePreset] = useState<string | null>('0.1');
  const [quoteState, setQuoteState] = useState<{ value: Quote; request: Parameters<typeof memeApi.createQuote>[0] } | null>(null);
  const [orderState, setOrderState] = useState<string | null>(null);
  useEffect(() => {
    const delay = ({ '交易成功': 3000, '交易失败，资金已释放': 1200, '交易失败': 1800 } as Record<string, number>)[orderState ?? ''];
    if (delay === undefined) return;
    const timer = window.setTimeout(() => setOrderState(null), delay);
    return () => window.clearTimeout(timer);
  }, [orderState]);
  const [loading, setLoading] = useState(true);
  const [chartLoading, setChartLoading] = useState(false);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [marketRetry, setMarketRetry] = useState(0);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountOriginIssue, setAccountOriginIssue] = useState(false);
  const [accountRetry, setAccountRetry] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [chainName, setChainName] = useState('Robinhood Chain');
  const [explorerBaseUrl, setExplorerBaseUrl] = useState('');
  const [slippageBps, setSlippageBps] = useState(300);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<Token[] | null>(null);
  const [discoveryTab, setDiscoveryTab] = useState<'hot' | 'new'>('hot');
  const [marketRefreshMs, setMarketRefreshMs] = useState({ hot: 14_400_000, new: 300_000 });
  const [marketLoading, setMarketLoading] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [accountMode, setAccountMode] = useState<'AZ_ACCOUNT' | 'MAIN_ACCOUNT_POC' | null>(null);
  const [settlementAssets, setSettlementAssets] = useState<Asset[]>(['ETH', 'USDC', 'USDT']);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferDirection, setTransferDirection] = useState<'SPOT_TO_MEME' | 'MEME_TO_SPOT'>('SPOT_TO_MEME');
  const [transferAsset, setTransferAsset] = useState<Asset>('ETH');
  const [transferAmount, setTransferAmount] = useState('0.1');
  const [transferState, setTransferState] = useState<string | null>(null);
  const accountAvailable = sessionReady && account !== null && !accountError;
  const candleCacheRef = useRef(new Map<string, CandleSnapshot>());
  const tradeCacheRef = useRef(new Map<string, TradeCacheEntry>());
  const tradesPausedRef = useRef(false);
  const tradeMarketKeyRef = useRef(new Map<string, string>());
  const orderIdempotencyRef = useRef(new Map<string, string>());
  const orderPollsRef = useRef(new Map<string, { controller: AbortController; promise: Promise<void> }>());
  const mainAccountIdempotencyRef = useRef(new Map<string, string>());
  const transactionPollsRef = useRef(new Map<string, { controller: AbortController; promise: Promise<void> }>());
  const streamSocketRef = useRef<WebSocket | null>(null);
  const marketChannelsRef = useRef<string[]>([]);
  const selectionRequestRef = useRef(0);
  const candleHistoryScopeRef = useRef<{ key: string; loading?: boolean; exhausted?: boolean } | null>(null);
  const tradeHistoryScopeRef = useRef<{ key: string; loading?: boolean; exhausted?: boolean } | null>(null);
  const selectedTokenAddress = selected?.tokenAddress ?? null;
  const selectedTradeStatus = selected?.tradeStatus ?? null;
  const selectedMarketKey = selected ? 'USD:USDG' : null;
  const activeSnapshot = selected
    ? (snapshot?.tokenAddress.toLowerCase() === selected.tokenAddress.toLowerCase()
        && snapshot.marketKey === selectedMarketKey
        && snapshot.interval === interval
        ? snapshot
        : null)
    : null;
  const activeTradeKey = selected && selectedMarketKey
    ? tradeCacheKey(selected.tokenAddress, selectedMarketKey)
    : null;
  const hasTrades = trades.length > 0;
  const privateAccountHref = accountOriginIssue ? privateAccountUrl() : null;

  useEffect(() => { setTradeFlashes(null); }, [activeTradeKey, tradesPaused]);
  useEffect(() => {
    if (!tradeFlashes || tradeFlashes.key !== activeTradeKey || !tradeFlashes.deadlines.size) return;
    const timer = window.setTimeout(() => {
      setTradeFlashes((current) => {
        if (current !== tradeFlashes) return current;
        const deadlines = new Map([...current.deadlines].filter(([, until]) => until > Date.now()));
        return deadlines.size ? { ...current, deadlines } : null;
      });
    }, Math.max(0, Math.min(...tradeFlashes.deadlines.values()) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [activeTradeKey, tradeFlashes]);

  const setCachedSnapshot = useCallback((update: CandleSnapshot | null | ((current: CandleSnapshot | null) => CandleSnapshot | null)) => {
    setSnapshot((current) => {
      const next = typeof update === 'function' ? update(current) : update;
      if (next) {
        boundedMapSet(candleCacheRef.current, candleCacheKey(next.tokenAddress, next.interval), next, 64);
        boundedMapSet(tradeMarketKeyRef.current, next.tokenAddress.toLowerCase(), next.marketKey, 64);
      }
      return next;
    });
  }, []);

  const quoteRequest = useMemo(() => {
    if (!selectedTokenAddress || (selectedTradeStatus !== 'TRADABLE' && accountMode !== 'MAIN_ACCOUNT_POC')
      || !/^\d+(?:\.\d+)?$/.test(amount) || Number(amount) <= 0) return null;
    return {
      side,
      tokenAddress: selectedTokenAddress,
      settlementAsset: asset,
      amountIn: amount,
      slippageBps,
    } as const;
  }, [accountMode, amount, asset, selectedTokenAddress, selectedTradeStatus, side, slippageBps]);
  const quoteRequestRef = useRef(quoteRequest);
  quoteRequestRef.current = quoteRequest;
  const quoteVersionRef = useRef(0);
  const quote = quoteState?.request === quoteRequest ? quoteState.value : null;

  const trackOrder = useCallback(async (orderId: string) => {
    const existing = orderPollsRef.current.get(orderId);
    if (existing) return await existing.promise;
    const controller = new AbortController();
    const promise = pollOrderUntilTerminal(orderId, {
      signal: controller.signal,
      loadOrder: memeApi.getOrder,
      onUpdate: (latest) => {
        if (latest.status === 'SETTLED') {
          setOrderState('交易成功');
        } else if (latest.status === 'FAILED_FINAL' && latest.fundStatus === 'RELEASED') {
          setOrderState('交易失败，资金已释放');
        } else if (latest.status === 'MANUAL_REVIEW') {
          setOrderState('处理中，请联系客服');
        } else if (latest.status === 'SUBMISSION_UNKNOWN') {
          setOrderState('链上结果确认中');
        } else if (latest.status === 'FAILED_FINAL') {
          setOrderState('资金释放中');
        } else {
          setOrderState('处理中');
        }
      },
      onTemporaryError: () => setOrderState('状态同步中'),
    }).then(() => undefined).finally(() => orderPollsRef.current.delete(orderId));
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

  const trackMainAccountTransaction = useCallback(async (executionId: string) => {
    const existing = transactionPollsRef.current.get(executionId);
    if (existing) return await existing.promise;
    const controller = new AbortController();
    const promise = pollTransactionUntilTerminal(executionId, {
      signal: controller.signal,
      loadTransaction: memeApi.getAccountTransaction,
      onUpdate: (latest) => {
        setAccountTransactions((current) => upsertAccountTransaction(current, latest));
        if (latest.status === 'CONFIRMED') {
          setOrderState('交易成功');
          for (const [key, value] of mainAccountIdempotencyRef.current) {
            if (value === executionId) mainAccountIdempotencyRef.current.delete(key);
          }
          void refreshMainAccount().catch((cause: unknown) => {
            setAccountError(friendlyError(cause, '余额刷新失败'));
          });
        } else if (latest.status === 'FAILED') {
          setOrderState('交易失败');
          for (const [key, value] of mainAccountIdempotencyRef.current) {
            if (value === executionId) mainAccountIdempotencyRef.current.delete(key);
          }
        } else if (latest.status === 'SUBMISSION_UNKNOWN') {
          setOrderState('结果待确认');
        } else {
          setOrderState('处理中');
        }
      },
      onTemporaryError: () => setOrderState('状态同步中'),
    }).then(() => undefined).finally(() => transactionPollsRef.current.delete(executionId));
    transactionPollsRef.current.set(executionId, { controller, promise });
    return await promise;
  }, [refreshMainAccount]);

  useEffect(() => () => {
    for (const { controller } of orderPollsRef.current.values()) controller.abort();
    orderPollsRef.current.clear();
    for (const { controller } of transactionPollsRef.current.values()) controller.abort();
    transactionPollsRef.current.clear();
  }, []);

  const selectToken = useCallback(async (summary: Token) => {
    const requestId = ++selectionRequestRef.current;
    setError(null);
    setMarketError(null);
    tradesPausedRef.current = false;
    setTradesPaused(false);
    setSelected(summary);
    try {
      const detail = await memeApi.getToken(summary.tokenAddress);
      if (requestId !== selectionRequestRef.current) return;
      setTokens((current) => current.map((item) => item.tokenAddress === detail.tokenAddress ? detail : item));
      setSearchResults((current) => current?.map((item) => item.tokenAddress === detail.tokenAddress ? detail : item) ?? null);
      setSelected(detail);
    } catch (cause) {
      if (requestId === selectionRequestRef.current) {
        setMarketError(friendlyError(cause, '该代币行情暂不可用'));
      }
    }
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([memeApi.getConfig(), memeApi.getMarkets()])
      .then(([config, markets]) => {
        const first = markets.items[0];
        if (!active) return;
        setChainName(config.chainName);
        setExplorerBaseUrl(config.explorerBaseUrl);
        setSlippageBps(config.defaultSlippageBps);
        setMarketRefreshMs(config.marketRefreshMs ?? { hot: 14_400_000, new: 300_000 });
        const nextAccountMode = config.accountMode ?? 'AZ_ACCOUNT';
        const nextSettlementAssets = config.settlementAssets?.length
          ? config.settlementAssets
          : nextAccountMode === 'MAIN_ACCOUNT_POC'
            ? ['USDG', 'ETH'] as Asset[]
            : ['ETH', 'USDC', 'USDT'] as Asset[];
        setAccountMode(nextAccountMode);
        setSettlementAssets(nextSettlementAssets);
        if (nextAccountMode === 'MAIN_ACCOUNT_POC') {
          setAsset(nextSettlementAssets[0] ?? 'USDG');
          setAmount('1');
          setActivePreset(null);
        }
        setTokens(markets.items);
        setSelected(first ?? null);
        if (first) {
          void memeApi.getToken(first.tokenAddress)
            .then((detail) => {
              if (!active) return;
              setTokens((current) => current.map((item) => item.tokenAddress === detail.tokenAddress ? detail : item));
              setSelected((current) => current?.tokenAddress === detail.tokenAddress ? detail : current);
            })
            .catch((cause: unknown) => {
              if (active) setMarketError(friendlyError(cause, '代币信息暂不可用'));
            });
        }
      })
      .catch((cause: unknown) => active && setBootstrapError(friendlyError(cause, '加载失败')))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const result = await memeApi.getMarkets(discoveryTab);
        if (active) {
          setTokens(result.items);
          setSelected((current) => current ?? result.items[0] ?? null);
        }
      } catch (cause) {
        if (active) setError(friendlyError(cause, '市场刷新失败'));
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
  }, [discoveryTab, marketRefreshMs, tokens.length]);

  useEffect(() => {
    if (!activeTradeKey || !selectedTokenAddress || !selectedMarketKey) {
      setTrades([]);
      setTradeNextCursor(null);
      return;
    }
    let active = true;
    const scope = { key: activeTradeKey };
    tradeHistoryScopeRef.current = scope;
    const cached = tradeCacheRef.current.get(activeTradeKey);
    setTrades(cached?.items ?? []);
    setTradeNextCursor(cached?.nextCursor ?? null);
    setTradesLoading(true);
    void memeApi.getTrades(selectedTokenAddress)
      .then((page) => {
        if (!active) return;
        const current = tradeCacheRef.current.get(activeTradeKey);
        const existing = current?.items ?? [];
        const seen = new Set(page.items.map((trade) => trade.tradeId));
        const items = [...page.items, ...existing.filter((trade) => !seen.has(trade.tradeId))].slice(0, 5000);
        const nextCursor = current?.initialized && existing.length >= 100
          ? current.nextCursor
          : page.nextCursor;
        const entry = { items, nextCursor, initialized: true };
        boundedMapSet(tradeCacheRef.current, activeTradeKey, entry, 64);
        if (!tradesPausedRef.current) {
          setTrades(items);
          setTradeNextCursor(nextCursor);
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(friendlyError(cause, '成交加载失败'));
      })
      .finally(() => { if (active) setTradesLoading(false); });
    return () => {
      active = false;
      if (tradeHistoryScopeRef.current === scope) tradeHistoryScopeRef.current = null;
    };
  }, [activeTradeKey, selectedMarketKey, selectedTokenAddress]);

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
      return () => { active = false; };
    }
    setSearchResults(null);
    const timer = window.setTimeout(() => {
      setMarketLoading(true);
      void memeApi.searchMarkets(query)
        .then((result) => { if (active) setSearchResults(result.items); })
        .catch((cause: unknown) => { if (active) setError(friendlyError(cause, '搜索失败')); })
        .finally(() => { if (active) setMarketLoading(false); });
    }, 300);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [search]);

  useEffect(() => {
    if (!accountMode) return;
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
      setAccountError(friendlyError(cause, accountMode === 'MAIN_ACCOUNT_POC' ? '主账户连接失败' : '登录失败'));
      setAccountOriginIssue(accountMode === 'AZ_ACCOUNT' && isAzLoginUpstreamFailure(cause));
    };
    const timer = window.setTimeout(() => fail(new ApiError('MEME_ACCOUNT_TIMEOUT', '账户连接超时，请重试', 0)), 20_000);
    setSessionToken(null);
    setSessionReady(false);
    setAccount(null);
    setAccountTransactions([]);
    setAccountError(null);
    setAccountOriginIssue(false);
    const login = accountMode === 'MAIN_ACCOUNT_POC' ? Promise.resolve() : azAuth.loginMock(controller.signal).then(() => undefined);
    void login
      .then(async () => {
        if (!active) return;
        const [summary, transactions, orders] = await Promise.all([
          memeApi.getAccount(controller.signal)
            .catch((cause: unknown) => { throw new Error(friendlyError(cause, '账户余额加载失败')); }),
          accountMode === 'MAIN_ACCOUNT_POC'
            ? memeApi.getAccountTransactions(controller.signal)
                .catch((cause: unknown) => { throw new Error(friendlyError(cause, '交易记录加载失败')); })
            : Promise.resolve({ items: [] }),
          memeApi.getOrders(controller.signal)
            .catch((cause: unknown) => { throw new Error(friendlyError(cause, '订单状态恢复失败')); }),
        ]);
        if (!active) return;
        window.clearTimeout(timer);
        setAccount(summary);
        setAccountTransactions(transactions.items);
        setSessionReady(true);
        setAccountError(null);
        for (const transaction of transactions.items) {
          if (transaction.status === 'PENDING') {
            void trackMainAccountTransaction(transaction.executionId).catch((cause: unknown) => {
              if (active) setError(friendlyError(cause, '交易状态同步失败'));
            });
          }
        }
        for (const order of orders.items) {
          if (order.status !== 'SETTLED' && !(order.status === 'FAILED_FINAL' && order.fundStatus === 'RELEASED')) {
            void trackOrder(order.orderId).catch((cause: unknown) => {
              if (active) setError(friendlyError(cause, '订单状态恢复失败'));
            });
          }
        }
      }).catch(fail);
    return () => { active = false; window.clearTimeout(timer); controller.abort(); };
  }, [accountMode, accountRetry, trackMainAccountTransaction, trackOrder]);

  useEffect(() => {
    if (!sessionReady || accountMode !== 'MAIN_ACCOUNT_POC') return;
    const controller = new AbortController();
    let refreshing = false;
    const timer = window.setInterval(() => {
      if (refreshing) return;
      refreshing = true;
      void memeApi.getAccountTransactions(controller.signal)
        .then(({ items }) => { if (!controller.signal.aborted) setAccountTransactions(items); })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) { setSessionReady(false); setAccountError(friendlyError(cause, '交易记录刷新失败')); }
        })
        .finally(() => { refreshing = false; });
    }, 5_000);
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [accountMode, sessionReady, accountRetry]);

  useEffect(() => {
    if (!selectedTokenAddress || !selectedMarketKey) return;
    let active = true;
    const controller = new AbortController();
    let refreshTimer: number | undefined;
    let attempts = 0;
    const cacheKey = candleCacheKey(selectedTokenAddress, interval);
    const scope = { key: cacheKey };
    candleHistoryScopeRef.current = scope;
    const requestedMarketKey = selectedMarketKey;
    const cachedSnapshot = candleCacheRef.current.get(cacheKey) ?? null;
    const cached = cachedSnapshot?.marketKey === requestedMarketKey ? cachedSnapshot : null;
    setChartLoading(cached?.syncStatus !== 'READY');
    setMarketError(null);
    setSnapshot(cached);
    setOrderState(null);

    const refresh = () => {
      attempts += 1;
      void memeApi.getCandles(selectedTokenAddress, interval, { signal: controller.signal })
      .then((result) => {
        if (!active) return;
        const previous = candleCacheRef.current.get(cacheKey) ?? null;
        // An empty pending snapshot has no history/gaps to retain after demand completes.
        const merged = mergeSnapshots(previous?.items.length || previous?.gaps.length ? previous : null, result);
        setCachedSnapshot(merged);
        setChartLoading(false);
        if (result.syncStatus === 'STALE' || result.syncStatus === 'FAILED') {
          setMarketError('数据同步失败，后端未提供详细原因，请重试');
        } else if (result.syncStatus === 'BACKFILLING' || result.syncStatus === 'CATCHING_UP'
          || (result.items.length === 0 && result.availability === 'PARTIAL' && result.gaps.length === 0)) {
          if (attempts < 5) refreshTimer = window.setTimeout(refresh, 2_000 * 2 ** (attempts - 1));
          else if (merged.items.length === 0) setMarketError('历史 K 线仍未就绪，已停止自动刷新，请重试');
        } else {
          setMarketError(null);
        }
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setChartLoading(false);
        setMarketError(friendlyError(cause, '行情暂时不可用'));
      });
    };
    refresh();
    return () => {
      active = false;
      controller.abort();
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      if (candleHistoryScopeRef.current === scope) candleHistoryScopeRef.current = null;
    };
  }, [selectedTokenAddress, selectedMarketKey, interval, marketRetry, setCachedSnapshot]);

  useEffect(() => {
    if (!selectedTokenAddress || !activeSnapshot || activeSnapshot.syncStatus === 'STALE' || activeSnapshot.syncStatus === 'FAILED'
      || accountOriginIssue || typeof WebSocket === 'undefined') return;
    let socket: WebSocket | null = null;
    let disposed = false;
    let reconnectTimer: number | undefined;
    let reconnectAttempt = 0;
    let hasConnected = false;
    const streamState = new Map<string, { epoch: string; sequence: number }>();
    const candleChannel = `candle:${selectedTokenAddress.toLowerCase()}:${activeSnapshot.marketKey}:${interval}`;
    const tradeChannel = `trade:${selectedTokenAddress.toLowerCase()}:${activeSnapshot.marketKey}`;
    const currentTradeCacheKey = tradeCacheKey(selectedTokenAddress, activeSnapshot.marketKey);
    const marketChannel = `market:${selectedTokenAddress.toLowerCase()}`;
    const liveMarketChannel = 'markets:live';
    const channels = [candleChannel, tradeChannel, marketChannel, liveMarketChannel];
    marketChannelsRef.current = channels;
    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== undefined) return;
      const delay = Math.min(30_000, 1_000 * 2 ** reconnectAttempt);
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        void connect();
      }, delay);
    };

    const upsertCandle = (candle: Candle) => {
      setCachedSnapshot((current) => {
        if (!current || current.tokenAddress.toLowerCase() !== selectedTokenAddress.toLowerCase() || current.interval !== interval) return current;
        const byTime = new Map(current.items.map((item) => [item.t, item]));
        byTime.set(candle.t, chooseNewerCandle(byTime.get(candle.t), candle));
        return { ...current, items: [...byTime.values()].sort((a, b) => a.t - b.t) };
      });
      setMarketError((current) => current === '历史 K 线仍未就绪，已停止自动刷新，请重试' ? null : current);
    };

    const recoveryController = new AbortController();
    const recovery = new Map<string, { dirty: boolean; generation: number; flight: boolean; attempt: number; timer?: number }>();
    const recover = (channel: string, markDirty = true) => {
      const state = recovery.get(channel) ?? { dirty: false, generation: 0, flight: false, attempt: 0 };
      recovery.set(channel, state);
      if (markDirty) { state.dirty = true; state.generation += 1; }
      if (disposed || !state.dirty || state.flight || state.timer !== undefined) return;
      state.flight = true;
      const generation = state.generation;
      const signal = AbortSignal.any([recoveryController.signal, AbortSignal.timeout(10_000)]);
      const request = channel === candleChannel
        ? memeApi.getCandles(selectedTokenAddress, interval, { signal }).then((fresh) => {
          if (fresh.syncStatus === 'STALE') throw new Error('stale candle recovery snapshot');
          if (!disposed) setCachedSnapshot((current) => mergeSnapshots(current, fresh));
        })
        : memeApi.getTrades(selectedTokenAddress, undefined, signal).then((page) => {
          if (disposed) return;
          const current = tradeCacheRef.current.get(currentTradeCacheKey);
          const seen = new Set((current?.items ?? []).map((trade) => trade.tradeId));
          const items = [...(current?.items ?? []), ...page.items.filter((trade) => !seen.has(trade.tradeId))]
            .sort((left, right) => right.t - left.t).slice(0, 5000);
          boundedMapSet(tradeCacheRef.current, currentTradeCacheKey, { items, nextCursor: page.nextCursor, initialized: true }, 64);
          if (!tradesPausedRef.current) setTrades(items);
        });
      void request.then(() => {
        if (disposed) return;
        // A second gap during an in-flight read needs another read after it.
        if (state.generation === generation) state.dirty = false;
        state.attempt = 0;
      }).catch(() => {
        if (!disposed) setError(channel === candleChannel ? '行情更新中断，正在恢复' : '成交更新中断，正在恢复');
      }).finally(() => {
        state.flight = false;
        if (disposed || !state.dirty) return;
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(state.attempt++, 5));
        state.timer = window.setTimeout(() => { state.timer = undefined; recover(channel, false); }, delay);
      });
    };

    const connect = async () => {
      try {
        const { ticket } = await memeApi.getWsTicket();
        if (disposed) return;
        const nextSocket = new WebSocket(`${wsBaseUrl}?ticket=${encodeURIComponent(ticket)}`);
        socket = nextSocket;
        streamSocketRef.current = nextSocket;
        nextSocket.addEventListener('open', () => {
          if (disposed) { nextSocket.close(); return; }
          if (hasConnected) { recover(candleChannel); recover(tradeChannel); }
          hasConnected = true;
          reconnectAttempt = 0;
          nextSocket.send(JSON.stringify({
            op: 'subscribe',
            channels,
            ...(accountAvailable && quoteRequestRef.current ? { quote: quoteRequestRef.current } : {}),
          }));
        });
        nextSocket.addEventListener('message', (event) => {
          if (disposed) return;
          try {
            const message = JSON.parse(String(event.data)) as StreamMessage<Candle | CandleSnapshot | Trade | Quote | Token | HotMarketUpdate | StreamBatch<Candle> | StreamBatch<Trade>>;
            const previous = streamState.get(message.channel);
            const action = streamSequenceAction(previous, message);
            if (action === 'DUPLICATE') return;
            const requiresResync = action === 'RESYNC';
            streamState.set(message.channel, { epoch: message.epoch, sequence: message.sequence });

            if (message.channel === liveMarketChannel) {
              const updates = (message.data as HotMarketUpdate).items;
              const byAddress = new Map(updates.map((token) => [token.tokenAddress.toLowerCase(), token]));
              setTokens((current) => current.map((token) => byAddress.get(token.tokenAddress.toLowerCase()) ?? token));
              setSearchResults((current) => current?.map((token) => byAddress.get(token.tokenAddress.toLowerCase()) ?? token) ?? null);
              setSelected((current) => {
                if (!current) return current;
                const update = byAddress.get(current.tokenAddress.toLowerCase());
                return update ? { ...current, priceUsd: update.priceUsd, priceQuote: update.priceQuote, change24h: update.change24h } : current;
              });
              return;
            }
            if (message.channel === marketChannel) {
              const refreshedToken = message.data as Token;
              setSelected(refreshedToken);
              return;
            }
            if (message.channel.startsWith('quote:')) {
              const liveQuote = message.data as Quote;
              const expected = quoteRequestRef.current;
              if (accountAvailable && expected && matchesQuoteRequest(liveQuote, expected)) {
                quoteVersionRef.current += 1;
                setQuoteState({ value: liveQuote, request: expected });
              }
              return;
            }
            if (message.channel === candleChannel) {
              const candles = streamBatchItems(message.data as Candle | StreamBatch<Candle>);
              if (requiresResync) recover(candleChannel);
              candles.forEach(upsertCandle);
              return;
            }
            if (message.channel === tradeChannel) {
              const batch = streamBatchItems(message.data as Trade | StreamBatch<Trade>);
              const current = tradeCacheRef.current.get(currentTradeCacheKey)
                ?? { items: [], nextCursor: null, initialized: false };
              const incoming = [...batch].reverse();
              const incomingIds = new Set(incoming.map((trade) => trade.tradeId));
              const items = [...incoming, ...current.items.filter((trade) => !incomingIds.has(trade.tradeId))].slice(0, 5000);
              boundedMapSet(tradeCacheRef.current, currentTradeCacheKey, { ...current, items }, 64);
              if (!tradesPausedRef.current) {
                setTrades(items);
                const seen = new Set(current.items.map((trade) => trade.tradeId));
                const fresh = incoming.filter((trade) => !seen.has(trade.tradeId));
                if (!requiresResync && fresh.length && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
                  const until = Date.now() + 700;
                  setTradeFlashes((currentFlash) => {
                    const deadlines = new Map(currentFlash?.key === currentTradeCacheKey ? currentFlash.deadlines : []);
                    for (const trade of fresh) deadlines.set(trade.tradeId, until);
                    return { key: currentTradeCacheKey, deadlines };
                  });
                }
              }
              if (requiresResync) recover(tradeChannel);
            }
          } catch {
            setError('实时行情暂时不可用，正在重连');
            nextSocket.close();
          }
        });
        nextSocket.addEventListener('error', () => nextSocket.close());
        nextSocket.addEventListener('close', () => {
          if (streamSocketRef.current === nextSocket) streamSocketRef.current = null;
          scheduleReconnect();
        });
      } catch (cause) {
        if (!disposed) {
          if (accountMode === 'AZ_ACCOUNT' && isAzLoginUpstreamFailure(cause)) {
            setSessionToken(null);
            setSessionReady(false);
            setAccount(null);
            setAccountError(friendlyError(cause, '登录失败'));
            setAccountOriginIssue(true);
            return;
          }
          if (cause instanceof ApiError && (cause.status === 401 || cause.code === 'MEME_UNAUTHORIZED')) {
            setSessionToken(null);
            setSessionReady(false);
            setAccount(null);
            setQuoteState(null);
            setAccountError('登录已失效，请重新登录');
            return;
          }
          setError('实时行情暂时不可用，历史行情仍可查看');
          scheduleReconnect();
        }
      }
    };

    void connect();
    return () => {
      disposed = true;
      recoveryController.abort();
      for (const state of recovery.values()) if (state.timer !== undefined) window.clearTimeout(state.timer);
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (streamSocketRef.current === socket) streamSocketRef.current = null;
      socket?.close();
    };
  }, [accountAvailable, accountMode, accountOriginIssue, selectedTokenAddress, activeSnapshot?.marketKey, activeSnapshot?.syncStatus, interval, setCachedSnapshot]);

  useEffect(() => {
    const controller = new AbortController();
    const version = ++quoteVersionRef.current;
    setQuoteState(null);
    const socket = streamSocketRef.current;
    if (accountAvailable && quoteRequest) {
      void memeApi.createQuote(quoteRequest, controller.signal)
        .then((freshQuote) => {
          if (controller.signal.aborted || quoteRequestRef.current !== quoteRequest || quoteVersionRef.current !== version) return;
          if (!matchesQuoteRequest(freshQuote, quoteRequest)) throw new Error('报价与当前请求不匹配');
          setQuoteState({ value: freshQuote, request: quoteRequest });
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted && quoteRequestRef.current === quoteRequest && quoteVersionRef.current === version) {
            setError(friendlyError(cause, '报价暂时不可用'));
          }
        });
    }
    if (socket && socket.readyState === WebSocket.OPEN && selectedTokenAddress
      && marketChannelsRef.current.some((channel) => channel.includes(selectedTokenAddress))) {
      socket.send(JSON.stringify({
        op: 'subscribe',
        channels: marketChannelsRef.current,
        ...(accountAvailable && quoteRequest ? { quote: quoteRequest } : {}),
      }));
    }
    return () => controller.abort();
  }, [quoteRequest, selectedTokenAddress, accountAvailable]);

  const selectedPosition = account?.positions.find((item) => item.tokenAddress.toLowerCase() === selected?.tokenAddress.toLowerCase());
  const currentBalance = side === 'BUY'
    ? account?.quoteBalances.find((item) => item.asset === asset)?.available ?? '0'
    : selectedPosition?.available ?? '0';
  const displayedPrice = activeSnapshot?.items.at(-1)?.c ?? selected?.priceUsd ?? '0';
  const loadMoreTrades = useCallback((element: HTMLDivElement) => {
    if (tradesPausedRef.current) return;
    if (element.scrollHeight - element.scrollTop - element.clientHeight > 40) return;
    if (!activeTradeKey || !selectedTokenAddress || !selectedMarketKey || !tradeNextCursor || tradesLoading) return;
    const scope = tradeHistoryScopeRef.current;
    if (!scope || scope.key !== activeTradeKey) return;
    setTradesLoading(true);
    void memeApi.getTrades(selectedTokenAddress, tradeNextCursor)
      .then((page) => {
        if (tradeHistoryScopeRef.current !== scope) return;
        const current = tradeCacheRef.current.get(activeTradeKey)
          ?? { items: [], nextCursor: tradeNextCursor, initialized: true };
        const seen = new Set(current.items.map((trade) => trade.tradeId));
        const items = [...current.items, ...page.items.filter((trade) => !seen.has(trade.tradeId))].slice(0, 5000);
        const entry = { items, nextCursor: items.length >= 5000 ? null : page.nextCursor, initialized: true };
        boundedMapSet(tradeCacheRef.current, activeTradeKey, entry, 64);
        if (!tradesPausedRef.current) setTrades(items);
        setTradeNextCursor(entry.nextCursor);
      })
      .catch((cause: unknown) => {
        if (tradeHistoryScopeRef.current === scope) setError(friendlyError(cause, '更早成交加载失败'));
      })
      .finally(() => { if (tradeHistoryScopeRef.current === scope) setTradesLoading(false); });
  }, [activeTradeKey, selectedMarketKey, selectedTokenAddress, tradeNextCursor, tradesLoading]);
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
  const totalPosition = useMemo(() => account?.positions.reduce((sum, item) => sum + Number(item.valueUsd), 0) ?? 0, [account]);
  const balanceLabel = account?.quoteBalances
    .filter((item) => item.asset === 'ETH' || item.asset === 'USDC' || item.asset === 'USDT' || item.asset === 'USDG')
    .map((item) => `${readableAmount(item.available)} ${item.asset}`)
    .join(' / ') ?? '余额加载中';
  const visibleTokens = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return tokens;
    if (searchResults) return searchResults;
    return tokens.filter((token) => token.symbol.toLowerCase().includes(needle)
      || token.name.toLowerCase().includes(needle)
      || token.tokenAddress.toLowerCase().includes(needle));
  }, [search, searchResults, tokens]);

  const selectDiscoveryTab = useCallback(async (tab: 'hot' | 'new') => {
    if (tab === discoveryTab || marketLoading) return;
    setMarketLoading(true);
    setError(null);
    try {
      const result = await memeApi.getMarkets(tab);
      setTokens(result.items);
      setDiscoveryTab(tab);
      const candidate = result.items.find((item) => item.tokenAddress === selected?.tokenAddress) ?? result.items[0];
      if (candidate) await selectToken(candidate);
    } catch (cause) {
      setError(friendlyError(cause, '市场加载失败'));
    } finally {
      setMarketLoading(false);
    }
  }, [discoveryTab, marketLoading, selectToken, selected?.tokenAddress]);
  const tradePresets = useMemo(() => {
    if (side === 'BUY') {
      const values = accountMode === 'MAIN_ACCOUNT_POC'
        ? pocUsdgPresets
        : asset === 'ETH' ? ethPresets : stablePresets;
      return values.map((value) => ({ label: value, value }));
    }
    return [25, 50, 75, 100].map((percent) => ({
      label: `${percent}%`,
      value: percentageOf(currentBalance, percent),
    }));
  }, [accountMode, asset, currentBalance, side]);

  const resetTradeDraft = useCallback(() => {
    setOrderState(null);
  }, []);

  const selectSide = useCallback((nextSide: 'BUY' | 'SELL') => {
    setSide(nextSide);
    const nextBuyAmount = accountMode === 'MAIN_ACCOUNT_POC' ? '1' : asset === 'ETH' ? '0.1' : '100';
    setAmount(nextSide === 'BUY' ? nextBuyAmount : '0');
    setActivePreset(nextSide === 'BUY' ? nextBuyAmount : null);
    resetTradeDraft();
  }, [accountMode, asset, resetTradeDraft]);

  const loadOlderCandles = useCallback(async (before: number): Promise<HistoryLoadResult> => {
    if (!selected) return { added: 0, exhausted: false };
    const scope = candleHistoryScopeRef.current;
    if (!scope || scope.key !== candleCacheKey(selected.tokenAddress, interval) || scope.loading) return { added: 0, exhausted: false };
    if (scope.exhausted) return { added: 0, exhausted: true };
    const earliest = candleCacheRef.current.get(scope.key)?.items[0]?.t;
    if (!Number.isSafeInteger(before) || before < 0 || earliest === undefined || before >= earliest) return { added: 0, exhausted: false };
    scope.loading = true;
    try {
      const result = await memeApi.getCandles(selected.tokenAddress, interval, { to: before, limit: candlePageSize });
      if (candleHistoryScopeRef.current !== scope) return { added: 0, exhausted: false };
      if (result.tokenAddress.toLowerCase() !== selected.tokenAddress.toLowerCase() || result.interval !== interval
        || result.items.some((item) => item.t > before)) throw new Error('更早行情响应超出请求范围');
      const currentTimes = new Set(candleCacheRef.current.get(scope.key)?.items.map((item) => item.t));
      const added = new Set(result.items.filter((item) => item.t < earliest && !currentTimes.has(item.t)).map((item) => item.t)).size;
      // A completed bounded page with no earlier bars is exhausted for this scope.
      scope.exhausted = added === 0 && result.syncStatus === 'READY';
      setCachedSnapshot((current) => candleHistoryScopeRef.current === scope ? mergeSnapshots(current, result) : current);
      return { added, exhausted: scope.exhausted };
    } catch (cause) {
      if (candleHistoryScopeRef.current === scope) setError(friendlyError(cause, '更早行情加载失败'));
      if (candleHistoryScopeRef.current === scope) throw cause;
      return { added: 0, exhausted: false };
    } finally {
      scope.loading = false;
    }
  }, [interval, selected, setCachedSnapshot]);

  const submitOrder = useCallback(async () => {
    if (!accountAvailable) return;
    if (!quote) {
      setError('报价更新中，请稍后再试');
      return;
    }
    setError(null);
    setOrderState('提交中');
    try {
      if (accountMode === 'MAIN_ACCOUNT_POC') {
        if (!selected) throw new Error('请选择代币');
        const settlementAsset = asset === 'USDT' ? 'USDG' : asset;
        const requestKey = [
          side,
          selected.tokenAddress.toLowerCase(),
          settlementAsset,
          normalizedDecimal(quote.amountIn),
          slippageBps,
        ].join(':');
        let clientExecutionId = mainAccountIdempotencyRef.current.get(requestKey);
        if (!clientExecutionId) {
          clientExecutionId = crypto.randomUUID();
          mainAccountIdempotencyRef.current.set(requestKey, clientExecutionId);
        }
        const transaction = await memeApi.executeMainAccountTrade({
          clientExecutionId,
          side,
          tokenAddress: selected.tokenAddress,
          settlementAsset,
          amountIn: quote.amountIn,
          slippageBps,
        });
        setAccountTransactions((current) => upsertAccountTransaction(current, transaction));
        setOrderState('处理中');
        void trackMainAccountTransaction(transaction.executionId).catch((cause: unknown) => {
          setOrderState(null);
          setError(friendlyError(cause, '交易状态同步失败'));
        });
        return;
      }
      let clientOrderId = orderIdempotencyRef.current.get(quote.quoteId);
      if (!clientOrderId) {
        clientOrderId = crypto.randomUUID();
        orderIdempotencyRef.current.set(quote.quoteId, clientOrderId);
      }
      const order = await memeApi.createOrder({
        clientOrderId,
        quoteId: quote.quoteId,
        maxAmountIn: quote.amountIn,
        minAmountOut: quote.minAmountOut,
      });
      setOrderState('处理中');
      void trackOrder(order.orderId).catch((cause: unknown) => {
        setOrderState(null);
        setError(friendlyError(cause, '订单状态同步失败'));
      });
    } catch (cause) {
      setOrderState(null);
      setError(friendlyError(cause, '下单请求未完成'));
    }
  }, [accountAvailable, accountMode, asset, quote, selected, side, slippageBps, trackMainAccountTransaction, trackOrder]);

  const submitTransfer = useCallback(async () => {
    if (!accountAvailable) return;
    if (!/^\d+(?:\.\d+)?$/.test(transferAmount) || Number(transferAmount) <= 0) {
      setError('请输入有效的划转金额');
      return;
    }
    setTransferState('划转中');
    setError(null);
    try {
      const from = transferDirection === 'SPOT_TO_MEME' ? 'SPOT' : 'MEME';
      const to = from === 'SPOT' ? 'MEME' : 'SPOT';
      if (typeof crypto.randomUUID !== 'function') throw new Error('当前浏览器不支持安全划转编号');
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
      setError(friendlyError(cause, '划转失败'));
    }
  }, [accountAvailable, transferAmount, transferAsset, transferDirection]);

  if (loading) return <main className="full-state">正在加载</main>;
  if (bootstrapError) return <main className="full-state error-state">启动失败：{bootstrapError}</main>;

  const safety = selected ? securityLabels(selected) : [];

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-group">
          <div className="brand">AZ<span>X</span></div>
          <div className="product-name"><strong>Meme</strong><span>{chainName}</span></div>
        </div>
        <label className="search">
          <span className="sr-only">搜索代币名称或合约地址</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索代币或粘贴合约地址" />
        </label>
        {accountMode === 'MAIN_ACCOUNT_POC'
          ? <div className="balances">{accountError ? '账户不可用' : balanceLabel}</div>
          : <button type="button" className="balances" aria-label="打开账户划转" disabled={!accountAvailable} onClick={() => setTransferOpen(true)}>{accountError ? '账户不可用' : balanceLabel}</button>}
        <div className="mock-badge" data-state={accountError ? 'failed' : accountAvailable ? 'connected' : 'pending'}><i aria-hidden="true" />{accountError ? '账户连接失败' : accountMode === 'MAIN_ACCOUNT_POC' ? sessionReady ? '主账户已连接' : '主账户连接中' : sessionReady ? '已登录' : '登录中'}</div>
      </header>

      {accountError && <div className="notice" role="alert">账户请求失败：{accountError}
        {accountOriginIssue && <span>当前入口 {window.location.origin} 使用 AZ_ACCOUNT，AZ 登录上游不可用，请检查此入口的认证服务配置。
          {privateAccountHref && <a href={privateAccountHref} target="_blank" rel="noreferrer">打开主账户入口（Tailscale / 私网）</a>}
        </span>}
        <button type="button" onClick={() => setAccountRetry((n) => n + 1)}>重试账户连接</button></div>}
      {error && <div className="notice" role="alert">{error}<button type="button" onClick={() => setError(null)}>关闭</button></div>}

      <div className="workspace">
        <aside className="market-panel">
          <div className="panel-title">
            <strong>发现</strong>
            <div className="discovery-tabs">
              <button type="button" className={discoveryTab === 'hot' ? 'active' : ''} disabled={marketLoading} onClick={() => void selectDiscoveryTab('hot')}>热榜</button>
              <button type="button" className={discoveryTab === 'new' ? 'active' : ''} disabled={marketLoading} onClick={() => void selectDiscoveryTab('new')}>新币</button>
            </div>
          </div>
          <div className="token-head"><span>代币</span><span>市值</span><span>24h</span><span>持有</span><span /></div>
          <div className="token-list">
            {visibleTokens.length === 0 && <div className="empty">没有匹配的代币</div>}
            {visibleTokens.map((token) => (
              <div key={token.tokenAddress} className={selected?.tokenAddress === token.tokenAddress ? 'token-row selected' : 'token-row'}>
                <button type="button" className="token-select" aria-label={`查看 ${token.symbol}`} onClick={() => void selectToken(token)}>
                  <span className="row-token">
                    <TokenMark token={token} />
                    <span>
                      <b>{token.symbol}</b>
                      <small>
                        <em className={token.stage === 'GRADUATED' ? 'badge graduated' : 'badge curve'}>{stageLabel(token)}</em>
                        <em className="badge launchpad">{token.launchpad}</em>
                        <span>{age(token.ageSeconds)}</span>
                      </small>
                    </span>
                  </span>
                  <span>{money(token.marketCapUsd)}</span>
                  <TokenChange tokenAddress={token.tokenAddress} value={token.change24h} />
                  <span>{compact(token.holders)}</span>
                </button>
                <button type="button" className="quick-buy" aria-label={`买入 ${token.symbol}`} onClick={() => { void selectToken(token); selectSide('BUY'); }}>买</button>
              </div>
            ))}
          </div>
        </aside>

        <section className="chart-panel">
          {selected ? <>
            <div className="instrument">
              <div className="token-identity">
                <TokenMark token={selected} />
                <div>
                  <div className="token-title"><strong>{selected.symbol} / {quoteLabel(selected)}</strong><span className={selected.stage === 'GRADUATED' ? 'badge graduated' : 'badge curve'}>{stageLabel(selected)}</span><span className="badge launchpad">{selected.launchpad}</span><span className="badge pool">{poolLabel(selected.pool.poolType)}</span></div>
                  <small>{selected.name} / <CopyableAddress value={selected.tokenAddress} /></small>
                </div>
              </div>
              <div className="market-stats">
                <div><span>价格</span><strong data-testid="current-price">{money(displayedPrice)}</strong></div>
                <div><span>市值</span><strong>{money(selected.marketCapUsd)}</strong></div>
                <div><span>24h 量</span><strong>{money(selected.volume24hUsd)}</strong></div>
                <div><span>流动性</span><strong>{money(selected.pool.liquidityUsd)}</strong></div>
                <div><span>持有人</span><strong>{compact(selected.holders)}</strong></div>
              </div>
            </div>
            <div className="chart-toolbar">
              <div className="intervals" aria-label="K 线周期">
                {intervals.map((item) => <button type="button" className={interval === item ? 'active' : ''} key={item} onClick={() => setIntervalValue(item)}>{item}</button>)}
              </div>
              <span className={Number(selected.change24h) >= 0 ? 'positive' : 'negative'}>{formatPercent(selected.change24h)} / 24h</span>
            </div>
            {activeSnapshot
              ? <CandleChart key={`${selected.tokenAddress.toLowerCase()}:${activeSnapshot.marketKey}:${interval}`} candles={activeSnapshot.items} symbol={selected.symbol} refreshing={chartLoading} onLoadBefore={loadOlderCandles} />
              : <div className="chart-state">{marketError ? '行情加载失败' : '正在加载行情'}</div>}
            {marketError && <div className="market-retry"><span>{marketError}</span><button type="button" onClick={() => setMarketRetry((value) => value + 1)}>重试</button></div>}
            {activeSnapshot && activeSnapshot.syncStatus !== 'BACKFILLING' && activeSnapshot.syncStatus !== 'CATCHING_UP'
              && (activeSnapshot.syncStatus !== 'READY' || activeSnapshot.availability === 'PARTIAL') && <div className="chart-availability" role="status">
              {activeSnapshot.syncStatus === 'STALE' || activeSnapshot.syncStatus === 'FAILED'
                ? '数据同步失败，后端未提供详细原因'
                : `历史 K 线部分缺失：${activeSnapshot.gaps.length ? activeSnapshot.gaps.map((gap) => `${gap.reason === 'EVENT_EXPIRED' ? '成交已过保留期' : '早于扫描起点'} ${new Date(gap.from * 1000).toLocaleString()}–${new Date(gap.to * 1000).toLocaleString()}`).join('；') : '请求区间未完整覆盖，后端未提供缺口明细'}`}
            </div>}
            {activeSnapshot?.availability === 'UNAVAILABLE_BEFORE_START' && <div className="chart-availability" role="status">请求区间早于扫描起点，暂无可用 K 线</div>}
            <section className="trade-tape" aria-label="实时成交">
              <header>
                <strong>实时成交</strong>
                <div className="trade-actions">
                  <span className="trade-count">{trades.length > 0 ? `${trades.length} 笔` : '最新成交'}</span>
                  <button type="button" className={tradesPaused ? 'trade-pause active' : 'trade-pause'} onClick={toggleTradesPaused}>
                    {tradesPaused ? '继续' : '暂停'}
                  </button>
                </div>
              </header>
              <div className="trade-head"><span>方向 / 数量</span><span>成交价</span><span>Quote</span><span>Value</span><span>交易者</span><span>Tx</span><span>时间</span></div>
              <div className="trade-rows" onScroll={(event) => loadMoreTrades(event.currentTarget)}>
                {trades.length === 0 && <div className="trade-empty">{tradesLoading ? '正在加载成交' : '暂无成交'}</div>}
                {trades.map((trade) => {
                  const txUrl = transactionUrl(explorerBaseUrl, trade.txHash);
                  const traderUrl = addressUrl(explorerBaseUrl, trade.trader);
                  return (
                    <div className={tradeFlashes?.key === activeTradeKey && tradeFlashes.deadlines.has(trade.tradeId) ? 'trade-row trade-flash' : 'trade-row'} key={`${activeTradeKey}:${trade.tradeId}`}>
                      <span className={trade.side === 'BUY' ? 'positive' : 'negative'}>{trade.side === 'BUY' ? '买' : '卖'} {compact(trade.baseAmount)} {selected.symbol}</span>
                      <span data-testid="trade-price">{money(trade.priceUsd)}</span>
                      <span>{compact(trade.quoteAmount)} {trade.quoteAsset}</span>
                      <span data-testid="trade-value">{tradeValueUsd(trade)}</span>
                      <span className="trader-address">{traderUrl
                        ? <a className="trade-tx" href={traderUrl} target="_blank" rel="noreferrer" aria-label={`打开交易者地址 ${shortAddress(trade.trader)}`}>{shortAddress(trade.trader)} ↗</a>
                        : shortAddress(trade.trader)}<CopyableAddress value={trade.trader} iconOnly /></span>
                      <span>{txUrl
                        ? <a className="trade-tx" href={txUrl} target="_blank" rel="noreferrer" aria-label={`查看交易 ${shortAddress(trade.txHash)}`}>{shortAddress(trade.txHash)} ↗</a>
                        : shortAddress(trade.txHash)}</span>
                      <span>{relativeAge(trade.t, nowSeconds)}</span>
                    </div>
                  );
                })}
                {tradesLoading && trades.length > 0 && <div className="trade-more">正在加载</div>}
                {!tradesLoading && tradeNextCursor && <div className="trade-more">向下滚动加载更多</div>}
              </div>
            </section>
          </> : <div className="empty">请选择代币</div>}
        </section>

        <aside className="trade-panel">
          <div className="side-tabs">
            <button type="button" className={side === 'BUY' ? 'active buy' : ''} onClick={() => selectSide('BUY')}>买入</button>
            <button type="button" className={side === 'SELL' ? 'active sell' : ''} onClick={() => selectSide('SELL')}>卖出</button>
          </div>
          <div className="trade-form">
            <label><span>{side === 'BUY' ? '金额' : '数量'}</span><span>可用 {readableAmount(currentBalance)} {side === 'BUY' ? asset : selected?.symbol}</span></label>
            <div className="amount-input">
              <input
                aria-label={side === 'BUY' ? '买入金额' : '卖出数量'}
                value={amount}
                onChange={(event) => {
                  setAmount(event.target.value);
                  setActivePreset(null);
                  resetTradeDraft();
                }}
                inputMode="decimal"
              />
              {side === 'BUY'
                ? <select aria-label="支付资产" value={asset} onChange={(event) => {
                    const nextAsset = event.target.value as Asset;
                    setAsset(nextAsset);
                    const nextAmount = accountMode === 'MAIN_ACCOUNT_POC' ? '1' : nextAsset === 'ETH' ? '0.1' : '100';
                    setAmount(nextAmount);
                    setActivePreset(nextAmount);
                    resetTradeDraft();
                  }}>{settlementAssets.map((item) => <option key={item}>{item}</option>)}</select>
                : <span className="amount-unit">{selected?.symbol}</span>}
            </div>
            {side === 'SELL' && <label className="settlement"><span>结算资产</span><select aria-label="结算资产" value={asset} onChange={(event) => { setAsset(event.target.value as Asset); resetTradeDraft(); }}>{settlementAssets.map((item) => <option key={item}>{item}</option>)}</select></label>}
            <div className="presets">
              {tradePresets.map((preset) => <button
                type="button"
                className={activePreset === preset.label ? 'active' : ''}
                key={preset.label}
                onClick={() => {
                  setAmount(preset.value);
                  setActivePreset(preset.label);
                  resetTradeDraft();
                }}
              >{preset.label}</button>)}
            </div>
            <dl className="quote-details">
              <div><dt>预计得到</dt><dd>{quote ? `≈ ${readableAmount(quote.expectedAmountOut)} ${side === 'BUY' ? selected?.symbol : asset}` : '等待报价'}</dd></div>
              <div><dt>路由</dt><dd>{selected ? poolLabel(selected.pool.poolType) : '未选择'}</dd></div>
              <div><dt>滑点上限</dt><dd>{(slippageBps / 100).toFixed(slippageBps % 100 === 0 ? 0 : 2)}%</dd></div>
              <div className="security-row"><dt>安全</dt><dd>{safety.map((item) => <span className={`security-${item.tone}`} key={item.text}>{item.text}</span>)}</dd></div>
            </dl>
            <button type="button" className="primary" disabled={!accountAvailable || !selected || !quoteRequest || !quote || Boolean(orderState) || (side === 'SELL' && Number(currentBalance) <= 0)} onClick={submitOrder}>
              {accountError ? '账户连接失败' : !sessionReady ? accountMode === 'MAIN_ACCOUNT_POC' ? '等待主账户' : '等待登录' : orderState ?? (side === 'BUY' ? '买入' : '卖出')}
            </button>
          </div>

          <div className="positions">
            <div className="positions-head"><strong>我的持仓</strong><span className="positive">{money(totalPosition)}</span></div>
            {account?.positions.map((position) => {
              const cost = Number(position.costUsd);
              const pnl = cost > 0 ? `${((Number(position.valueUsd) / cost - 1) * 100).toFixed(0)}%` : '-';
              return <div className="position" key={position.tokenAddress}><span><b>{position.symbol}</b><small>{compact(position.available)} 枚</small></span><span className={cost > 0 && Number(position.valueUsd) >= cost ? 'positive' : 'negative'}>{pnl}</span><button type="button" onClick={() => { setSelected(tokens.find((token) => token.tokenAddress.toLowerCase() === position.tokenAddress.toLowerCase()) ?? null); selectSide('SELL'); }}>卖</button></div>;
            })}
            <div className="transaction-history">
              <div className="positions-head"><strong>交易记录</strong><span>{accountTransactions.length} 笔</span></div>
              {accountTransactions.length === 0
                ? <div className="transaction-empty">暂无交易</div>
                : accountTransactions.map((transaction) => <div className="account-transaction" key={transaction.executionId}>
                    <span>
                      <b className={transaction.side === 'BUY' ? 'positive' : 'negative'}>{transaction.side === 'BUY' ? '买入' : '卖出'} {transaction.tokenSymbol}</b>
                      <small>
                        {readableAmount(transaction.amountIn)} {transaction.side === 'BUY' ? transaction.settlementAsset : transaction.tokenSymbol}
                        {transaction.amountOut
                          ? ` → ${readableAmount(transaction.amountOut)} ${transaction.side === 'BUY' ? transaction.tokenSymbol : transaction.settlementAsset}`
                          : ''}
                      </small>
                    </span>
                    <span className={`transaction-status status-${transaction.status.toLowerCase()}`}>
                      {transaction.status === 'CONFIRMED'
                        ? '已完成'
                        : transaction.status === 'FAILED'
                          ? '失败'
                          : transaction.status === 'SUBMISSION_UNKNOWN'
                            ? '待确认'
                            : '处理中'}
                    </span>
                    <span className="transaction-links">{transaction.txHashes.map((hash, index) => {
                      const url = transactionUrl(explorerBaseUrl, hash);
                      return url ? <a href={url} target="_blank" rel="noreferrer" key={hash}>Tx{index + 1} ↗</a> : null;
                    })}</span>
                  </div>)}
            </div>
          </div>
        </aside>
      </div>

      {accountMode === 'AZ_ACCOUNT' && transferOpen && <div className="drawer-backdrop" role="presentation" onMouseDown={() => setTransferOpen(false)}>
        <section className="account-drawer" role="dialog" aria-modal="true" aria-labelledby="transfer-title" onMouseDown={(event) => event.stopPropagation()}>
          <header><div><strong id="transfer-title">Meme Account 划转</strong><span>仅站内记账，不触发链上交易</span></div><button type="button" aria-label="关闭划转" onClick={() => setTransferOpen(false)}>×</button></header>
          <label>方向<select aria-label="划转方向" value={transferDirection} onChange={(event) => { setTransferDirection(event.target.value as typeof transferDirection); setTransferState(null); }}><option value="SPOT_TO_MEME">Spot → Meme</option><option value="MEME_TO_SPOT">Meme → Spot</option></select></label>
          <label>资产<select aria-label="划转资产" value={transferAsset} onChange={(event) => { setTransferAsset(event.target.value as Asset); setTransferState(null); }}><option>ETH</option><option>USDC</option><option>USDT</option></select></label>
          <label>金额<input aria-label="划转金额" value={transferAmount} inputMode="decimal" onChange={(event) => { setTransferAmount(event.target.value); setTransferState(null); }} /></label>
          <button type="button" className="primary" disabled={!accountAvailable || Boolean(transferState?.startsWith('划转中'))} onClick={submitTransfer}>{transferState ?? '确认划转'}</button>
        </section>
      </div>}
    </main>
  );
}
