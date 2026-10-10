import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';
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
    expect(screen.getByRole('status')).toHaveTextContent('历史 K 线部分缺失');
    await act(async () => { expect(await chart.current!.onLoadBefore(99)).toEqual({ added: 1, exhausted: false }); });
    expect(chart.current!.candles.map((item) => item.t)).toEqual([50, 100]);
    expect(screen.getByRole('status')).toHaveTextContent('成交已过保留期');
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
    let loading!: Promise<HistoryLoadResult>;
    act(() => { loading = chart.current!.onLoadBefore(99); });
    expect(memeApi.getCandles).toHaveBeenLastCalledWith(tokenA.tokenAddress, '1m', { to: 99, limit: 300 });
    if (change === 'interval change') {
      fireEvent.click(screen.getByRole('button', { name: '15m' }));
      await waitFor(() => expect(memeApi.getCandles).toHaveBeenLastCalledWith(tokenA.tokenAddress, '15m'));
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
    expect(memeApi.getCandles).toHaveBeenLastCalledWith(tokenA.tokenAddress, '1m', { to: 99, limit: 300 });
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
