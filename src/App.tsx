import { useCallback, useEffect, useMemo, useState } from 'react';
import { azAuth, azFundApi, memeApi, setSessionToken, wsBaseUrl } from './api';
import { CandleChart } from './CandleChart';
import type { AccountSummary, Asset, Candle, CandleSnapshot, Interval, Quote, Token } from './types';
import './styles.css';

const intervals: Interval[] = ['1s', '1m', '15m', '1h', '4h'];
const presets = ['0.05', '0.1', '0.25', '0.5'];

function compact(value: string | number): string {
  return Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value));
}

function age(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
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

export default function App() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [selected, setSelected] = useState<Token | null>(null);
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [snapshot, setSnapshot] = useState<CandleSnapshot | null>(null);
  const [interval, setIntervalValue] = useState<Interval>('1m');
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [asset, setAsset] = useState<Asset>('ETH');
  const [amount, setAmount] = useState('0.1');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [orderState, setOrderState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [chartLoading, setChartLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chainName, setChainName] = useState('Robinhood Chain');
  const [search, setSearch] = useState('');
  const [sessionReady, setSessionReady] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferDirection, setTransferDirection] = useState<'SPOT_TO_MEME' | 'MEME_TO_SPOT'>('SPOT_TO_MEME');
  const [transferAsset, setTransferAsset] = useState<Asset>('ETH');
  const [transferAmount, setTransferAmount] = useState('0.1');
  const [transferState, setTransferState] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([memeApi.getConfig(), memeApi.getMarkets()])
      .then(([config, markets]) => {
        if (!active) return;
        setChainName(config.chainName);
        setTokens(markets.items);
        setSelected(markets.items[0] ?? null);
      })
      .catch((cause: unknown) => active && setError(cause instanceof Error ? cause.message : '加载失败'))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void azAuth.loginMock()
      .then(() => memeApi.getAccount())
      .then((summary) => {
        if (!active) return;
        setAccount(summary);
        setSessionReady(true);
      })
      .catch((cause: unknown) => {
        setSessionToken(null);
        if (active) setError(cause instanceof Error ? cause.message : 'AZ Mock 登录失败');
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!selected) return;
    let active = true;
    let pollTimer: number | undefined;
    let attempts = 0;
    setChartLoading(true);
    setSnapshot(null);
    setQuote(null);
    setOrderState(null);

    const loadCandles = async () => {
      try {
        const result = await memeApi.getCandles(selected.tokenAddress, interval);
        if (!active) return;
        setSnapshot(result);
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
        pollTimer = window.setTimeout(() => void loadCandles(), 75);
      } catch (cause) {
        if (!active) return;
        setChartLoading(false);
        setError(cause instanceof Error ? cause.message : 'K 线加载失败');
      }
    };
    void loadCandles();
    return () => {
      active = false;
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    };
  }, [selected, interval]);

  useEffect(() => {
    if (!sessionReady || !selected || !snapshot || snapshot.status !== 'READY' || typeof WebSocket === 'undefined') return;
    let socket: WebSocket | null = null;
    let disposed = false;
    let reconnectTimer: number | undefined;
    let lastEpoch: string | null = null;
    let lastSequence = 0;

    const upsert = (candle: Candle) => {
      setSnapshot((current) => {
        if (!current) return current;
        const byTime = new Map(current.items.map((item) => [item.t, item]));
        byTime.set(candle.t, candle);
        return { ...current, items: [...byTime.values()].sort((a, b) => a.t - b.t).slice(-300) };
      });
    };

    const connect = async () => {
      try {
        const { ticket } = await memeApi.getWsTicket();
        if (disposed) return;
        socket = new WebSocket(`${wsBaseUrl}?ticket=${encodeURIComponent(ticket)}`);
        socket.addEventListener('open', () => socket?.send(JSON.stringify({
          op: 'subscribe',
          channels: [`candle:${selected.tokenAddress}:${snapshot.marketKey}:${interval}`],
        })));
        socket.addEventListener('message', (event) => {
          try {
            const message = JSON.parse(String(event.data)) as { epoch: string; sequence: number; data: Candle };
            const requiresResync = (lastEpoch !== null && message.epoch !== lastEpoch)
              || (lastSequence > 0 && message.sequence !== lastSequence + 1);
            lastEpoch = message.epoch;
            lastSequence = message.sequence;
            if (requiresResync) {
              void memeApi.getCandles(selected.tokenAddress, interval)
                .then((fresh) => { if (!disposed) { setSnapshot(fresh); upsert(message.data); } })
                .catch(() => setError('实时序列断档，K 线快照恢复失败'));
              return;
            }
            upsert(message.data);
          } catch {
            setError('实时行情消息格式错误，正在重连');
            socket?.close();
          }
        });
        socket.addEventListener('close', () => {
          if (!disposed) reconnectTimer = window.setTimeout(() => void connect(), 1000);
        });
      } catch {
        if (!disposed) {
          setError('实时行情连接失败，历史 K 线仍可用');
          reconnectTimer = window.setTimeout(() => void connect(), 1000);
        }
      }
    };

    void connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [sessionReady, selected, snapshot?.marketKey, snapshot?.status, interval]);

  const selectedPosition = account?.positions.find((item) => item.tokenAddress === selected?.tokenAddress);
  const currentBalance = side === 'BUY'
    ? account?.quoteBalances.find((item) => item.asset === asset)?.available ?? '0'
    : selectedPosition?.available ?? '0';
  const displayedPrice = snapshot?.items.at(-1)?.c ?? selected?.priceUsd ?? '0';
  const totalPosition = useMemo(() => account?.positions.reduce((sum, item) => sum + Number(item.valueUsd), 0) ?? 0, [account]);
  const balanceLabel = account?.quoteBalances
    .filter((item) => item.asset === 'ETH' || item.asset === 'USDC')
    .map((item) => `${Number(item.available).toLocaleString('en-US')} ${item.asset}`)
    .join(' · ') ?? '余额加载中';
  const visibleTokens = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return tokens;
    return tokens.filter((token) => token.symbol.toLowerCase().includes(needle)
      || token.name.toLowerCase().includes(needle)
      || token.tokenAddress.toLowerCase().includes(needle));
  }, [search, tokens]);
  const tradePresets = useMemo(() => {
    if (side === 'BUY') {
      const values = asset === 'ETH' ? presets : ['25', '100', '250', '500'];
      return values.map((value) => ({ label: value, value }));
    }
    return [25, 50, 75, 100].map((percent) => ({
      label: `${percent}%`,
      value: percentageOf(currentBalance, percent),
    }));
  }, [asset, currentBalance, side]);

  const requestQuote = useCallback(async () => {
    if (!selected || !sessionReady) return;
    setError(null);
    setOrderState('正在报价');
    try {
      const next = await memeApi.createQuote({ side, tokenAddress: selected.tokenAddress, settlementAsset: asset, amountIn: amount, slippageBps: 500 });
      setQuote(next);
      setOrderState(null);
    } catch (cause) {
      setOrderState(null);
      setError(cause instanceof Error ? cause.message : '报价失败');
    }
  }, [amount, asset, selected, sessionReady, side]);

  const submitOrder = useCallback(async () => {
    if (!quote) return;
    setOrderState('资金已冻结，等待广播');
    try {
      const order = await memeApi.createOrder({
        clientOrderId: crypto.randomUUID(),
        quoteId: quote.quoteId,
        maxAmountIn: amount,
        minAmountOut: quote.minAmountOut,
      });
      setOrderState(order.status);
      window.setTimeout(async () => {
        const latest = await memeApi.getOrder(order.orderId);
        setOrderState(`${latest.status} / ${latest.fundStatus}`);
      }, 250);
    } catch (cause) {
      setOrderState(null);
      setError(cause instanceof Error ? cause.message : '下单失败');
    }
  }, [amount, quote]);

  const submitTransfer = useCallback(async () => {
    if (!sessionReady) return;
    setTransferState('划转中');
    setError(null);
    try {
      const from = transferDirection === 'SPOT_TO_MEME' ? 'SPOT' : 'MEME';
      const to = from === 'SPOT' ? 'MEME' : 'SPOT';
      const randomId = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const transferId = await azFundApi.transfer({
        bizId: `meme-transfer-${randomId}`,
        from,
        to,
        currency: transferAsset,
        amount: transferAmount,
      });
      const summary = await memeApi.getAccount();
      setAccount(summary);
      setTransferState(`划转成功 · ${transferId}`);
    } catch (cause) {
      setTransferState(null);
      setError(cause instanceof Error ? cause.message : '划转失败');
    }
  }, [sessionReady, transferAmount, transferAsset, transferDirection]);

  if (loading) return <main className="full-state">正在连接 AZ MEME BOT Mock 服务</main>;
  if (error && tokens.length === 0) return <main className="full-state error-state">启动失败：{error}</main>;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">AZ<span>X</span></div>
        <nav aria-label="主导航">
          <button type="button">Perp</button><button type="button">Spot</button>
          <button type="button" className="active">Meme · {chainName}</button><button type="button">Stocks</button>
        </nav>
        <label className="search"><span>搜索</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="粘贴代币合约地址 0x..." /></label>
        <button type="button" className="balances" aria-label="打开账户划转" disabled={!sessionReady} onClick={() => setTransferOpen(true)}>{balanceLabel}</button>
        <div className="mock-badge">{sessionReady ? 'MOCK 已登录' : 'MOCK 登录中'}</div>
      </header>

      {error && <div className="notice" role="alert">{error}<button type="button" onClick={() => setError(null)}>关闭</button></div>}

      <div className="workspace">
        <aside className="market-panel">
          <div className="panel-title"><strong>发现 · 热榜</strong><span>新币 · 毕业 · 聪明钱</span></div>
          <div className="token-head"><span>代币</span><span>市值</span><span>5m</span><span>持有</span></div>
          <div className="token-list">
            {visibleTokens.length === 0 && <div className="empty">没有匹配的代币</div>}
            {visibleTokens.map((token) => (
              <button type="button" key={token.tokenAddress} className={selected?.tokenAddress === token.tokenAddress ? 'token-row selected' : 'token-row'} onClick={() => setSelected(token)}>
                <span><b>{token.symbol}</b><small>${compact(token.pool.liquidityUsd)} 流动性 · {age(token.ageSeconds)}</small></span>
                <span>${compact(Number(token.priceUsd) * 1_000_000_000)}</span>
                <span className={Number(token.change5m) >= 0 ? 'positive' : 'negative'}>{Number(token.change5m) > 0 ? '+' : ''}{token.change5m}%</span>
                <span>{compact(token.holders)}</span>
              </button>
            ))}
          </div>
        </aside>

        <section className="chart-panel">
          {selected ? <>
            <div className="instrument">
              <div><strong>{selected.symbol} / ETH</strong><span>{selected.stage === 'GRADUATED' ? '已毕业' : '曲线'} · {selected.pool.poolType.replaceAll('_', ' ')}</span></div>
              <div className="ticker"><strong>${Number(displayedPrice).toFixed(6)}</strong><span className={Number(selected.change5m) >= 0 ? 'positive' : 'negative'}>{Number(selected.change5m) > 0 ? '+' : ''}{selected.change5m}% 5m</span></div>
            </div>
            <div className="intervals" aria-label="K 线周期">
              {intervals.map((item) => <button type="button" className={interval === item ? 'active' : ''} key={item} onClick={() => setIntervalValue(item)}>{item}</button>)}
              <span>市值 ${compact(Number(selected.priceUsd) * 1_000_000_000)} · 持有 {compact(selected.holders)}</span>
            </div>
            {chartLoading || snapshot?.status !== 'READY'
              ? <div className="chart-state">回补历史 K 线并追至最新区块</div>
              : <CandleChart candles={snapshot.items} symbol={selected.symbol} />}
          </> : <div className="empty">请选择代币</div>}
        </section>

        <aside className="trade-panel">
          <div className="side-tabs"><button type="button" className={side === 'BUY' ? 'active' : ''} onClick={() => { setSide('BUY'); setQuote(null); setOrderState(null); }}>买入</button><button type="button" className={side === 'SELL' ? 'active sell' : ''} onClick={() => { setSide('SELL'); setQuote(null); setOrderState(null); }}>卖出</button></div>
          <div className="trade-form">
            <label><span>{side === 'BUY' ? '金额' : '数量'}</span><span>可用 {currentBalance} {side === 'BUY' ? asset : selected?.symbol}</span></label>
            <div className="amount-input"><input aria-label={side === 'BUY' ? '买入金额' : '卖出数量'} value={amount} onChange={(event) => { setAmount(event.target.value); setQuote(null); setOrderState(null); }} inputMode="decimal" />{side === 'BUY' ? <select aria-label="支付资产" value={asset} onChange={(event) => { setAsset(event.target.value as Asset); setQuote(null); setOrderState(null); }}><option>ETH</option><option>USDC</option><option>USDT</option></select> : <span className="amount-unit">{selected?.symbol}</span>}</div>
            {side === 'SELL' && <label className="settlement"><span>结算资产</span><select aria-label="结算资产" value={asset} onChange={(event) => { setAsset(event.target.value as Asset); setQuote(null); setOrderState(null); }}><option>ETH</option><option>USDC</option><option>USDT</option></select></label>}
            <div className="presets">{tradePresets.map((preset) => <button type="button" className={amount === preset.value ? 'active' : ''} key={preset.label} onClick={() => { setAmount(preset.value); setQuote(null); setOrderState(null); }}>{preset.label}</button>)}</div>
            <dl>
              <div><dt>预计得到</dt><dd>{quote ? `≈ ${quote.expectedAmountOut} ${side === 'BUY' ? selected?.symbol : asset}` : '等待报价'}</dd></div>
              <div><dt>路由</dt><dd>{selected?.pool.poolType.replaceAll('_', ' ') ?? '未选择'}</dd></div>
              <div><dt>滑点上限</dt><dd>5%</dd></div>
              <div><dt>交易模式</dt><dd className="positive">无需钱包再次签名</dd></div>
            </dl>
            <button type="button" className="primary" disabled={!sessionReady || !selected || Boolean(orderState) || (side === 'SELL' && Number(currentBalance) <= 0)} onClick={quote ? submitOrder : requestQuote}>
              {!sessionReady ? '等待 AZ 登录' : orderState ?? (quote ? `确认${side === 'BUY' ? '买入' : '卖出'}` : '获取链上报价')}
            </button>
            <p>PoC 使用 AZ 登录会话与平台 Trading Account</p>
          </div>
          <div className="positions">
            <div className="positions-head"><strong>我的持仓</strong><span className="positive">+${totalPosition.toFixed(0)}</span></div>
            {account?.positions.map((position) => <div className="position" key={position.tokenAddress}><span><b>{position.symbol}</b><small>{compact(position.available)} 枚</small></span><span className={Number(position.valueUsd) >= Number(position.costUsd) ? 'positive' : 'negative'}>{((Number(position.valueUsd) / Number(position.costUsd) - 1) * 100).toFixed(0)}%</span><button type="button" onClick={() => { setSelected(tokens.find((token) => token.tokenAddress === position.tokenAddress) ?? null); setSide('SELL'); setQuote(null); setOrderState(null); }}>卖</button></div>)}
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
