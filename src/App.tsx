import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, azAuth, azFundApi, memeApi, setSessionToken, wsBaseUrl } from './api';
import { CandleChart } from './CandleChart';
import type { AccountSummary, Asset, Candle, CandleSnapshot, Interval, Quote, Token, Trade } from './types';
import './styles.css';

const intervals: Interval[] = ['1s', '1m', '15m', '1h', '4h'];
const ethPresets = ['0.05', '0.1', '0.25', '0.5'];
const stablePresets = ['25', '100', '250', '500'];
const tradesPerPage = 6;

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

function age(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function shortAddress(value: string): string {
  return `${value.slice(0, 5)}...${value.slice(-4)}`;
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

function securityLabels(token: Token): string[] {
  const labels: string[] = [];
  if (token.security.buyTaxPct === '0' && token.security.sellTaxPct === '0') labels.push('无税');
  if (token.security.liquidityLocked === true) labels.push('锁池');
  if (token.security.isHoneypot === false) labels.push('非蜜罐');
  return labels.length > 0 ? labels : ['安全数据待确认'];
}

function quoteLabel(token: Token): string {
  return token.quoteAssetKey === 'NATIVE' ? 'ETH' : token.quoteAssetKey;
}

interface StreamMessage<T> {
  channel: string;
  epoch: string;
  sequence: number;
  data: T;
}

function candleCacheKey(tokenAddress: string, interval: Interval): string {
  return `${tokenAddress.toLowerCase()}:${interval}`;
}

function tradeCacheKey(tokenAddress: string, marketKey: string): string {
  return `${tokenAddress.toLowerCase()}:${marketKey}`;
}

function transactionUrl(explorerBaseUrl: string, txHash: string): string | null {
  if (!explorerBaseUrl || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) return null;
  return `${explorerBaseUrl.replace(/\/+$/, '')}/tx/${txHash}`;
}

function normalizedDecimal(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  const normalizedWhole = whole.replace(/^0+(?=\d)/, '') || '0';
  const normalizedFraction = fraction.replace(/0+$/, '');
  return normalizedFraction ? normalizedWhole + '.' + normalizedFraction : normalizedWhole;
}

function friendlyError(cause: unknown, fallback: string): string {
  if (!(cause instanceof ApiError)) return cause instanceof Error ? cause.message : fallback;
  const messages: Record<string, string> = {
    MEME_UNAUTHORIZED: '登录已失效，请重新登录',
    MEME_GMGN_RATE_LIMITED: '行情请求较多，请稍后再试',
    MEME_MARKET_MISMATCH: '池子已更新，正在刷新行情',
    MEME_QUOTE_EXPIRED: '报价已过期，请使用最新报价',
    MEME_EXECUTION_DISABLED: '当前环境暂不开放交易',
  };
  return messages[cause.code] ?? fallback;
}

function chooseNewerCandle(previous: Candle | undefined, next: Candle): Candle {
  if (!previous || next.revision >= previous.revision) return next;
  return previous;
}

function mergeSnapshots(previous: CandleSnapshot | null, next: CandleSnapshot): CandleSnapshot {
  if (!previous
    || previous.tokenAddress.toLowerCase() !== next.tokenAddress.toLowerCase()
    || previous.marketKey !== next.marketKey
    || previous.interval !== next.interval) return next;
  const byTime = new Map(previous.items.map((item) => [item.t, item]));
  for (const item of next.items) byTime.set(item.t, chooseNewerCandle(byTime.get(item.t), item));
  return { ...next, items: [...byTime.values()].sort((a, b) => a.t - b.t) };
}

function TokenMark({ token }: { token: Token }) {
  return <span className="token-mark" aria-hidden="true">{token.symbol.slice(0, 2)}</span>;
}

export default function App() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [selected, setSelected] = useState<Token | null>(null);
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [snapshot, setSnapshot] = useState<CandleSnapshot | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [tradePage, setTradePage] = useState(0);
  const [interval, setIntervalValue] = useState<Interval>('1m');
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [asset, setAsset] = useState<Asset>('ETH');
  const [amount, setAmount] = useState('0.1');
  const [activePreset, setActivePreset] = useState<string | null>('0.1');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [orderState, setOrderState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [chartLoading, setChartLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chainName, setChainName] = useState('Robinhood Chain');
  const [explorerBaseUrl, setExplorerBaseUrl] = useState('');
  const [slippageBps, setSlippageBps] = useState(300);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<Token[] | null>(null);
  const [discoveryTab, setDiscoveryTab] = useState<'hot' | 'new'>('hot');
  const [marketLoading, setMarketLoading] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferDirection, setTransferDirection] = useState<'SPOT_TO_MEME' | 'MEME_TO_SPOT'>('SPOT_TO_MEME');
  const [transferAsset, setTransferAsset] = useState<Asset>('ETH');
  const [transferAmount, setTransferAmount] = useState('0.1');
  const [transferState, setTransferState] = useState<string | null>(null);
  const candleCacheRef = useRef(new Map<string, CandleSnapshot>());
  const tradeCacheRef = useRef(new Map<string, Trade[]>());
  const tradeMarketKeyRef = useRef(new Map<string, string>());
  const orderIdempotencyRef = useRef(new Map<string, string>());
  const streamSocketRef = useRef<WebSocket | null>(null);
  const marketChannelsRef = useRef<string[]>([]);
  const activeSnapshot = selected
    ? (snapshot?.tokenAddress.toLowerCase() === selected.tokenAddress.toLowerCase() && snapshot.interval === interval
        ? snapshot
        : null)
    : null;
  const activeTradeKey = selected
    ? (() => {
        const tokenAddress = selected.tokenAddress.toLowerCase();
        const marketKey = activeSnapshot?.marketKey ?? tradeMarketKeyRef.current.get(tokenAddress);
        return marketKey ? tradeCacheKey(tokenAddress, marketKey) : null;
      })()
    : null;

  const setCachedSnapshot = useCallback((update: CandleSnapshot | null | ((current: CandleSnapshot | null) => CandleSnapshot | null)) => {
    setSnapshot((current) => {
      const next = typeof update === 'function' ? update(current) : update;
      if (next) {
        candleCacheRef.current.set(candleCacheKey(next.tokenAddress, next.interval), next);
        tradeMarketKeyRef.current.set(next.tokenAddress.toLowerCase(), next.marketKey);
      }
      return next;
    });
  }, []);

  const quoteRequest = useMemo(() => {
    if (!selected || !/^\d+(?:\.\d+)?$/.test(amount) || Number(amount) <= 0) return null;
    return {
      side,
      tokenAddress: selected.tokenAddress,
      settlementAsset: asset,
      amountIn: amount,
      slippageBps,
    } as const;
  }, [amount, asset, selected, side, slippageBps]);
  const quoteRequestRef = useRef(quoteRequest);
  quoteRequestRef.current = quoteRequest;

  const trackOrder = useCallback(async (orderId: string) => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const latest = await memeApi.getOrder(orderId);
      if (latest.status === 'SETTLED') {
        setOrderState('交易成功');
        window.setTimeout(() => setOrderState(null), 1200);
        return;
      }
      if (latest.status.startsWith('FAILED')) {
        setOrderState('交易失败');
        window.setTimeout(() => setOrderState(null), 1200);
        return;
      }
      setOrderState(latest.status === 'SUBMISSION_UNKNOWN' || latest.status === 'MANUAL_REVIEW' ? '确认中' : '处理中');
      await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 250));
    }
    setOrderState('确认中');
  }, []);

  const selectToken = useCallback(async (summary: Token) => {
    try {
      const detail = await memeApi.getToken(summary.tokenAddress);
      setTokens((current) => current.map((item) => item.tokenAddress === detail.tokenAddress ? detail : item));
      setSearchResults((current) => current?.map((item) => item.tokenAddress === detail.tokenAddress ? detail : item) ?? null);
      setSelected(detail);
    } catch (cause) {
      setError(friendlyError(cause, '代币详情加载失败'));
    }
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([memeApi.getConfig(), memeApi.getMarkets()])
      .then(async ([config, markets]) => {
        const first = markets.items[0];
        const selectedToken = first ? await memeApi.getToken(first.tokenAddress) : null;
        if (!active) return;
        setChainName(config.chainName);
        setExplorerBaseUrl(config.explorerBaseUrl);
        setSlippageBps(config.defaultSlippageBps);
        setTokens(markets.items.map((item) => item.tokenAddress === selectedToken?.tokenAddress ? selectedToken : item));
        setSelected(selectedToken);
      })
      .catch((cause: unknown) => active && setError(friendlyError(cause, '加载失败')))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    setTradePage(0);
    setTrades(activeTradeKey ? tradeCacheRef.current.get(activeTradeKey) ?? [] : []);
  }, [activeTradeKey]);

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
    let active = true;
    void azAuth.loginMock()
      .then(() => memeApi.getAccount())
      .then((summary) => {
        if (!active) return;
        setAccount(summary);
        setSessionReady(true);
        void memeApi.getOrders()
          .then(({ items }) => {
            if (!active) return;
            const pending = items.find((order) => !order.status.startsWith('FAILED') && order.status !== 'SETTLED');
            if (pending) void trackOrder(pending.orderId).catch((cause: unknown) => {
              if (active) setError(friendlyError(cause, '订单状态恢复失败'));
            });
          })
          .catch((cause: unknown) => {
            if (active) setError(friendlyError(cause, '订单状态恢复失败'));
          });
      })
      .catch((cause: unknown) => {
        setSessionToken(null);
        if (active) setError(friendlyError(cause, '登录失败'));
      });
    return () => { active = false; };
  }, [trackOrder]);

  useEffect(() => {
    if (!selected) return;
    let active = true;
    let pollTimer: number | undefined;
    let attempts = 0;
    const cacheKey = candleCacheKey(selected.tokenAddress, interval);
    const requestedMarketKey = selected.pool.poolKey + ':' + selected.quoteAssetKey;
    const cached = candleCacheRef.current.get(cacheKey) ?? null;
    setChartLoading(true);
    setSnapshot(cached ? { ...cached, status: 'CATCHING_UP' } : null);
    setQuote(null);
    setOrderState(null);

    const loadCandles = async () => {
      try {
        const result = await memeApi.getCandles(selected.tokenAddress, interval, { marketKey: requestedMarketKey });
        if (!active) return;
        const merged = mergeSnapshots(candleCacheRef.current.get(cacheKey) ?? null, result);
        setCachedSnapshot(merged);
        if (result.status === 'READY') {
          setChartLoading(false);
          return;
        }
        if (result.status === 'STALE') {
          setChartLoading(false);
          setError('历史 K 线回补失败，未启动实时扫描');
          return;
        }
        attempts += 1;
        if (attempts >= 40) throw new Error('K 线回补超时');
        pollTimer = window.setTimeout(() => void loadCandles(), 250);
      } catch (cause) {
        if (!active) return;
        setChartLoading(false);
        setError(friendlyError(cause, 'K 线加载失败'));
      }
    };
    void loadCandles();
    return () => {
      active = false;
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    };
  }, [selected, interval, setCachedSnapshot]);

  useEffect(() => {
    if (!selected || !activeSnapshot || activeSnapshot.status === 'STALE' || typeof WebSocket === 'undefined') return;
    let socket: WebSocket | null = null;
    let disposed = false;
    let reconnectTimer: number | undefined;
    let reconnectAttempt = 0;
    const streamState = new Map<string, { epoch: string; sequence: number }>();
    const candleChannel = `candle:${selected.tokenAddress}:${activeSnapshot.marketKey}:${interval}`;
    const tradeChannel = `trade:${selected.tokenAddress}:${activeSnapshot.marketKey}`;
    const currentTradeCacheKey = tradeCacheKey(selected.tokenAddress, activeSnapshot.marketKey);
    const marketChannel = `market:${selected.tokenAddress.toLowerCase()}`;
    const channels = [candleChannel, tradeChannel, marketChannel];
    marketChannelsRef.current = channels;
    const scheduleReconnect = () => {
      if (disposed) return;
      const delay = Math.min(30_000, 1_000 * 2 ** reconnectAttempt);
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(() => void connect(), delay);
    };

    const upsertCandle = (candle: Candle) => {
      setCachedSnapshot((current) => {
        if (!current || current.tokenAddress.toLowerCase() !== selected.tokenAddress.toLowerCase() || current.interval !== interval) return current;
        const byTime = new Map(current.items.map((item) => [item.t, item]));
        byTime.set(candle.t, chooseNewerCandle(byTime.get(candle.t), candle));
        return { ...current, items: [...byTime.values()].sort((a, b) => a.t - b.t) };
      });
    };

    const connect = async () => {
      try {
        const { ticket } = await memeApi.getWsTicket();
        if (disposed) return;
        socket = new WebSocket(`${wsBaseUrl}?ticket=${encodeURIComponent(ticket)}`);
        streamSocketRef.current = socket;
        socket.addEventListener('open', () => {
          reconnectAttempt = 0;
          socket?.send(JSON.stringify({
            op: 'subscribe',
            channels,
            ...(sessionReady && quoteRequestRef.current ? { quote: quoteRequestRef.current } : {}),
          }));
        });
        socket.addEventListener('message', (event) => {
          try {
            const message = JSON.parse(String(event.data)) as StreamMessage<Candle | Trade | Quote | Token>;
            const previous = streamState.get(message.channel);
            const duplicate = previous !== undefined
              && message.epoch === previous.epoch
              && message.sequence <= previous.sequence;
            if (duplicate) return;
            const requiresResync = previous !== undefined
              && (message.epoch !== previous.epoch || message.sequence > previous.sequence + 1);
            streamState.set(message.channel, { epoch: message.epoch, sequence: message.sequence });

            if (message.channel === marketChannel) {
              const refreshedToken = message.data as Token;
              const tokenPrefix = `${selected.tokenAddress.toLowerCase()}:`;
              for (const key of candleCacheRef.current.keys()) {
                if (key.startsWith(tokenPrefix)) candleCacheRef.current.delete(key);
              }
              tradeMarketKeyRef.current.delete(selected.tokenAddress.toLowerCase());
              setSnapshot(null);
              setSelected(refreshedToken);
              return;
            }
            if (message.channel.startsWith('quote:')) {
              const liveQuote = message.data as Quote;
              const expected = quoteRequestRef.current;
              if (expected
                && liveQuote.tokenAddress.toLowerCase() === expected.tokenAddress.toLowerCase()
                && liveQuote.side === expected.side
                && liveQuote.settlementAsset === expected.settlementAsset
                && normalizedDecimal(liveQuote.amountIn) === normalizedDecimal(expected.amountIn)) {
                setQuote(liveQuote);
              }
              return;
            }
            if (message.channel === candleChannel) {
              const candle = message.data as Candle;
              if (requiresResync) {
                void memeApi.getCandles(selected.tokenAddress, interval, { marketKey: activeSnapshot.marketKey })
                  .then((fresh) => {
                    if (!disposed) {
                      setCachedSnapshot((current) => mergeSnapshots(current, fresh));
                      upsertCandle(candle);
                    }
                  })
                  .catch(() => setError('行情更新中断，正在恢复'));
                return;
              }
              upsertCandle(candle);
              return;
            }
            if (message.channel === tradeChannel) {
              const trade = message.data as Trade;
              const current = tradeCacheRef.current.get(currentTradeCacheKey) ?? [];
              const next = [trade, ...current.filter((item) => item.tradeId !== trade.tradeId)];
              tradeCacheRef.current.set(currentTradeCacheKey, next);
              setTrades(next);
            }
          } catch {
            setError('实时行情暂时不可用，正在重连');
            socket?.close();
          }
        });
        socket.addEventListener('close', () => {
          scheduleReconnect();
        });
      } catch {
        if (!disposed) {
          setError('实时行情暂时不可用，历史行情仍可查看');
          scheduleReconnect();
        }
      }
    };

    void connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (streamSocketRef.current === socket) streamSocketRef.current = null;
      socket?.close();
    };
  }, [sessionReady, selected, activeSnapshot?.marketKey, interval, setCachedSnapshot]);

  useEffect(() => {
    setQuote(null);
    const socket = streamSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !selected) return;
    if (!marketChannelsRef.current.some((channel) => channel.includes(selected.tokenAddress))) return;
    socket.send(JSON.stringify({
      op: 'subscribe',
      channels: marketChannelsRef.current,
      ...(sessionReady && quoteRequest ? { quote: quoteRequest } : {}),
    }));
  }, [quoteRequest, selected, sessionReady]);

  const selectedPosition = account?.positions.find((item) => item.tokenAddress.toLowerCase() === selected?.tokenAddress.toLowerCase());
  const currentBalance = side === 'BUY'
    ? account?.quoteBalances.find((item) => item.asset === asset)?.available ?? '0'
    : selectedPosition?.available ?? '0';
  const displayedPrice = activeSnapshot?.items.at(-1)?.c ?? selected?.priceUsd ?? '0';
  const tradePageCount = Math.max(1, Math.ceil(trades.length / tradesPerPage));
  const visibleTrades = trades.slice(tradePage * tradesPerPage, (tradePage + 1) * tradesPerPage);
  const totalPosition = useMemo(() => account?.positions.reduce((sum, item) => sum + Number(item.valueUsd), 0) ?? 0, [account]);
  const balanceLabel = account?.quoteBalances
    .filter((item) => item.asset === 'ETH' || item.asset === 'USDC' || item.asset === 'USDT')
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
      const values = asset === 'ETH' ? ethPresets : stablePresets;
      return values.map((value) => ({ label: value, value }));
    }
    return [25, 50, 75, 100].map((percent) => ({
      label: `${percent}%`,
      value: percentageOf(currentBalance, percent),
    }));
  }, [asset, currentBalance, side]);

  const resetTradeDraft = useCallback(() => {
    setQuote(null);
    setOrderState(null);
  }, []);

  const selectSide = useCallback((nextSide: 'BUY' | 'SELL') => {
    setSide(nextSide);
    setAmount(nextSide === 'BUY' ? (asset === 'ETH' ? '0.1' : '100') : '0');
    setActivePreset(nextSide === 'BUY' ? (asset === 'ETH' ? '0.1' : '100') : null);
    resetTradeDraft();
  }, [asset, resetTradeDraft]);

  const loadOlderCandles = useCallback(async (before: number): Promise<number> => {
    if (!selected) return 0;
    try {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const marketKey = snapshot?.tokenAddress.toLowerCase() === selected.tokenAddress.toLowerCase()
          && snapshot.interval === interval
          ? snapshot.marketKey
          : selected.pool.poolKey + ':' + selected.quoteAssetKey;
        const result = await memeApi.getCandles(selected.tokenAddress, interval, { to: before, limit: 120, marketKey });
        if (result.status === 'STALE') throw new Error('更早行情加载失败');
        if (result.status === 'READY') {
          setCachedSnapshot((current) => {
            if (!current
              || current.tokenAddress.toLowerCase() !== result.tokenAddress.toLowerCase()
              || current.marketKey !== result.marketKey
              || current.interval !== result.interval) return current;
            const byTime = new Map(current.items.map((item) => [item.t, item]));
            for (const item of result.items) byTime.set(item.t, chooseNewerCandle(byTime.get(item.t), item));
            return { ...current, items: [...byTime.values()].sort((a, b) => a.t - b.t) };
          });
          return result.items.length;
        }
        await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 250));
      }
      throw new Error('更早行情加载超时');
    } catch (cause) {
      setError(friendlyError(cause, '更早行情加载失败'));
      return 0;
    }
  }, [interval, selected, setCachedSnapshot, snapshot]);

  const submitOrder = useCallback(async () => {
    if (!quote) {
      setError('报价更新中，请稍后再试');
      return;
    }
    setError(null);
    setOrderState('提交中');
    try {
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
      await trackOrder(order.orderId);
    } catch (cause) {
      setOrderState(null);
      setError(friendlyError(cause, '下单失败'));
    }
  }, [quote, trackOrder]);

  const submitTransfer = useCallback(async () => {
    if (!sessionReady) return;
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
  }, [sessionReady, transferAmount, transferAsset, transferDirection]);

  if (loading) return <main className="full-state">正在加载</main>;
  if (error && tokens.length === 0) return <main className="full-state error-state">启动失败：{error}</main>;

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
        <button type="button" className="balances" aria-label="打开账户划转" disabled={!sessionReady} onClick={() => setTransferOpen(true)}>{balanceLabel}</button>
        <div className="mock-badge"><i aria-hidden="true" />{sessionReady ? '已登录' : '登录中'}</div>
      </header>

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
          <div className="token-head"><span>代币</span><span>市值</span><span>5m</span><span>持有</span><span /></div>
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
                  <span className={Number(token.change5m) >= 0 ? 'positive' : 'negative'}>{Number(token.change5m) > 0 ? '+' : ''}{token.change5m}%</span>
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
                  <small>{selected.name} / {shortAddress(selected.tokenAddress)}</small>
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
              <span className={Number(selected.change5m) >= 0 ? 'positive' : 'negative'}>{Number(selected.change5m) > 0 ? '+' : ''}{selected.change5m}% / 5m</span>
            </div>
            {activeSnapshot?.status === 'READY'
              ? <CandleChart key={`${selected.tokenAddress}:${activeSnapshot.marketKey}:${interval}`} candles={activeSnapshot.items} symbol={selected.symbol} refreshing={chartLoading} onLoadBefore={loadOlderCandles} />
              : <div className="chart-state">正在加载行情</div>}
            <section className="trade-tape" aria-label="实时成交">
              <header>
                <strong>实时成交</strong>
                <div className="trade-pagination">
                  <span>{trades.length > 0 ? `${trades.length} 笔 · ${tradePage + 1}/${tradePageCount}` : '最新成交'}</span>
                  <button type="button" aria-label="上一页成交" disabled={tradePage === 0} onClick={() => setTradePage((page) => Math.max(0, page - 1))}>‹</button>
                  <button type="button" aria-label="下一页成交" disabled={tradePage + 1 >= tradePageCount} onClick={() => setTradePage((page) => Math.min(tradePageCount - 1, page + 1))}>›</button>
                </div>
              </header>
              <div className="trade-head"><span>方向 / 数量</span><span>成交价</span><span>交易者</span><span>Tx</span><span>时间</span></div>
              <div className="trade-rows">
                {trades.length === 0 && <div className="trade-empty">等待最新成交</div>}
                {visibleTrades.map((trade) => {
                  const txUrl = transactionUrl(explorerBaseUrl, trade.txHash);
                  return (
                    <div className="trade-row" key={trade.tradeId}>
                      <span className={trade.side === 'BUY' ? 'positive' : 'negative'}>{trade.side === 'BUY' ? '买' : '卖'} {compact(trade.baseAmount)} {selected.symbol}</span>
                      <span data-testid="trade-price">{money(trade.priceUsd)}</span>
                      <span>{shortAddress(trade.trader)}</span>
                      <span>{txUrl
                        ? <a className="trade-tx" href={txUrl} target="_blank" rel="noreferrer" aria-label={`查看交易 ${shortAddress(trade.txHash)}`}>{shortAddress(trade.txHash)} ↗</a>
                        : shortAddress(trade.txHash)}</span>
                      <span>{new Date(trade.t * 1000).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                    </div>
                  );
                })}
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
                    const nextAmount = nextAsset === 'ETH' ? '0.1' : '100';
                    setAmount(nextAmount);
                    setActivePreset(nextAmount);
                    resetTradeDraft();
                  }}><option>ETH</option><option>USDC</option><option>USDT</option></select>
                : <span className="amount-unit">{selected?.symbol}</span>}
            </div>
            {side === 'SELL' && <label className="settlement"><span>结算资产</span><select aria-label="结算资产" value={asset} onChange={(event) => { setAsset(event.target.value as Asset); resetTradeDraft(); }}><option>ETH</option><option>USDC</option><option>USDT</option></select></label>}
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
              <div className="security-row"><dt>安全</dt><dd>{safety.map((item) => <span key={item}>{item}</span>)}</dd></div>
            </dl>
            <button type="button" className="primary" disabled={!sessionReady || !selected || !quoteRequest || !quote || Boolean(orderState) || (side === 'SELL' && Number(currentBalance) <= 0)} onClick={submitOrder}>
              {!sessionReady ? '等待登录' : orderState ?? (side === 'BUY' ? '买入' : '卖出')}
            </button>
            <p>下单无需再次签名</p>
          </div>

          {selected && <section className="token-about">
            <header><strong>关于 {selected.symbol}</strong><span>{shortAddress(selected.tokenAddress)}</span></header>
            <div className="about-badges"><span className={selected.stage === 'GRADUATED' ? 'badge graduated' : 'badge curve'}>{stageLabel(selected)}</span><span className="badge launchpad">来自 {selected.launchpad}</span><span className="badge pool">{poolLabel(selected.pool.poolType)}</span></div>
            <dl>
              <div><dt>流动性</dt><dd>{money(selected.pool.liquidityUsd)}</dd></div>
              <div><dt>5m 涨跌</dt><dd className={Number(selected.change5m) >= 0 ? 'positive' : 'negative'}>{Number(selected.change5m) > 0 ? '+' : ''}{selected.change5m}%</dd></div>
              <div><dt>交易状态</dt><dd>{selected.tradeStatus === 'TRADABLE' ? '可交易' : '暂不支持'}</dd></div>
            </dl>
          </section>}

          <div className="positions">
            <div className="positions-head"><strong>我的持仓</strong><span className="positive">{money(totalPosition)}</span></div>
            {account?.positions.map((position) => {
              const cost = Number(position.costUsd);
              const pnl = cost > 0 ? `${((Number(position.valueUsd) / cost - 1) * 100).toFixed(0)}%` : '—';
              return <div className="position" key={position.tokenAddress}><span><b>{position.symbol}</b><small>{compact(position.available)} 枚</small></span><span className={cost > 0 && Number(position.valueUsd) >= cost ? 'positive' : 'negative'}>{pnl}</span><button type="button" onClick={() => { setSelected(tokens.find((token) => token.tokenAddress.toLowerCase() === position.tokenAddress.toLowerCase()) ?? null); selectSide('SELL'); }}>卖</button></div>;
            })}
          </div>
        </aside>
      </div>

      {transferOpen && <div className="drawer-backdrop" role="presentation" onMouseDown={() => setTransferOpen(false)}>
        <section className="account-drawer" role="dialog" aria-modal="true" aria-labelledby="transfer-title" onMouseDown={(event) => event.stopPropagation()}>
          <header><div><strong id="transfer-title">Meme Account 划转</strong><span>仅站内记账，不触发链上交易</span></div><button type="button" aria-label="关闭划转" onClick={() => setTransferOpen(false)}>×</button></header>
          <label>方向<select aria-label="划转方向" value={transferDirection} onChange={(event) => { setTransferDirection(event.target.value as typeof transferDirection); setTransferState(null); }}><option value="SPOT_TO_MEME">Spot → Meme</option><option value="MEME_TO_SPOT">Meme → Spot</option></select></label>
          <label>资产<select aria-label="划转资产" value={transferAsset} onChange={(event) => { setTransferAsset(event.target.value as Asset); setTransferState(null); }}><option>ETH</option><option>USDC</option><option>USDT</option></select></label>
          <label>金额<input aria-label="划转金额" value={transferAmount} inputMode="decimal" onChange={(event) => { setTransferAmount(event.target.value); setTransferState(null); }} /></label>
          <button type="button" className="primary" disabled={Boolean(transferState?.startsWith('划转中'))} onClick={submitTransfer}>{transferState ?? '确认划转'}</button>
        </section>
      </div>}
    </main>
  );
}
