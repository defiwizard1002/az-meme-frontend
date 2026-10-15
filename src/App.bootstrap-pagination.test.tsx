import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App, { mergeTrades } from './App';
import type { HistoryLoadResult } from './CandleChart';
import { ApiError, azAuth, memeApi, setSessionToken } from './api';
import type { Candle, CandleSnapshot, Token, Trade } from './types';

const chart = vi.hoisted(() => ({ current: null as {
  candles: Candle[]; symbol: string; onLoadBefore: (before: number) => Promise<HistoryLoadResult>;
} | null }));
vi.mock('./CandleChart', () => ({
  CandleChart: (props: NonNullable<typeof chart.current>) => {
    chart.current = props;
    return <div aria-label={`${props.symbol} K 线图`}>{props.candles.map((item) => item.t).join(',')}</div>;
  },
}));

const tokenA: Token = {
  chainId: 4663, tokenAddress: `0x${'1'.repeat(40)}`, symbol: 'AAA', name: 'Token A',
  launchpad: 'PONS', stage: 'GRADUATED', quoteAssetKey: 'NATIVE', priceQuote: '11', priceUsd: '11',
  marketCapUsd: '1000', volume24hUsd: '100', change5m: '1', change24h: '2', holders: 10, ageSeconds: 60,
  pool: { poolKey: 'pool-a', poolType: 'UNISWAP_V4', liquidityUsd: '1000' },
  tradeStatus: 'TRADABLE', riskFlags: [], security: { isHoneypot: false, buyTaxPct: '0', sellTaxPct: '0',
    liquidityLocked: true, liquidityLockedPct: '100', liquidityBurnedPct: '0' },
};
const tokenB: Token = { ...tokenA, tokenAddress: `0x${'2'.repeat(40)}`, symbol: 'BBB', name: 'Token B', priceUsd: '22' };
const summary = { quoteBalances: [{ asset: 'ETH' as const, available: '10', frozen: '0' },
  { asset: 'USDG' as const, available: '10', frozen: '0' }], positions: [] };
const auth = { userId: 'test-user', accountId: 'test-account', loginStatus: 'LOGGED_IN', expiresAt: 9999999999999 };

function candle(t: number, price: string): Candle {
  return { t, o: price, h: price, l: price, c: price, baseVolume: '1', quoteVolume: '1', revision: '1' };
}
function snapshot(token: Token, interval: CandleSnapshot['interval'] = '1m', items = [candle(token === tokenA ? 100 : 200, token.priceUsd)]): CandleSnapshot {
  return { chainId: 4663, tokenAddress: token.tokenAddress, marketKey: 'USD:USDG', interval,
    syncStatus: 'READY', availability: 'COMPLETE', coverage: { from: items[0]?.t ?? null, to: items.at(-1)?.t ?? null },
    gaps: [], revision: '1', asOfBlock: 100, source: 'CHAIN', items };
}
function trade(id: string, t: number, price: string): Trade {
  return { tradeId: id, t, side: 'BUY', priceUsd: price, baseAmount: '1', quoteAmount: '1', quoteAsset: 'USDG',
    trader: `0x${'3'.repeat(40)}`, txHash: `0x${'4'.repeat(64)}` };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('bounded trade merge', () => {
  it('sorts by actual time before the 5000 cap so older history cannot evict newer trades', () => {
    const current = Array.from({ length: 5000 }, (_, index) => trade(`live-${index}`, index + 1, '11'));
    const history = Array.from({ length: 100 }, (_, index) => ({ ...trade(`old-${index}`, -index, '22'), history: true }));
    const items = mergeTrades(current, history);
    expect(items).toHaveLength(5000);
    expect(items.map((item) => item.tradeId)).toEqual([...current].reverse().map((item) => item.tradeId));
  });

  it('replaces a known ID and reorders its corrected time before applying the cap', () => {
    const current = Array.from({ length: 5000 }, (_, index) => trade(`live-${index}`, index + 1, '11'));
    const revised = { ...trade('live-0', 6000, '22'), correction: true };
    const newest = trade('newest', 7000, '33');
    const items = mergeTrades(current, [revised, trade('old', 0, '44'), newest]);
    expect(items).toHaveLength(5000);
    expect(items.slice(0, 3)).toEqual([newest, revised, current[4999]]);
    expect(items.at(-1)).toBe(current[2]);
    expect(new Set(items.map((item) => item.tradeId)).size).toBe(5000);
  });

  it('uses object identity to protect a later replacement even when its values did not change', () => {
    const before = trade('known', 100, '11');
    const later = { ...before };
    const baseline = new Map([[before.tradeId, before]]);
    const fresh = trade('known', 100, '22');
    expect(mergeTrades([before], [fresh], baseline)).toEqual([fresh]);
    expect(mergeTrades([later], [fresh], baseline)[0]).toBe(later);
  });

  it('dedupes a GET response by ID with the last update while preserving rows absent from the page', () => {
    const retained = trade('retained', 110, '33');
    const last = trade('known', 100, '22');
    const items = mergeTrades([retained], [trade('known', 90, '11'), last], new Map([[retained.tradeId, retained]]));
    expect(items).toEqual([retained, last]);
  });
});

class ControlledSocket {
  static readonly OPEN = 1;
  static instances: ControlledSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  listeners = new Map<string, Array<(event: Event) => void>>();
  constructor(_url: string) { ControlledSocket.instances.push(this); }
  addEventListener(name: string, listener: (event: Event) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  emit(name: string, event: Event) { for (const listener of this.listeners.get(name) ?? []) listener(event); }
  send(payload: string) { this.sent.push(payload); }
  open() { this.readyState = 1; this.emit('open', new Event('open')); }
  receive(data: unknown) { this.emit('message', { data: JSON.stringify(data) } as MessageEvent); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close', new Event('close')); }
}

describe('urgent live trade and account origin regressions through App', () => {
  afterEach(() => { cleanup(); setSessionToken(null); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const row = (price: string) => screen.getAllByTestId('trade-price').find((node) => node.textContent === `$${price}`)!.closest('.trade-row')!;
  async function mountLive() {
    setup('MAIN_ACCOUNT_POC', true);
    vi.useFakeTimers();
    await act(async () => { render(<App />); });
    const socket = ControlledSocket.instances.at(-1)!;
    act(() => socket.open());
    return socket;
  }
  function push(socket: ControlledSocket, items: Trade[], sequence = 1, token = tokenA) {
    act(() => socket.receive({ channel: `trade:${token.tokenAddress}:USD:USDG`, epoch: 'live', sequence, data: { items } }));
  }

  it('flashes only new live trade IDs, expires briefly and does not flash REST pages or replay', async () => {
    const socket = await mountLive();
    expect(row('11')).not.toHaveClass('trade-flash');
    scrollTrades();
    await act(async () => {});
    expect(document.querySelectorAll('.trade-flash')).toHaveLength(0);
    push(socket, [trade('a-new', 100, '11'), trade('live-new', 101, '33')]);
    expect(row('11')).not.toHaveClass('trade-flash');
    expect(row('33')).toHaveClass('trade-flash');
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(row('33')).not.toHaveClass('trade-flash');
    push(socket, [trade('live-new', 101, '33')], 2);
    expect(row('33')).not.toHaveClass('trade-flash');
    push(socket, [trade('live-new', 101, '33')], 2);
    expect(row('33')).not.toHaveClass('trade-flash');
  });

  it('honors pause, scopes flash to the selected token and clears timers on unmount', async () => {
    const socket = await mountLive();
    fireEvent.click(screen.getByRole('button', { name: '暂停' }));
    push(socket, [trade('paused', 101, '33')]);
    expect(screen.queryByText('$33')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(row('33')).not.toHaveClass('trade-flash');
    push(socket, [trade('active', 102, '44')], 2);
    expect(row('44')).toHaveClass('trade-flash');
    fireEvent.click(screen.getByRole('button', { name: '查看 BBB' }));
    await act(async () => {});
    expect(document.querySelectorAll('.trade-flash')).toHaveLength(0);
    push(socket, [trade('stale-a', 103, '99')], 3);
    expect(screen.queryByText('$99')).not.toBeInTheDocument();
    const nextSocket = ControlledSocket.instances.at(-1)!;
    act(() => nextSocket.open());
    push(nextSocket, [trade('active', 201, '55')], 1, tokenB);
    expect(row('55')).toHaveClass('trade-flash');
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { race: false, paused: false }, { race: true, paused: false },
    { race: false, paused: true }, { race: true, paused: true },
  ])('trade request baseline: pagination refreshes known IDs, protects later WS changes and honors pause (%j)', async ({ race, paused }) => {
    setup('MAIN_ACCOUNT_POC', true); vi.useFakeTimers();
    const gate = deferred<Awaited<ReturnType<typeof memeApi.getTrades>>>();
    vi.mocked(memeApi.getTrades).mockImplementation((_address, cursor) => cursor ? gate.promise
      : Promise.resolve({ items: [trade('a-new', 100, '11'), trade('unchanged', 90, '12')], nextCursor: 'a-cursor' }));
    await act(async () => { render(<App />); });
    const socket = ControlledSocket.instances.at(-1)!; act(() => socket.open());
    push(socket, [{ ...trade('a-new', 100, '17'), history: true }]);
    scrollTrades();
    expect(memeApi.getTrades).toHaveBeenLastCalledWith(tokenA.tokenAddress, 'a-cursor');
    if (paused) fireEvent.click(screen.getByRole('button', { name: '暂停' }));
    if (race) push(socket, [
      { ...trade('a-new', 100, '44'), history: true, correction: true }, trade('stream-new', 110, '55'),
    ], 2);
    await act(async () => gate.resolve({ items: [
      trade('old', 50, '33'), trade('stream-new', 110, '77'), trade('a-new', 100, '22'), trade('unchanged', 90, '66'),
    ], nextCursor: 'next-history' }));
    if (paused) {
      expect(screen.getAllByTestId('trade-price').map((item) => item.textContent)).toEqual(['$17', '$12']);
      fireEvent.click(screen.getByRole('button', { name: '继续' }));
    }
    expect(screen.getAllByTestId('trade-price').map((item) => item.textContent)).toEqual(race
      ? ['$55', '$44', '$66', '$33'] : ['$77', '$22', '$66', '$33']);
    expect(document.querySelectorAll('.trade-flash')).toHaveLength(race && !paused ? 1 : 0);
    expect(row(race ? '44' : '22')).not.toHaveClass('trade-flash');
    expect(row('66')).not.toHaveClass('trade-flash');
    scrollTrades();
    expect(memeApi.getTrades).toHaveBeenLastCalledWith(tokenA.tokenAddress, 'next-history');
  });

  it('respects reduced motion for newly pushed rows', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    const socket = await mountLive();
    push(socket, [trade('live-new', 101, '33')]);
    expect(row('33')).not.toHaveClass('trade-flash');
  });

  it('keeps the chart mounted for market metadata updates within the same token identity', async () => {
    const socket = await mountLive();
    vi.mocked(memeApi.getCandles).mockImplementation(async (address, interval) => snapshot(
      address.toLowerCase() === tokenA.tokenAddress ? tokenA : tokenB, interval));
    const canvas = screen.getByLabelText('AAA K 线图');
    act(() => socket.receive({ channel: `market:${tokenA.tokenAddress}`, epoch: 'live', sequence: 1,
      data: { ...tokenA, tokenAddress: tokenA.tokenAddress.toUpperCase(), priceUsd: '12', holders: 12 } }));
    await act(async () => {});
    expect(screen.getByLabelText('AAA K 线图')).toBe(canvas);
    expect(chart.current!.candles).toEqual([candle(100, '11')]);
    fireEvent.click(screen.getByRole('button', { name: '1s' }));
    await act(async () => {});
    expect(screen.getByLabelText('AAA K 线图')).not.toBe(canvas);
  });

  it('shows the private MAIN_ACCOUNT_POC summary as connected without AZ login', async () => {
    setup('MAIN_ACCOUNT_POC');
    vi.stubGlobal('location', new URL('https://dopemac-mini.tailc44fad.ts.net:4173/'));
    await act(async () => { render(<App />); });
    expect(document.querySelector('.mock-badge')).toHaveAttribute('data-state', 'connected');
    expect(document.querySelector('.mock-badge')).toHaveTextContent('主账户已连接');
    expect(document.querySelector('.balances')).toHaveTextContent('10 USDG');
    expect(azAuth.loginMock).not.toHaveBeenCalled();
  });

  it('bounds public ticket retries independently of an AZ upstream failure', async () => {
    setup('AZ_ACCOUNT', true);
    vi.mocked(memeApi.getWsTicket).mockRejectedValue(new ApiError('AZ_REQUEST_FAILED', 'auth upstream absent', 502));
    vi.useFakeTimers();
    await act(async () => { render(<App />); });
    expect(screen.getAllByRole('alert').some((node) => node.textContent?.includes('AZ 登录上游不可用'))).toBe(true);
    const attempts = vi.mocked(memeApi.getWsTicket).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(vi.mocked(memeApi.getWsTicket).mock.calls.length).toBeGreaterThan(attempts);
    expect(vi.mocked(memeApi.getWsTicket).mock.calls.length).toBeLessThan(10);
    expect(azAuth.loginMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(memeApi.getWsTicket).mock.calls.at(-1)).toEqual([expect.any(AbortSignal), true]);
  });

  it('shows actionable AZ login upstream failure and the authorized private Tailscale origin without retry loops', async () => {
    setup('AZ_ACCOUNT', true);
    vi.stubGlobal('location', new URL('https://dopemac-mini.tailc44fad.ts.net:10000/'));
    vi.mocked(azAuth.loginMock).mockRejectedValue(new ApiError('AZ_REQUEST_FAILED', 'HTTP 502: 请求失败', 502));
    vi.useFakeTimers();
    await act(async () => { render(<App />); });
    expect(document.querySelector('.mock-badge')).toHaveAttribute('data-state', 'failed');
    expect(screen.getByRole('alert')).toHaveTextContent(/AZ_ACCOUNT.*AZ 登录上游/);
    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 502');
    expect(screen.getByRole('alert')).toHaveTextContent('AZ_REQUEST_FAILED');
    expect(screen.getByRole('link', { name: /Tailscale.*私网/ })).toHaveAttribute('href', 'https://dopemac-mini.tailc44fad.ts.net:4173/');
    act(() => ControlledSocket.instances.at(-1)!.open());
    const attempts = vi.mocked(memeApi.getWsTicket).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(azAuth.loginMock).toHaveBeenCalledTimes(1);
    expect(memeApi.getWsTicket).toHaveBeenCalledTimes(attempts);
    expect(memeApi.getAccount).not.toHaveBeenCalled();
    expect(document.querySelector('button.primary')).toBeDisabled();
  });

  it.each(['AZ_ACCOUNT', 'MAIN_ACCOUNT_POC'] as const)('preserves unrelated %s errors and never offers another host a private signer link', async (mode) => {
    setup(mode);
    vi.stubGlobal('location', new URL('https://unrelated.example:10000/'));
    vi.mocked(memeApi.getAccount).mockRejectedValue(new ApiError('MEME_PROVIDER_ERROR', 'actual failure', 503));
    await act(async () => { render(<App />); });
    expect(screen.getByRole('alert')).toHaveTextContent('actual failure');
    expect(screen.getByRole('alert')).toHaveTextContent('MEME_PROVIDER_ERROR');
    expect(document.querySelector('.mock-badge')).toHaveAttribute('data-state', 'failed');
    expect(screen.queryByRole('link', { name: /Tailscale/ })).not.toBeInTheDocument();
    expect(azAuth.loginMock).toHaveBeenCalledTimes(mode === 'AZ_ACCOUNT' ? 1 : 0);
  });
});

function setup(mode: 'AZ_ACCOUNT' | 'MAIN_ACCOUNT_POC', withSocket = false) {
  chart.current = null;
  ControlledSocket.instances = [];
  vi.stubGlobal('WebSocket', withSocket ? ControlledSocket : undefined);
  vi.spyOn(azAuth, 'loginMock').mockResolvedValue(auth);
  vi.spyOn(memeApi, 'getConfig').mockResolvedValue({ chainId: 4663, chainName: 'Test', explorerBaseUrl: '',
    defaultSlippageBps: 300, marketRefreshMs: { hot: 14_400_000, new: 300_000 }, accountMode: mode,
    mainAccountAddress: null, settlementAssets: mode === 'MAIN_ACCOUNT_POC' ? ['USDG', 'ETH'] : ['ETH'] });
  vi.spyOn(memeApi, 'getMarkets').mockResolvedValue({ items: [tokenA, tokenB], stale: false });
  vi.spyOn(memeApi, 'getToken').mockImplementation(async (address) => address === tokenA.tokenAddress ? tokenA : tokenB);
  vi.spyOn(memeApi, 'getAccount').mockResolvedValue(summary);
  vi.spyOn(memeApi, 'getAccountTransactions').mockResolvedValue({ items: [] });
  vi.spyOn(memeApi, 'getOrders').mockResolvedValue({ items: [], nextCursor: null });
  vi.spyOn(memeApi, 'getWsTicket').mockResolvedValue({ ticket: 'test', expiresAt: 9999999999999 });
  vi.spyOn(memeApi, 'getCandles').mockImplementation(async (address, interval) => snapshot(address === tokenA.tokenAddress ? tokenA : tokenB, interval));
  vi.spyOn(memeApi, 'getTrades').mockImplementation(async (address, cursor) => ({
    items: [address === tokenA.tokenAddress ? trade(cursor ? 'a-old' : 'a-new', cursor ? 50 : 100, '11')
      : trade(cursor ? 'b-old' : 'b-new', cursor ? 150 : 200, '22')],
    nextCursor: cursor ? null : address === tokenA.tokenAddress ? 'a-cursor' : 'b-cursor',
  }));
  vi.spyOn(memeApi, 'createQuote').mockImplementation(async (input) => ({ ...input,
    quoteId: 'quote', expectedAmountOut: '100', minAmountOut: '95', fees: [], expiresAt: 9999999999999 }));
  vi.spyOn(memeApi, 'createOrder').mockResolvedValue({ orderId: 'order', status: 'SETTLED', fundStatus: 'SETTLED' });
  vi.spyOn(memeApi, 'getOrder').mockResolvedValue({ orderId: 'order', status: 'SETTLED', fundStatus: 'SETTLED' });
  const transaction = { executionId: 'execution', tokenAddress: tokenA.tokenAddress, tokenSymbol: tokenA.symbol,
    side: 'BUY' as const, settlementAsset: 'USDG' as const, amountIn: '1', amountOut: '100', status: 'CONFIRMED' as const,
    txHashes: [], errorMessage: null, createdAt: 1, updatedAt: 1 };
  vi.spyOn(memeApi, 'executeMainAccountTrade').mockResolvedValue(transaction);
  vi.spyOn(memeApi, 'getAccountTransaction').mockResolvedValue(transaction);
}

const stages = [
  { mode: 'AZ_ACCOUNT', stage: 'authentication', message: '登录失败' },
  { mode: 'AZ_ACCOUNT', stage: 'summary', message: '账户余额加载失败' },
  { mode: 'AZ_ACCOUNT', stage: 'orders', message: '订单状态恢复失败' },
  { mode: 'MAIN_ACCOUNT_POC', stage: 'summary', message: '账户余额加载失败' },
  { mode: 'MAIN_ACCOUNT_POC', stage: 'transactions', message: '交易记录加载失败' },
  { mode: 'MAIN_ACCOUNT_POC', stage: 'orders', message: '订单状态恢复失败' },
] as const;
function holdStage(stage: typeof stages[number]['stage']) {
  const gate = deferred<void>();
  switch (stage) {
    case 'authentication': vi.mocked(azAuth.loginMock).mockImplementation(async () => { await gate.promise; return auth; }); break;
    case 'summary': vi.mocked(memeApi.getAccount).mockImplementation(async () => { await gate.promise; return summary; }); break;
    case 'transactions': vi.mocked(memeApi.getAccountTransactions).mockImplementation(async () => { await gate.promise; return { items: [] }; }); break;
    case 'orders': vi.mocked(memeApi.getOrders).mockImplementation(async () => { await gate.promise; return { items: [], nextCursor: null }; }); break;
  }
  const method = stage === 'authentication' ? azAuth.loginMock : stage === 'summary' ? memeApi.getAccount
    : stage === 'transactions' ? memeApi.getAccountTransactions : memeApi.getOrders;
  return { ...gate, started: () => vi.mocked(method).mock.calls.length > 0 };
}
function expectClosed(mode: typeof stages[number]['mode']) {
  expect(document.querySelector('button.primary')).toBeDisabled();
  if (mode === 'AZ_ACCOUNT') expect(screen.getByRole('button', { name: '打开账户划转' })).toBeDisabled();
  expect(memeApi.createQuote).not.toHaveBeenCalled();
  expect(memeApi.createOrder).not.toHaveBeenCalled();
  expect(memeApi.executeMainAccountTrade).not.toHaveBeenCalled();
  expect(ControlledSocket.instances.flatMap((socket) => socket.sent).map((payload) => JSON.parse(payload))
    .every((payload) => !payload.quote)).toBe(true);
}
async function exercisePending(mode: typeof stages[number]['mode']) {
  await screen.findByLabelText('AAA K 线图');
  // Market discovery and partial charts remain usable throughout account bootstrap.
  expect(screen.getByRole('button', { name: '查看 BBB' })).toBeEnabled();
  fireEvent.change(screen.getByLabelText('买入金额'), { target: { value: '2' } });
  await waitFor(() => expect(ControlledSocket.instances.length).toBeGreaterThan(0));
  const socket = ControlledSocket.instances.at(-1)!;
  act(() => {
    socket.open();
    socket.receive({ channel: 'quote:test', epoch: 'test', sequence: 1,
      data: { quoteId: 'unsolicited', tokenAddress: tokenA.tokenAddress, side: 'BUY', amountIn: '2',
        settlementAsset: mode === 'MAIN_ACCOUNT_POC' ? 'USDG' : 'ETH', expectedAmountOut: '999',
        minAmountOut: '900', fees: [], expiresAt: 9999999999999 } });
  });
  fireEvent.click(document.querySelector('button.primary')!);
  expectClosed(mode);
  expect(document.querySelector('.quote-details')).toHaveTextContent('等待报价');
}
async function select(token: Token) {
  fireEvent.click(screen.getByRole('button', { name: `查看 ${token.symbol}` }));
  await screen.findByLabelText(`${token.symbol} K 线图`);
}
function scrollTrades() {
  // jsdom's zero layout places the scroll position at the bottom deterministically.
  fireEvent.scroll(document.querySelector('.trade-rows')!);
}

describe('account bootstrap and selection-scoped pagination', () => {
  afterEach(() => { cleanup(); setSessionToken(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each(stages)('keeps $mode closed while $stage is pending, then enables only after success', async ({ mode, stage }) => {
    setup(mode, true);
    const gate = holdStage(stage);
    render(<App />);
    await waitFor(() => expect(gate.started()).toBe(true));
    await exercisePending(mode);
    await act(async () => gate.resolve());
    await waitFor(() => expect(document.querySelector('button.primary')).toBeEnabled());
    expect(memeApi.createQuote).toHaveBeenCalledTimes(1);
    fireEvent.click(document.querySelector('button.primary')!);
    await waitFor(() => expect(mode === 'MAIN_ACCOUNT_POC' ? memeApi.executeMainAccountTrade : memeApi.createOrder).toHaveBeenCalledTimes(1));
  });

  it.each(stages)('never enables $mode trading before an eventual $stage failure', async ({ mode, stage, message }) => {
    setup(mode, true);
    const gate = holdStage(stage);
    render(<App />);
    await waitFor(() => expect(gate.started()).toBe(true));
    await exercisePending(mode);
    await act(async () => gate.reject(new ApiError('ACCOUNT_UNAVAILABLE', 'unavailable', 503)));
    expect(await screen.findByRole('alert')).toHaveTextContent(`账户请求失败：${message}`);
    expectClosed(mode);
    fireEvent.change(screen.getByLabelText('买入金额'), { target: { value: '3' } });
    await select(tokenB);
    expectClosed(mode);
  });

  it('cannot become ready when other bootstrap requests succeed after one has failed', async () => {
    setup('MAIN_ACCOUNT_POC', true);
    const summaryGate = holdStage('summary');
    const transactionsGate = holdStage('transactions');
    const ordersGate = holdStage('orders');
    render(<App />);
    await waitFor(() => expect(ordersGate.started()).toBe(true));
    await exercisePending('MAIN_ACCOUNT_POC');
    await act(async () => ordersGate.reject(new ApiError('ACCOUNT_UNAVAILABLE', 'unavailable', 503)));
    await screen.findByRole('alert');
    await act(async () => { summaryGate.resolve(); transactionsGate.resolve(); });
    expectClosed('MAIN_ACCOUNT_POC');
    expect(screen.getByRole('alert')).toHaveTextContent('订单状态恢复失败');
  });

  it('keeps partial history visible after loading a complete older page', async () => {
    setup('MAIN_ACCOUNT_POC');
    const gap = { from: 1, to: 49, reason: 'EVENT_EXPIRED' as const };
    vi.mocked(memeApi.getCandles).mockImplementation(async (_address, interval, options) => options?.to !== undefined
      ? snapshot(tokenA, interval, [candle(50, '10')])
      : { ...snapshot(tokenA, interval), availability: 'PARTIAL', gaps: [gap] });
    render(<App />);
    await screen.findByLabelText('AAA K 线图');
    expect(screen.queryByText(/历史 K 线部分缺失/)).not.toBeInTheDocument();
    await act(async () => { expect(await chart.current!.onLoadBefore(99)).toEqual({ added: 1, exhausted: false }); });
    expect(chart.current!.candles.map((item) => item.t)).toEqual([50, 100]);
    expect(screen.queryByText(/成交已过保留期/)).not.toBeInTheDocument();
  });

  it.each([
    ['token change', 'success'], ['token change', 'failure'],
    ['token revisit', 'success'], ['token revisit', 'failure'],
    ['interval change', 'success'], ['interval change', 'failure'],
  ] as const)('ignores an old candle page after %s (%s)', async (change, outcome) => {
    setup('MAIN_ACCOUNT_POC');
    const gate = deferred<CandleSnapshot>();
    const original = vi.mocked(memeApi.getCandles).getMockImplementation()!;
    vi.mocked(memeApi.getCandles).mockImplementation((address, interval, options) => options?.to !== undefined
      ? gate.promise : original(address, interval, options));
    render(<App />);
    await screen.findByLabelText('AAA K 线图');
    await waitFor(() => expect(chart.current!.candles.map((item) => item.t)).toEqual([100]));
    let loading!: Promise<HistoryLoadResult>;
    act(() => { loading = chart.current!.onLoadBefore(99); });
    expect(memeApi.getCandles).toHaveBeenLastCalledWith(tokenA.tokenAddress, '1m', { to: 99, limit: 300, signal: expect.any(AbortSignal) });
    if (change === 'interval change') {
      fireEvent.click(screen.getByRole('button', { name: '15m' }));
      await waitFor(() => expect(memeApi.getCandles).toHaveBeenLastCalledWith(tokenA.tokenAddress, '15m', { signal: expect.any(AbortSignal) }));
      await screen.findByLabelText('AAA K 线图');
    } else {
      await select(tokenB);
      if (change === 'token revisit') await select(tokenA);
    }
    await act(async () => {
      if (outcome === 'success') gate.resolve(snapshot(tokenA, '1m', [candle(50, '9')]));
      else gate.reject(new Error('stale candle failure'));
      expect(await loading).toEqual({ added: 0, exhausted: false });
    });
    const active = change === 'token change' ? tokenB : tokenA;
    expect(screen.getByLabelText(`${active.symbol} K 线图`)).toBeInTheDocument();
    expect(chart.current!.candles.map((item) => item.t)).toEqual([active === tokenB ? 200 : 100]);
    expect(screen.getByTestId('current-price')).toHaveTextContent(`$${active.priceUsd}`);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each(['success', 'failure'] as const)('ignores token A trade pagination while token B initial trades are still pending (%s)', async (outcome) => {
    setup('MAIN_ACCOUNT_POC');
    const oldPage = deferred<Awaited<ReturnType<typeof memeApi.getTrades>>>();
    const newTokenPage = deferred<Awaited<ReturnType<typeof memeApi.getTrades>>>();
    const original = vi.mocked(memeApi.getTrades).getMockImplementation()!;
    vi.mocked(memeApi.getTrades).mockImplementation((address, cursor) => address === tokenB.tokenAddress
      ? newTokenPage.promise : cursor ? oldPage.promise : original(address, cursor));
    render(<App />);
    await screen.findByText('1 笔');
    scrollTrades();
    await select(tokenB);
    expect(screen.getByText('正在加载成交')).toBeInTheDocument();
    await act(async () => {
      if (outcome === 'success') oldPage.resolve({ items: [trade('late-a', 50, '99')], nextCursor: 'late-a-cursor' });
      else oldPage.reject(new Error('stale trade failure'));
    });
    expect(screen.getByText('正在加载成交')).toBeInTheDocument();
    expect(screen.queryByTestId('trade-price')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => newTokenPage.resolve({ items: [trade('b-new', 200, '22')], nextCursor: 'b-cursor' }));
    expect(screen.getByTestId('trade-price')).toHaveTextContent('$22');
  });

  it.each([
    ['token change', 'success'], ['token change', 'failure'],
    ['token revisit', 'success'], ['token revisit', 'failure'],
  ] as const)('keeps active trades, cursor, and loading state after %s and an old page %s', async (change, outcome) => {
    setup('MAIN_ACCOUNT_POC');
    const oldPage = deferred<Awaited<ReturnType<typeof memeApi.getTrades>>>();
    const activePage = deferred<Awaited<ReturnType<typeof memeApi.getTrades>>>();
    const original = vi.mocked(memeApi.getTrades).getMockImplementation()!;
    let paginationCalls = 0;
    vi.mocked(memeApi.getTrades).mockImplementation((address, cursor) => {
      if (!cursor) return original(address);
      paginationCalls += 1;
      return paginationCalls === 1 ? oldPage.promise : activePage.promise;
    });
    render(<App />);
    await screen.findByText('1 笔');
    scrollTrades();
    expect(memeApi.getTrades).toHaveBeenLastCalledWith(tokenA.tokenAddress, 'a-cursor');
    await select(tokenB);
    if (change === 'token revisit') await select(tokenA);
    const active = change === 'token revisit' ? tokenA : tokenB;
    const cursor = active === tokenA ? 'a-cursor' : 'b-cursor';
    await waitFor(() => expect(screen.getByTestId('trade-price')).toHaveTextContent(`$${active.priceUsd}`));
    scrollTrades();
    expect(memeApi.getTrades).toHaveBeenLastCalledWith(active.tokenAddress, cursor);
    await act(async () => {
      if (outcome === 'success') oldPage.resolve({ items: [trade('late-a', 50, '99')], nextCursor: 'late-a-cursor' });
      else oldPage.reject(new Error('stale trade failure'));
    });
    expect(screen.getByTestId('trade-price')).toHaveTextContent(`$${active.priceUsd}`);
    expect(screen.getByText('正在加载')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    scrollTrades();
    expect(paginationCalls).toBe(2);
    await act(async () => activePage.resolve({ items: [trade('active-older', 40, '33')], nextCursor: 'active-next-cursor' }));
    expect(screen.getAllByTestId('trade-price').map((item) => item.textContent)).toEqual([`$${active.priceUsd}`, '$33']);
    scrollTrades();
    expect(memeApi.getTrades).toHaveBeenLastCalledWith(active.tokenAddress, 'active-next-cursor');
  });
});

describe('bounded older candle pages', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it('retains history beyond 2000 bars, dedupes and prevents revision regression', async () => {
    const { mergeSnapshots } = await import('./App');
    const recent = snapshot(tokenA, '1m', Array.from({ length: 2000 }, (_, i) => ({ ...candle(i + 100, '2'), revision: '2' })));
    const older = snapshot(tokenA, '1m', [candle(99, '1'), candle(98, '1'), candle(99, '1'), candle(100, '0.5')]);
    const merged = mergeSnapshots(recent, older);
    expect(merged.items).toHaveLength(2002);
    expect(merged.items.slice(0, 3).map((item) => item.t)).toEqual([98, 99, 100]);
    expect(merged.items[2]!.c).toBe('2');
    expect(merged.items.at(-1)!.t).toBe(2099);
    expect(mergeSnapshots(merged, older).items).toEqual(merged.items);
  });
  it('bounds requests, counts distinct older bars and stops at an empty completed page', async () => {
    setup('MAIN_ACCOUNT_POC');
    vi.mocked(memeApi.getCandles).mockImplementation(async (_address, interval, options) => options?.to !== undefined
      ? snapshot(tokenA, interval, options.to === 99 ? [candle(50, '1'), candle(50, '1')] : []) : snapshot(tokenA, interval));
    render(<App />); await screen.findByLabelText('AAA K 线图');
    await act(async () => expect(await chart.current!.onLoadBefore(100)).toEqual({ added: 0, exhausted: false }));
    await act(async () => expect(await chart.current!.onLoadBefore(99)).toEqual({ added: 1, exhausted: false }));
    expect(memeApi.getCandles).toHaveBeenLastCalledWith(tokenA.tokenAddress, '1m', { to: 99, limit: 300, signal: expect.any(AbortSignal) });
    expect(chart.current!.candles.map((item) => item.t)).toEqual([50, 100]);
    await act(async () => expect(await chart.current!.onLoadBefore(49)).toEqual({ added: 0, exhausted: true }));
    const calls = vi.mocked(memeApi.getCandles).mock.calls.length;
    await act(async () => expect(await chart.current!.onLoadBefore(49)).toEqual({ added: 0, exhausted: true }));
    expect(memeApi.getCandles).toHaveBeenCalledTimes(calls);
  });
  it('retries a zero page while history is backfilling, then accepts older candles', async () => {
    setup('MAIN_ACCOUNT_POC');
    let olderPages = 0;
    vi.mocked(memeApi.getCandles).mockImplementation(async (_address, interval, options) => {
      if (options?.to === undefined) return snapshot(tokenA, interval);
      olderPages += 1;
      return olderPages === 1
        ? { ...snapshot(tokenA, interval, []), syncStatus: 'BACKFILLING' }
        : snapshot(tokenA, interval, [candle(50, '1')]);
    });
    render(<App />); await screen.findByLabelText('AAA K 线图');
    await act(async () => expect(await chart.current!.onLoadBefore(99)).toEqual({ added: 0, exhausted: false }));
    await act(async () => expect(await chart.current!.onLoadBefore(99)).toEqual({ added: 1, exhausted: false }));
    expect(olderPages).toBe(2);
    expect(chart.current!.candles.map((item) => item.t)).toEqual([50, 100]);
  });
  it('rejects pages outside the requested upper boundary and permits retry', async () => {
    setup('MAIN_ACCOUNT_POC');
    render(<App />); await screen.findByLabelText('AAA K 线图');
    await act(async () => { await expect(chart.current!.onLoadBefore(99)).rejects.toThrow('请求范围'); });
    expect(chart.current!.candles.map((item) => item.t)).toEqual([100]);
    vi.mocked(memeApi.getCandles).mockResolvedValue(snapshot(tokenA, '1m', [candle(50, '1')]));
    await act(async () => expect(await chart.current!.onLoadBefore(99)).toEqual({ added: 1, exhausted: false }));
  });
});

it('cancels a settled-order status timer when the account component unmounts', async () => {
  setup('AZ_ACCOUNT');
  const timer = vi.spyOn(window, 'setTimeout'), clear = vi.spyOn(window, 'clearTimeout');
  const { unmount } = render(<App />);
  await waitFor(() => expect(document.querySelector('button.primary')).toBeEnabled());
  fireEvent.click(document.querySelector('button.primary')!);
  await screen.findByText('交易成功');
  const index = timer.mock.calls.findIndex(([, delay]) => delay === 3000);
  expect(index).toBeGreaterThanOrEqual(0);
  const id = timer.mock.results[index]!.value;
  unmount();
  expect(clear).toHaveBeenCalledWith(id);
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('hotfix: bounded account bootstrap and empty demand', () => {
  afterEach(() => { cleanup(); setSessionToken(null); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  async function mount() { await act(async () => { render(<App />); }); }

  it.each(['AZ_ACCOUNT', 'MAIN_ACCOUNT_POC'] as const)('bounds the entire %s attempt and permits a fresh retry', async (mode) => {
    setup(mode);
    vi.useFakeTimers();
    vi.mocked(memeApi.getAccount).mockImplementationOnce(() => new Promise(() => {}));
    await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(screen.getByRole('alert')).toHaveTextContent('账户连接超时');
    expect(vi.mocked(memeApi.getAccount).mock.calls[0]?.[0]?.aborted).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '重试账户连接' }));
    await act(async () => {});
    expect(document.querySelector('.mock-badge')).toHaveTextContent(mode === 'AZ_ACCOUNT' ? '已登录' : '主账户已连接');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each(['fetch', 'body'] as const)('settles real MAIN_ACCOUNT_POC %s timeout without mock login', async (stage) => {
    setup('MAIN_ACCOUNT_POC');
    vi.mocked(memeApi.getAccount).mockRestore();
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => stage === 'fetch' ? new Promise(() => {})
      : Promise.resolve({ status: 200, ok: true, text: () => new Promise(() => {}) })));
    await mount();
    expect(document.querySelector('.mock-badge')).toHaveTextContent('主账户连接中');
    expect(document.querySelector('button.primary')).toHaveTextContent('等待主账户');
    expect(azAuth.loginMock).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.getByRole('alert')).toHaveTextContent('超时');
    expect(screen.getByRole('button', { name: '重试账户连接' })).toBeEnabled();
    expect(document.querySelector('.balances')).toHaveTextContent('账户不可用');
    expect(document.querySelector('button.primary')).toBeDisabled();
  });

  it.each(['success', 'failure'] as const)('aborts an old attempt and ignores its late %s after retry succeeds', async (outcome) => {
    setup('MAIN_ACCOUNT_POC');
    const old = deferred<typeof summary>();
    vi.mocked(memeApi.getAccount).mockReturnValueOnce(old.promise);
    vi.mocked(memeApi.getOrders).mockRejectedValueOnce(new ApiError('PROXY_DOWN', 'proxy unavailable', 502));
    await mount();
    const signal = vi.mocked(memeApi.getAccount).mock.calls[0]?.[0];
    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 502');
    fireEvent.click(screen.getByRole('button', { name: '重试账户连接' }));
    await act(async () => {});
    expect(signal?.aborted).toBe(true);
    expect(document.querySelector('.balances')).toHaveTextContent('10 ETH');
    await act(async () => {
      if (outcome === 'success') old.resolve({ ...summary, quoteBalances: [{ asset: 'ETH', available: '999', frozen: '0' }] });
      else old.reject(new SyntaxError('Unexpected end of JSON input'));
    });
    expect(document.querySelector('.balances')).toHaveTextContent('10 ETH');
    expect(document.querySelector('.balances')).not.toHaveTextContent('999');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(azAuth.loginMock).not.toHaveBeenCalled();
  });

  it('cancels account requests on unmount without late follow-up requests', async () => {
    setup('AZ_ACCOUNT');
    const login = deferred<typeof auth>();
    vi.mocked(azAuth.loginMock).mockReturnValue(login.promise);
    const view = render(<App />);
    await act(async () => {});
    const signal = vi.mocked(azAuth.loginMock).mock.calls[0]?.[0];
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => login.resolve(auth));
    expect(memeApi.getAccount).not.toHaveBeenCalled();
  });

  it('renders a human-readable parse failure without exposing SyntaxError', async () => {
    setup('AZ_ACCOUNT');
    vi.mocked(azAuth.loginMock).mockRejectedValue(new SyntaxError('Unexpected end of JSON input'));
    await mount();
    expect(screen.getByRole('alert')).not.toHaveTextContent('Unexpected end');
    expect(screen.getByRole('alert')).toHaveTextContent('响应');
  });

  it.each(['CATCHING_UP', 'BACKFILLING'] as const)('shows %s catch-up status while keeping committed candles through refresh retries', async (syncStatus) => {
    setup('MAIN_ACCOUNT_POC');
    vi.useFakeTimers();
    const items = Array.from({ length: 320 }, (_, index) => candle(100 + index, '11'));
    const committed = { ...snapshot(tokenA, '1s', items), syncStatus, availability: 'PARTIAL' as const };
    vi.mocked(memeApi.getCandles).mockImplementation(async (_address, interval) => ({ ...committed, interval }));
    await mount();
    fireEvent.click(screen.getByRole('button', { name: '1s' }));
    await act(async () => {});
    vi.mocked(memeApi.getCandles).mockClear();
    const canvas = screen.getByLabelText('AAA K 线图');
    for (const elapsed of [0, 2_000, 4_000, 8_000, 16_000, 60_000, 60_000]) {
      await act(async () => { await vi.advanceTimersByTimeAsync(elapsed); });
      expect(screen.getByLabelText('AAA K 线图')).toBe(canvas);
      expect(chart.current!.candles).toEqual(items);
      expect(screen.getByRole('status',{name:'行情状态'})).toHaveTextContent('行情追赶中');
      expect(document.body).not.toHaveTextContent(/BACKFILLING|CATCHING_UP|历史 K 线部分缺失/);
      expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
    }
    expect(vi.mocked(memeApi.getCandles).mock.calls.length).toBeGreaterThan(4);
    expect(vi.mocked(memeApi.getCandles).mock.calls.length).toBeLessThanOrEqual(9);
    expect(vi.mocked(memeApi.getCandles).mock.calls.every(([, interval]) => interval === '1s')).toBe(true);
  });

  it('refetches empty BACKFILLING/PARTIAL demand and clears pending metadata when complete', async () => {
    setup('MAIN_ACCOUNT_POC');
    vi.useFakeTimers();
    vi.mocked(memeApi.getCandles).mockResolvedValueOnce({ ...snapshot(tokenA, '1m', []),
      syncStatus: 'BACKFILLING', availability: 'PARTIAL', gaps: [] });
    await mount();
    expect(screen.getByRole('status',{name:'行情状态'})).toHaveTextContent('行情追赶中');
    expect(screen.queryByText('暂无成交 K 线')).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(memeApi.getCandles).toHaveBeenCalledTimes(2);
    expect(chart.current!.candles).toEqual([candle(100, '11')]);
    expect(screen.queryByText(/历史 K 线部分缺失/)).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(memeApi.getCandles).toHaveBeenCalledTimes(2);
  });

  it.each(['BACKFILLING', 'READY'] as const)('caps the retry cadence of empty %s/PARTIAL and respects terminal READY', async (syncStatus) => {
    setup('MAIN_ACCOUNT_POC');
    vi.useFakeTimers();
    vi.mocked(memeApi.getCandles).mockResolvedValue({ ...snapshot(tokenA, '1m', []), syncStatus, availability: 'PARTIAL' });
    await mount();
    expect(screen.getByRole('status',{name:'行情状态'})).toHaveTextContent(syncStatus==='BACKFILLING'?'行情追赶中':'暂无可用行情');
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    const reads = vi.mocked(memeApi.getCandles).mock.calls.length;
    expect(reads).toBe(syncStatus === 'READY' ? 1 : 6);
    expect(screen.queryByText(/已停止自动刷新/)).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(memeApi.getCandles).toHaveBeenCalledTimes(syncStatus === 'READY' ? reads : reads + 2);
  });

  it.each(['STALE', 'FAILED'] as const)('shows %s as an actionable failure and retry with empty or committed candles', async (syncStatus) => {
    setup('MAIN_ACCOUNT_POC');
    vi.mocked(memeApi.getCandles).mockResolvedValueOnce({ ...snapshot(tokenA, '1m', []), syncStatus, availability: 'PARTIAL' })
      .mockResolvedValue({ ...snapshot(tokenA), syncStatus, availability: 'PARTIAL' });
    await mount();
    expect(screen.getByRole('status')).toHaveTextContent('行情暂时不可用');
    expect(screen.getByRole('status')).toHaveTextContent('请稍后重试');
    expect(screen.getByRole('button', { name: '重试' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await act(async () => {});
    expect(chart.current!.candles).toEqual([candle(100, '11')]);
    expect(screen.getByRole('status')).toHaveTextContent('行情暂时不可用');
    expect(screen.getByRole('button', { name: '重试' })).toBeEnabled();
  });

  it('keeps pending demand alive when the first expected WS candle arrives without inventing completion', async () => {
    setup('MAIN_ACCOUNT_POC', true);
    vi.useFakeTimers();
    vi.mocked(memeApi.getCandles).mockResolvedValue({ ...snapshot(tokenA, '1m', []),
      syncStatus: 'CATCHING_UP', availability: 'PARTIAL' });
    await mount();
    const socket = ControlledSocket.instances.at(-1)!;
    act(() => socket.open());
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    const warning = '历史 K 线仍未就绪，已停止自动刷新，请重试';
    expect(memeApi.getCandles).toHaveBeenCalledTimes(6);
    expect(chart.current!.candles).toEqual([]);
    expect(screen.queryByText(warning)).not.toBeInTheDocument();
    act(() => {
      socket.receive({ channel: `candle:${tokenB.tokenAddress}:USD:USDG:1m`, epoch: 'live', sequence: 1,
        data: candle(100, '22') });
      socket.receive({ channel: `candle:${tokenA.tokenAddress}:USD:USDG:1m`, epoch: 'live', sequence: 1,
        data: { items: [] } });
    });
    expect(chart.current!.candles).toEqual([]);
    expect(screen.queryByText(warning)).not.toBeInTheDocument();
    act(() => socket.receive({ channel: `candle:${tokenA.tokenAddress}:USD:USDG:1m`, epoch: 'live', sequence: 2,
      data: candle(100, '11') }));
    expect(chart.current!.candles).toEqual([candle(100, '11')]);
    expect(screen.queryByText(warning)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(memeApi.getCandles).toHaveBeenCalledTimes(10);
  });

  it('keeps a real network exception during metadata refresh after a valid WS candle arrives', async () => {
    setup('MAIN_ACCOUNT_POC', true);
    vi.useFakeTimers();
    vi.mocked(memeApi.getCandles).mockResolvedValueOnce({ ...snapshot(tokenA), syncStatus: 'CATCHING_UP' })
      .mockRejectedValue(new ApiError('MEME_PROVIDER_ERROR', 'actual candle network failure', 503));
    await mount();
    const socket = ControlledSocket.instances.at(-1)!;
    act(() => socket.open());
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(chart.current!.candles).toEqual([candle(100, '11')]);
    const error = screen.getByText(/actual candle network failure/).textContent;
    act(() => socket.receive({ channel: `candle:${tokenA.tokenAddress}:USD:USDG:1m`, epoch: 'live', sequence: 1,
      data: candle(101, '12') }));
    expect(chart.current!.candles).toEqual([candle(100, '11'), candle(101, '12')]);
    expect(screen.getByText(/actual candle network failure/)).toHaveTextContent(error!);
    expect(screen.getByRole('button', { name: '重试' })).toBeEnabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(memeApi.getCandles).toHaveBeenCalledTimes(2);
  });

  it('aborts pending candle refresh on unmount', async () => {
    setup('MAIN_ACCOUNT_POC');
    vi.useFakeTimers();
    vi.mocked(memeApi.getCandles).mockResolvedValue({ ...snapshot(tokenA, '1m', []), syncStatus: 'BACKFILLING', availability: 'PARTIAL' });
    const view = render(<App />);
    await act(async () => {});
    const signal = vi.mocked(memeApi.getCandles).mock.calls[0]?.[2]?.signal;
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(memeApi.getCandles).toHaveBeenCalledTimes(1);
  });
});
