import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { setSessionToken } from './api';
import type { Candle, CandleSnapshot, Token, Trade } from './types';

const engine = vi.hoisted(() => ({ create: vi.fn(), fit: vi.fn(), restore: vi.fn(), candleData: vi.fn(),
  range: { from: 0, to: 30 }, visible: null as null | ((range: { from: number; to: number }) => void) }));
vi.mock('lightweight-charts', () => ({
  CandlestickSeries: 'Candlestick', HistogramSeries: 'Histogram',
  ColorType: { Solid: 'solid' }, CrosshairMode: { Normal: 0 },
  createChart: (...args: unknown[]) => {
    engine.create(...args);
    return { addSeries: (series: unknown) => ({ setData: series === 'Candlestick' ? engine.candleData : vi.fn(), update: vi.fn(), priceScale: () => ({ applyOptions: vi.fn() }) }),
      applyOptions: vi.fn(), remove: vi.fn(), timeScale: () => ({ fitContent: engine.fit,
        getVisibleLogicalRange: () => engine.range, setVisibleLogicalRange: engine.restore,
        subscribeVisibleLogicalRangeChange: (handler: typeof engine.visible) => { engine.visible = handler; },
        unsubscribeVisibleLogicalRangeChange: vi.fn() }) };
  },
}));

const token: Token = { chainId: 4663, tokenAddress: `0x${'1'.repeat(40)}`, symbol: 'ORBANCY', name: 'Orbancy',
  launchpad: 'PONS', stage: 'GRADUATED', quoteAssetKey: 'NATIVE', priceQuote: '11', priceUsd: '11',
  marketCapUsd: '1000', volume24hUsd: '100', change5m: '1', change24h: '2', holders: 10, ageSeconds: 60,
  pool: { poolKey: 'pool-a', poolType: 'UNISWAP_V4', liquidityUsd: '1000' }, tradeStatus: 'TRADABLE', riskFlags: [],
  security: { isHoneypot: false, buyTaxPct: '0', sellTaxPct: '0', liquidityLocked: true, liquidityLockedPct: '100', liquidityBurnedPct: '0' } };
const other = { ...token, tokenAddress: `0x${'2'.repeat(40)}`, symbol: 'OTHER' };
const candle = (t: number): Candle => ({ t, o: '11', h: '11', l: '11', c: '11', baseVolume: '1', quoteVolume: '1', revision: '1' });
const trade = (id: string, t: number, price = '11'): Trade => ({ tradeId: id, t, side: 'BUY', priceUsd: price,
  baseAmount: '1', quoteAmount: '1', quoteAsset: 'USDG', trader: `0x${'3'.repeat(40)}`, txHash: `0x${'4'.repeat(64)}` });
function snapshot(address: string, interval: CandleSnapshot['interval'], items = [candle(1000)]): CandleSnapshot {
  return { chainId: 4663, tokenAddress: address, marketKey: 'USD:USDG', interval, syncStatus: 'READY',
    availability: 'COMPLETE', coverage: { from: items[0]?.t ?? null, to: items.at(-1)?.t ?? null },
    gaps: [], revision: '1', asOfBlock: 100, source: 'CHAIN', items };
}
const envelope = (result: unknown) => new Response(JSON.stringify({ rc: 0, result }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  delayedClose = false;
  sent: string[] = [];
  listeners = new Map<string, Array<(event: Event) => void>>();
  constructor(_url: string) { Socket.instances.push(this); }
  addEventListener(name: string, listener: (event: Event) => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
  emit(name: string, event: Event) { for (const listener of this.listeners.get(name) ?? []) listener(event); }
  open() { this.readyState = 1; this.emit('open', new Event('open')); }
  receive(data: unknown) { this.emit('message', { data: JSON.stringify(data) } as MessageEvent); }
  send(data: string) { this.sent.push(data); }
  close() { if (this.readyState >= 2) return; this.readyState = this.delayedClose ? 2 : 3; if (!this.delayedClose) this.emit('close', new Event('close')); }
}

describe('public market resume and sparse retained history through actual App and CandleChart', () => {
  let hidden = false;
  let mode: 'AZ_ACCOUNT' | 'MAIN_ACCOUNT_POC';
  let candles: (url: URL, signal: AbortSignal) => Promise<Response>;
  let trades: (url: URL, signal: AbortSignal) => Promise<Response>;
  let ticket: (signal: AbortSignal) => Promise<Response>;
  let fetchMock: ReturnType<typeof vi.fn>;
  const calls = (part: string) => fetchMock.mock.calls.filter(([url]) => String(url).includes(part));
  const headCalls = () => calls('/candles').filter(([url]) => !new URL(String(url)).searchParams.has('to'));
  const show = () => { hidden = false; document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('pageshow')); };
  const hide = () => { hidden = true; document.dispatchEvent(new Event('visibilitychange')); };
  const mount = async () => { const view = render(<App />); await act(async () => {}); return view; };
  const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
  const open = () => { const socket = Socket.instances.at(-1)!; act(() => socket.open()); return socket; };
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks(); Socket.instances = []; mode = 'MAIN_ACCOUNT_POC'; hidden = false;
    engine.range = { from: 0, to: 30 };
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => hidden ? 'hidden' : 'visible');
    vi.stubGlobal('WebSocket', Socket);
    candles = async (url) => envelope(snapshot(url.pathname.split('/')[5]!, url.searchParams.get('interval') as CandleSnapshot['interval'],
      url.searchParams.has('to') ? [] : [candle(1000)]));
    trades = async (url) => envelope({ items: [trade(url.searchParams.has('cursor') ? 'older' : 'initial', 1000)], nextCursor: 'older-cursor' });
    ticket = async () => envelope({ ticket: 'public-ticket', expiresAt: Date.now() + 30_000 });
    fetchMock = vi.fn(async (input: string, init: RequestInit) => {
      const url = new URL(input), signal = init.signal as AbortSignal;
      if (url.pathname.endsWith('/config')) return envelope({ chainId: 4663, chainName: 'Test', explorerBaseUrl: '', defaultSlippageBps: 300,
        marketRefreshMs: { hot: 14_400_000, new: 300_000 }, accountMode: mode, settlementAssets: ['USDG', 'ETH'] });
      if (url.pathname.endsWith('/markets')) return envelope({ items: [token, other], stale: false });
      if (url.pathname.endsWith('/candles')) return candles(url, signal);
      if (url.pathname.endsWith('/trades')) return trades(url, signal);
      if (url.pathname.endsWith('/ws-ticket')) return ticket(signal);
      if (url.pathname.includes('/tokens/')) return envelope(url.pathname.endsWith(token.tokenAddress) ? token : other);
      if (url.pathname.endsWith('/get-nonce')) return new Response(JSON.stringify({ rc: 1, mc: 'AZ_REQUEST_FAILED', ma: ['auth upstream absent'] }), { status: 502 });
      if (url.pathname.endsWith('/account/summary')) return envelope({ quoteBalances: [], positions: [] });
      if (url.pathname.endsWith('/account/transactions')) return envelope({ items: [] });
      if (url.pathname.endsWith('/orders')) return envelope({ items: [], nextCursor: null });
      if (url.pathname.endsWith('/quotes')) return envelope({ ...JSON.parse(String(init.body)), quoteId: 'q', expectedAmountOut: '1', minAmountOut: '1', fees: [], expiresAt: Date.now() + 60_000 });
      throw new Error(`Unexpected request ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { cleanup(); setSessionToken(null); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each([{ history: true }, { correction: true }, { history: true, correction: true }])(
    'historical pricing repair: merges flagged trades without flashing (%j)', async (flags) => {
      await mount(); const socket = open();
      const channel = `trade:${token.tokenAddress}:USD:USDG`;
      act(() => socket.receive({ channel, epoch: 'live', sequence: 1, data: { items: [trade('latest-live', 1100, '33')] } }));
      expect(screen.getByText('$33').closest('.trade-row')).toHaveClass('trade-flash');
      await advance(700);
      act(() => socket.receive({ channel, epoch: 'live', sequence: 2, data: { items: [
        { ...trade('old-repaired', 900, '55'), ...flags },
        { ...trade('initial', 1000, '22'), ...flags },
      ] } }));
      expect(screen.getAllByTestId('trade-price')).toHaveLength(3);
      expect(screen.getByText('$22').closest('.trade-row')).not.toHaveClass('trade-flash');
      expect(screen.getAllByTestId('trade-price').map((element) => element.textContent)).toEqual(['$33', '$22', '$55']);
      expect(screen.getByText('$55').closest('.trade-row')).not.toHaveClass('trade-flash');
      expect(screen.getByText('$33')).toBeInTheDocument();
      expect(document.querySelectorAll('.trade-flash')).toHaveLength(0);
      act(() => socket.receive({ channel, epoch: 'live', sequence: 3, data: { items: [trade('next-live', 1101, '66')] } }));
      expect(screen.getByText('$66').closest('.trade-row')).toHaveClass('trade-flash');
      expect(calls('/trades')).toHaveLength(1);
    },
  );

  it('historical pricing repair: flashes genuine live items in an interleaved ordinary batch', async () => {
    await mount(); const socket = open();
    act(() => socket.receive({ channel: `trade:${token.tokenAddress}:USD:USDG`, epoch: 'live', sequence: 1, data: { items: [
      { ...trade('history', 900, '22'), history: true, correction: true },
      trade('live-a', 1100, '33'),
      { ...trade('correction', 950, '44'), correction: true },
      trade('live-b', 1101, '55'),
      { ...trade('trailing-history', 800, '66'), history: true, correction: true },
    ] } }));
    expect(screen.getAllByTestId('trade-price').map((element) => element.textContent)).toEqual(['$55', '$33', '$11', '$44', '$22', '$66']);
    expect(screen.getByText('$33').closest('.trade-row')).toHaveClass('trade-flash');
    expect(screen.getByText('$55').closest('.trade-row')).toHaveClass('trade-flash');
    for (const price of ['$22', '$44', '$66']) expect(screen.getByText(price).closest('.trade-row')).not.toHaveClass('trade-flash');
    expect(document.querySelectorAll('.trade-flash')).toHaveLength(2);
    await advance(700);
    expect(document.querySelectorAll('.trade-flash')).toHaveLength(0);
  });

  it('historical pricing repair: false item flags still allow an ordinary live flash', async () => {
    await mount(); const socket = open();
    act(() => socket.receive({ channel: `trade:${token.tokenAddress}:USD:USDG`, epoch: 'live', sequence: 1, data: { items: [
      { ...trade('live', 1100, '33'), history: false, correction: false },
    ] } }));
    expect(screen.getByText('$33').closest('.trade-row')).toHaveClass('trade-flash');
  });

  it('historical repair blocker: historical rows cannot displace the newest tape row', async () => {
    await mount(); const socket = open(); const channel = `trade:${token.tokenAddress}:USD:USDG`;
    act(() => socket.receive({ channel, epoch: 'live', sequence: 1, data: { items: [trade('newest', 1100, '33')] } }));
    act(() => socket.receive({ channel, epoch: 'live', sequence: 2, data: { items: [
      { ...trade('initial', 1000, '22'), history: true, correction: true },
      { ...trade('old', 900, '55'), history: true, correction: true },
    ] } }));
    expect(screen.getAllByTestId('trade-price').map((item) => item.textContent)).toEqual(['$33', '$22', '$55']);
    expect(screen.getByText('$33').closest('.trade-row')).toHaveClass('trade-flash');
    expect(screen.getByText('$22').closest('.trade-row')).not.toHaveClass('trade-flash');
    expect(screen.getByText('$55').closest('.trade-row')).not.toHaveClass('trade-flash');
  });

  it('historical repair blocker: delayed initial GET retains stream repairs and newer rows', async () => {
    const gate = deferred<Response>(); trades = () => gate.promise;
    await mount(); const socket = open(); const channel = `trade:${token.tokenAddress}:USD:USDG`;
    act(() => socket.receive({ channel, epoch: 'live', sequence: 1, data: { items: [
      { ...trade('initial', 1000, '22'), history: true, correction: true },
    ] } }));
    act(() => socket.receive({ channel, epoch: 'live', sequence: 2, data: { items: [trade('newest', 1100, '33')] } }));
    await act(async () => gate.resolve(envelope({ items: [trade('initial', 1000, '11')], nextCursor: null })));
    expect(screen.getAllByTestId('trade-price').map((item) => item.textContent)).toEqual(['$33', '$22']);
    expect(screen.getByText('$33').closest('.trade-row')).toHaveClass('trade-flash');
    expect(screen.getByText('$22').closest('.trade-row')).not.toHaveClass('trade-flash');
  });

  it.each([false, true])('trade request baseline: initial revisit refreshes cached IDs and protects only subsequent WS changes (race=%s)', async (race) => {
    await mount(); const socket = open(); const channel = `trade:${token.tokenAddress}:USD:USDG`;
    act(() => socket.receive({ channel, epoch: 'live', sequence: 1, data: { items: [
      { ...trade('initial', 1000, '17'), history: true },
    ] } }));
    fireEvent.click(screen.getByRole('button', { name: '查看 OTHER' })); await act(async () => {}); open();
    const gate = deferred<Response>(); trades = () => gate.promise;
    fireEvent.click(screen.getByRole('button', { name: '查看 ORBANCY' })); await act(async () => {});
    const revisited = open();
    if (race) act(() => revisited.receive({ channel, epoch: 'revisited', sequence: 1, data: { items: [
      { ...trade('initial', 1000, '44'), correction: true }, trade('newest', 1100, '55'),
    ] } }));
    await act(async () => gate.resolve(envelope({ items: [
      trade('older', 900, '66'), trade('initial', 1000, '22'), trade('newest', 1100, '33'),
    ], nextCursor: null })));
    expect(screen.getAllByTestId('trade-price').map((item) => item.textContent)).toEqual(race
      ? ['$55', '$44', '$66'] : ['$33', '$22', '$66']);
    expect(document.querySelectorAll('.trade-flash')).toHaveLength(race ? 1 : 0);
  });

  const triggerTradeRecovery = async (trigger: 'focus' | 'gap' | 'reconnect', socket: Socket) => {
    if (trigger === 'focus') await act(async () => window.dispatchEvent(new Event('focus')));
    else if (trigger === 'gap') await act(async () => socket.receive({ channel: `trade:${token.tokenAddress}:USD:USDG`,
      epoch: 'live', sequence: 3, data: { items: [] } }));
    else { act(() => socket.close()); await advance(1_000); open(); await act(async () => {}); }
    return Socket.instances.at(-1)!;
  };

  it.each(['focus', 'gap', 'reconnect'] as const)('historical repair blocker: %s GET refreshes a missed repair on a cached ID', async (trigger) => {
    await mount(); const socket = open();
    act(() => socket.receive({ channel: `trade:${token.tokenAddress}:USD:USDG`, epoch: 'live', sequence: 1, data: { items: [] } }));
    trades = async () => envelope({ items: [trade('initial', 1000, '22')], nextCursor: null });
    await triggerTradeRecovery(trigger, socket);
    expect(screen.getAllByTestId('trade-price').map((item) => item.textContent)).toEqual(['$22']);
    expect(document.querySelectorAll('.trade-flash')).toHaveLength(0);
  });

  it.each(['focus', 'gap', 'reconnect'] as const)('trade request baseline: %s GET may refresh a WS change received before the request', async (trigger) => {
    await mount(); const socket = open();
    act(() => socket.receive({ channel: `trade:${token.tokenAddress}:USD:USDG`, epoch: 'live', sequence: 1, data: { items: [
      { ...trade('initial', 1000, '17'), history: true, correction: true },
    ] } }));
    trades = async () => envelope({ items: [trade('initial', 1000, '22')], nextCursor: null });
    await triggerTradeRecovery(trigger, socket);
    expect(screen.getAllByTestId('trade-price').map((item) => item.textContent)).toEqual(['$22']);
    expect(document.querySelectorAll('.trade-flash')).toHaveLength(0);
  });

  it.each(['focus', 'gap', 'reconnect'] as const)('trade request baseline: delayed %s GET refreshes unchanged IDs and preserves subsequent WS replacements/additions', async (trigger) => {
    trades = async () => envelope({ items: [trade('initial', 1000), trade('unchanged', 950, '10')], nextCursor: null });
    await mount(); const socket = open();
    act(() => socket.receive({ channel: `trade:${token.tokenAddress}:USD:USDG`, epoch: 'live', sequence: 1, data: { items: [] } }));
    const gate = deferred<Response>(); trades = () => gate.promise;
    const active = await triggerTradeRecovery(trigger, socket);
    expect(calls('/trades')).toHaveLength(2);
    act(() => active.receive({ channel: `trade:${token.tokenAddress}:USD:USDG`, epoch: 'live', sequence: trigger === 'gap' ? 4 : 2, data: { items: [
      { ...trade('initial', 1000, '44'), history: true, correction: true }, trade('newest', 1100, '55'),
    ] } }));
    await act(async () => gate.resolve(envelope({ items: [
      trade('older', 900, '77'), trade('initial', 1000, '22'), trade('unchanged', 950, '66'), trade('newest', 1100, '33'),
    ], nextCursor: null })));
    expect(screen.getAllByTestId('trade-price').map((item) => item.textContent)).toEqual(['$55', '$44', '$66', '$77']);
    expect(screen.getByText('$44').closest('.trade-row')).not.toHaveClass('trade-flash');
    expect(screen.getByText('$66').closest('.trade-row')).not.toHaveClass('trade-flash');
    expect(screen.getByText('$77').closest('.trade-row')).not.toHaveClass('trade-flash');
    expect(screen.getByText('$55').closest('.trade-row')).toHaveClass('trade-flash');
  });

  it('historical repair blocker: pause retains its view while repaired cache resumes in time order', async () => {
    await mount(); const socket = open(); const channel = `trade:${token.tokenAddress}:USD:USDG`;
    act(() => socket.receive({ channel, epoch: 'live', sequence: 1, data: { items: [trade('newest', 1100, '33')] } }));
    fireEvent.click(screen.getByRole('button', { name: '暂停' }));
    act(() => socket.receive({ channel, epoch: 'live', sequence: 2, data: { items: [
      { ...trade('old', 900, '55'), history: true }, { ...trade('initial', 1000, '22'), correction: true },
    ] } }));
    expect(screen.getAllByTestId('trade-price').map((item) => item.textContent)).toEqual(['$33', '$11']);
    expect(document.querySelectorAll('.trade-flash')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(screen.getAllByTestId('trade-price').map((item) => item.textContent)).toEqual(['$33', '$22', '$55']);
    expect(document.querySelectorAll('.trade-flash')).toHaveLength(0);
  });

  it('historical repair blocker: repeated WS IDs use the last item and corrected event time', async () => {
    await mount(); const socket = open();
    act(() => socket.receive({ channel: `trade:${token.tokenAddress}:USD:USDG`, epoch: 'live', sequence: 1, data: { items: [
      { ...trade('initial', 900, '22'), history: true }, trade('newest', 1100, '33'),
      { ...trade('initial', 1200, '44'), correction: true },
    ] } }));
    expect(screen.getAllByTestId('trade-price').map((item) => item.textContent)).toEqual(['$44', '$33']);
    expect(screen.getByText('$33').closest('.trade-row')).toHaveClass('trade-flash');
    expect(screen.getByText('$44').closest('.trade-row')).not.toHaveClass('trade-flash');
  });

  it('historical pricing repair: candle batches retain time order and reject older revisions without remounting', async () => {
    await mount(); const socket = open();
    const chart = screen.getByTestId('tradingview-chart');
    const channel = `candle:${token.tokenAddress}:USD:USDG:1m`;
    const repaired = (t: number, price: string, revision: string) => ({ ...candle(t), o: price, h: price, l: price, c: price,
      revision, history: true, correction: true });
    act(() => socket.receive({ channel, epoch: 'live', sequence: 1, data: { items: [
      repaired(1000, '22', '3'), repaired(900, '44', '3'),
    ] } }));
    expect(chart).toHaveAttribute('data-candle-count', '2');
    expect(chart).toHaveAttribute('data-first-candle-time', '900');
    expect(engine.candleData).toHaveBeenLastCalledWith([
      expect.objectContaining({ time: 900, close: 44 }), expect.objectContaining({ time: 1000, close: 22 }),
    ]);
    act(() => socket.receive({ channel, epoch: 'live', sequence: 2, data: { items: [
      repaired(900, '77', '2'), repaired(1000, '88', '2'),
    ] } }));
    expect(engine.candleData).toHaveBeenLastCalledWith([
      expect.objectContaining({ time: 900, close: 44 }), expect.objectContaining({ time: 1000, close: 22 }),
    ]);
    expect(screen.getByTestId('tradingview-chart')).toBe(chart);
    expect(engine.create).toHaveBeenCalledTimes(1);
    expect(engine.fit).toHaveBeenCalledTimes(1);
    expect(headCalls()).toHaveLength(1);
  });

  it.each(['focus', 'gap'] as const)('review blocker: shares delayed READY-cached head with %s recovery and selection owns abort', async (trigger) => {
    await mount(); open();
    fireEvent.click(screen.getByRole('button', { name: '查看 OTHER' })); await act(async () => {});
    const gate = deferred<Response>(); let ownedSignal!: AbortSignal;
    candles = (url, signal) => url.pathname.includes(token.tokenAddress)
      ? (ownedSignal = signal, gate.promise)
      : Promise.resolve(envelope(snapshot(other.tokenAddress, '1m')));
    const before = headCalls().length;
    fireEvent.click(screen.getByRole('button', { name: '查看 ORBANCY' })); await act(async () => {});
    const socket = open();
    await act(async () => {
      if (trigger === 'focus') window.dispatchEvent(new Event('focus'));
      else {
        socket.receive({ channel: `candle:${token.tokenAddress}:USD:USDG:1m`, epoch: 'live', sequence: 1, data: candle(1001) });
        socket.receive({ channel: `candle:${token.tokenAddress}:USD:USDG:1m`, epoch: 'live', sequence: 3, data: candle(1003) });
      }
    });
    const count = headCalls().length - before;
    if (trigger === 'focus') await advance(10_000);
    expect(ownedSignal.aborted).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '查看 OTHER' })); await act(async () => {});
    expect(ownedSignal.aborted).toBe(true);
    await act(async () => gate.resolve(envelope(snapshot(token.tokenAddress, '1m', [candle(9)]))));
    expect(screen.getByTestId('tradingview-chart')).toHaveAttribute('data-first-candle-time', '1000');
    expect(count).toBe(1);
  });

  it.each(['focus', 'gap'] as const)('review blocker: shares a delayed pending poll with %s recovery', async (trigger) => {
    candles = async () => envelope({ ...snapshot(token.tokenAddress, '1m', Array.from({ length: 40 }, (_, i) => candle(1000 + i))), syncStatus: 'CATCHING_UP' });
    await mount(); const socket = open();
    const gate = deferred<Response>(); candles = () => gate.promise;
    const before = headCalls().length; await advance(2000);
    await act(async () => {
      if (trigger === 'focus') window.dispatchEvent(new Event('focus'));
      else {
        socket.receive({ channel: `candle:${token.tokenAddress}:USD:USDG:1m`, epoch: 'live', sequence: 1, data: candle(1041) });
        socket.receive({ channel: `candle:${token.tokenAddress}:USD:USDG:1m`, epoch: 'live', sequence: 3, data: candle(1043) });
      }
    });
    const count = headCalls().length - before;
    await act(async () => gate.resolve(envelope(snapshot(token.tokenAddress, '1m', [candle(1040)]))));
    await advance(30_000);
    expect(count).toBe(1); expect(headCalls().length - before).toBe(1);
    expect(screen.getByTestId('tradingview-chart')).toHaveAttribute('data-candle-count', trigger === 'gap' ? '43' : '41');
  });

  it.each(['older-cursor', null])('review blocker: fills more than 100 missed trades with fresh cursor while retaining history (%s)', async (oldCursor) => {
    trades = async (url) => envelope({ items: [url.searchParams.has('cursor') ? trade('loaded-old', 900, '10') : trade('cached', 1000, '12')], nextCursor: oldCursor });
    await mount(); open();
    if (oldCursor) { fireEvent.scroll(document.querySelector('.trade-rows')!); await act(async () => {}); }
    trades = async (url) => envelope(url.searchParams.has('cursor')
      ? { items: Array.from({ length: 50 }, (_, i) => trade(`gap-${i}`, 1050 - i, '14')), nextCursor: null }
      : { items: Array.from({ length: 100 }, (_, i) => trade(`fresh-${i}`, 1150 - i, '13')), nextCursor: 'fresh-gap-cursor' });
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(screen.getByText('$12')).toBeInTheDocument();
    expect(screen.getAllByTestId('trade-price')).toHaveLength(oldCursor ? 102 : 101);
    expect(document.querySelectorAll('.trade-flash')).toHaveLength(0);
    fireEvent.scroll(document.querySelector('.trade-rows')!); await act(async () => {});
    expect(String(calls('/trades').at(-1)![0])).toContain('cursor=fresh-gap-cursor');
    expect(screen.getAllByTestId('trade-price')).toHaveLength(oldCursor ? 152 : 151);
    if (oldCursor) expect(screen.getByText('$10')).toBeInTheDocument();
    expect(screen.getByText('$12')).toBeInTheDocument();
  });

  it('review blocker: a ticket completed hidden creates no socket and resume reconnects', async () => {
    const gate = deferred<Response>(); ticket = () => gate.promise;
    await mount(); act(hide);
    await act(async () => gate.resolve(envelope({ ticket: 'hidden-ticket' })));
    expect(Socket.instances).toHaveLength(0);
    ticket = async () => envelope({ ticket: 'visible-ticket' });
    await act(async () => show()); const socket = open();
    expect(Socket.instances).toHaveLength(1);
    expect(socket.sent.some((data) => JSON.parse(data).op === 'subscribe')).toBe(true);
  });

  it('review blocker: a socket opening hidden never subscribes and resumes', async () => {
    await mount(); const socket = Socket.instances.at(-1)!; act(hide); act(() => socket.open());
    expect(socket.sent).toHaveLength(0);
    await act(async () => show()); open();
    expect(Socket.instances.at(-1)!.sent.some((data) => JSON.parse(data).op === 'subscribe')).toBe(true);
  });

  it.each([false, true])('review blocker: successful recovery clears only its own obsolete error (unrelated=%s)', async (unrelated) => {
    await mount(); open();
    candles = async () => new Response(JSON.stringify({ rc: 1, mc: 'RECOVERY_FAILED', ma: ['owned recovery failure'] }), { status: 503 });
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(screen.getByRole('alert')).toHaveTextContent('owned recovery failure');
    if (unrelated) {
      trades = async (url) => { if (url.searchParams.has('cursor')) return new Response(JSON.stringify({ rc: 1, mc: 'HISTORY_FAILED', ma: ['unrelated history failure'] }), { status: 503 }); return envelope({ items: [], nextCursor: null }); };
      fireEvent.scroll(document.querySelector('.trade-rows')!); await act(async () => {});
      expect(screen.getByRole('alert')).toHaveTextContent('unrelated history failure');
    }
    candles = async (url) => envelope(snapshot(token.tokenAddress, '1m', url.searchParams.has('to') ? [] : [candle(1001)]));
    await advance(1000);
    if (unrelated) expect(screen.getByRole('alert')).toHaveTextContent('unrelated history failure');
    else expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('streams public trades after AZ login failure with account mutations blocked', async () => {
    mode = 'AZ_ACCOUNT'; await mount();
    expect(screen.getByRole('alert')).toHaveTextContent('AZ 登录上游');
    expect(Socket.instances).toHaveLength(1);
    const socket = open();
    act(() => socket.receive({ channel: `trade:${token.tokenAddress}:USD:USDG`, epoch: 'live', sequence: 1, data: { items: [trade('live', 1001, '33')] } }));
    expect(screen.getByText('$33').closest('.trade-row')).toHaveClass('trade-flash');
    await advance(700);
    expect(screen.getByText('$33').closest('.trade-row')).not.toHaveClass('trade-flash');
    expect(calls('/get-nonce')).toHaveLength(1);
    expect(calls('/quotes')).toHaveLength(0);
    expect(document.querySelector('button.primary')).toBeDisabled();
  });

  it('resumes a silently stale socket and REST data without a sequence gap, coalescing all tab events', async () => {
    await mount(); const old = open();
    const canvas = screen.getByTestId('tradingview-chart');
    act(hide); await advance(60_000);
    candles = async (url) => envelope(snapshot(token.tokenAddress, url.searchParams.get('interval') as '1m', url.searchParams.has('to') ? [] : [candle(1001)]));
    trades = async () => envelope({ items: [trade('missed', 1001, '33')], nextCursor: 'fresh-cursor' });
    const beforeCandles = headCalls().length, beforeTrades = calls('/trades').length;
    await act(async () => show());
    expect(old.readyState).toBe(3);
    expect(Socket.instances.filter((item) => item.readyState < 2)).toHaveLength(1);
    expect(headCalls().length - beforeCandles).toBe(1);
    expect(calls('/trades').length - beforeTrades).toBe(1);
    const resumed = open();
    expect(JSON.parse(resumed.sent.at(-1)!)).toMatchObject({ channels: expect.arrayContaining([`candle:${token.tokenAddress}:USD:USDG:1m`, `trade:${token.tokenAddress}:USD:USDG`]) });
    expect(screen.getByText('$33').closest('.trade-row')).not.toHaveClass('trade-flash');
    expect(canvas).toHaveAttribute('data-candle-count', '2');
    expect(screen.getByTestId('tradingview-chart')).toBe(canvas);
    expect(engine.create).toHaveBeenCalledTimes(1); expect(engine.fit).toHaveBeenCalledTimes(1);
    await advance(1000);
    expect(headCalls().length - beforeCandles).toBe(1);
  });

  it('focus resyncs a healthy socket once without reconnecting or erasing retained trade history/cursor', async () => {
    await mount(); const socket = open();
    fireEvent.scroll(document.querySelector('.trade-rows')!); await act(async () => {});
    trades = async () => envelope({ items: [trade('missed', 1001, '33')], nextCursor: 'new-head-cursor' });
    const before = calls('/trades').length;
    await act(async () => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('pageshow')); });
    expect(calls('/trades').length - before).toBe(1);
    expect(Socket.instances).toHaveLength(1); expect(socket.readyState).toBe(1);
    expect(screen.getAllByTestId('trade-price')).toHaveLength(3);
    fireEvent.scroll(document.querySelector('.trade-rows')!); await act(async () => {});
    expect(String(calls('/trades').at(-1)![0])).toContain('cursor=older-cursor');
  });

  it('coalesces ticket acquisition and cancels late resume reads on switch/unmount', async () => {
    await mount(); const old = open();
    const head = deferred<Response>(), prints = deferred<Response>(), tickets = deferred<Response>();
    let candleSignal!: AbortSignal, tradeSignal!: AbortSignal, ticketSignal!: AbortSignal;
    candles = (url, signal) => url.searchParams.get('interval') === '1s' ? Promise.resolve(envelope(snapshot(token.tokenAddress, '1s')))
      : (candleSignal = signal, head.promise);
    trades = (_url, signal) => (tradeSignal = signal, prints.promise);
    ticket = (signal) => (ticketSignal = signal, tickets.promise);
    act(hide); await advance(60_000); await act(async () => show());
    await act(async () => show());
    expect(calls('/ws-ticket')).toHaveLength(2);
    expect(old.readyState).toBe(3);
    const oldTicketSignal = ticketSignal;
    fireEvent.click(screen.getByRole('button', { name: '1s' })); await act(async () => {});
    expect(candleSignal.aborted).toBe(true); expect(tradeSignal.aborted).toBe(true); expect(oldTicketSignal.aborted).toBe(true);
    cleanup();
    await act(async () => { head.resolve(envelope(snapshot(token.tokenAddress, '1m', [candle(9)]))); prints.resolve(envelope({ items: [trade('late', 9, '99')], nextCursor: null })); tickets.resolve(envelope({ ticket: 'late' })); });
    expect(Socket.instances.filter((item) => item.readyState < 2)).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('continues pending demand after five reads, pauses hidden and stops at READY', async () => {
    let reads = 0;
    candles = async (url) => envelope({ ...snapshot(token.tokenAddress, url.searchParams.get('interval') as '1m', []),
      syncStatus: ++reads > 6 ? 'READY' : 'CATCHING_UP', availability: reads > 6 ? 'COMPLETE' : 'PARTIAL' });
    await mount(); await advance(90_000);
    expect(reads).toBeGreaterThan(5);
    expect(screen.queryByText(/已停止自动刷新/)).not.toBeInTheDocument();
    act(hide); const atHide = reads; await advance(120_000); expect(reads).toBe(atHide);
    await act(async () => show()); await advance(30_000);
    const completed = reads; await advance(120_000); expect(reads).toBe(completed);
  });

  it('coalesces pending snapshot retry with tab recovery and resumes pending reads on focus', async () => {
    candles = async (url) => envelope({ ...snapshot(token.tokenAddress, url.searchParams.get('interval') as '1m', []), syncStatus: 'CATCHING_UP' });
    await mount(); open();
    act(hide); await advance(60_000);
    const before = headCalls().length;
    await act(async () => show());
    expect(headCalls().length - before).toBe(1);
    act(hide); await advance(60_000);
    const beforeFocus = headCalls().length;
    hidden = false;
    await act(async () => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('pageshow')); });
    expect(headCalls().length - beforeFocus).toBe(1);
    await advance(30_000);
    expect(headCalls().length).toBeGreaterThan(beforeFocus + 1);
  });

  it('automatically loads real retained 1s pages for three sparse bars, deduping without a gesture', async () => {
    const boundaries: number[] = [];
    candles = async (url) => {
      const interval = url.searchParams.get('interval') as '1s', to = Number(url.searchParams.get('to'));
      if (!url.searchParams.has('to')) return envelope(snapshot(token.tokenAddress, interval, [candle(1000), candle(1050), candle(1100)]));
      boundaries.push(to);
      return envelope(snapshot(token.tokenAddress, interval, to === 999 ? [candle(900), candle(900), candle(950)]
        : to === 899 ? Array.from({ length: 30 }, (_, i) => candle(800 + i)) : []));
    };
    await mount(); fireEvent.click(screen.getByRole('button', { name: '1s' })); await act(async () => {}); await advance(2000);
    await advance(1000);
    expect(boundaries).toContain(999); expect(boundaries).toContain(899);
    expect(screen.getByTestId('tradingview-chart')).toHaveAttribute('data-candle-count', '35');
    expect(screen.getByTestId('tradingview-chart')).toHaveAttribute('data-first-candle-time', '800');
    expect(screen.queryByText(/BACKFILL|回填|追赶/)).not.toBeInTheDocument();
    const requests = boundaries.length; await advance(120_000); expect(boundaries).toHaveLength(requests);
  });

  it('retries pending left history while visible and stops on completed empty history', async () => {
    let olderReads = 0;
    candles = async (url) => {
      const interval = url.searchParams.get('interval') as '1s';
      if (!url.searchParams.has('to')) return envelope(snapshot(token.tokenAddress, interval, [candle(1000), candle(1050), candle(1100)]));
      return envelope({ ...snapshot(token.tokenAddress, interval, []), syncStatus: ++olderReads > 2 ? 'READY' : 'BACKFILLING' });
    };
    await mount(); fireEvent.click(screen.getByRole('button', { name: '1s' })); await act(async () => {}); await advance(30_000);
    expect(olderReads).toBeGreaterThanOrEqual(3);
    const completed = olderReads; await advance(120_000); expect(olderReads).toBe(completed);
    expect(screen.getByTestId('tradingview-chart')).toHaveAttribute('data-candle-count', '3');
  });

  it('bounds sparse pagination bursts, pauses hidden and aborts an old page on token switch', async () => {
    const page = deferred<Response>();
    let oldSignal!: AbortSignal;
    let oldReads = 0;
    candles = async (url, signal) => {
      const address = url.pathname.split('/')[5]!, interval = url.searchParams.get('interval') as '1s';
      if (!url.searchParams.has('to')) return envelope(snapshot(address, interval, [candle(1000), candle(1050), candle(1100)]));
      if (address === other.tokenAddress) return envelope(snapshot(address, interval, []));
      oldReads += 1;
      if (oldReads === 5) { oldSignal = signal; return page.promise; }
      return envelope(snapshot(address, interval, [candle(Number(url.searchParams.get('to')))]));
    };
    await mount(); fireEvent.click(screen.getByRole('button', { name: '1s' })); await act(async () => {});
    for (let i = 0; i < 4; i++) await advance(500);
    expect(oldReads).toBe(4);
    await advance(5000); expect(oldReads).toBe(4);
    act(hide); await advance(60_000); expect(oldReads).toBe(4);
    await act(async () => show()); await advance(30_000); expect(oldReads).toBe(5);
    fireEvent.click(screen.getByRole('button', { name: '查看 OTHER' })); await act(async () => {});
    expect(oldSignal.aborted).toBe(true);
    await act(async () => page.resolve(envelope(snapshot(token.tokenAddress, '1s', [candle(1)]))));
    expect(screen.getByTestId('tradingview-chart')).toHaveAttribute('data-first-candle-time', '1000');
    expect(screen.getByTestId('tradingview-chart')).toHaveAttribute('data-candle-count', '3');
    cleanup(); await act(async () => show());
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['STALE', 'FAILED'] as const)('stops pending demand on %s while preserving committed bars', async (status) => {
    let reads = 0;
    candles = async (url) => envelope({ ...snapshot(token.tokenAddress, url.searchParams.get('interval') as '1m',
      Array.from({ length: 40 }, (_, i) => candle(1000 + i))), syncStatus: ++reads > 1 ? status : 'CATCHING_UP' });
    await mount(); await advance(2000); expect(reads).toBe(2);
    expect(screen.getByTestId('tradingview-chart')).toHaveAttribute('data-candle-count', '40');
    await advance(120_000); expect(reads).toBe(2);
    expect(screen.getByRole('button', { name: '重试' })).toBeEnabled();
  });

  it('ignores frames from a retired socket while the browser close handshake is still pending', async () => {
    await mount(); const old = open(); old.delayedClose = true;
    const gate = deferred<Response>(); ticket = () => gate.promise;
    act(hide); await advance(60_000); await act(async () => show());
    act(() => old.receive({ channel: `trade:${token.tokenAddress}:USD:USDG`, epoch: 'old', sequence: 1, data: { items: [trade('retired', 1100, '99')] } }));
    expect(screen.queryByText('$99')).not.toBeInTheDocument();
    await act(async () => gate.resolve(envelope({ ticket: 'new' })));
    expect(Socket.instances.filter((item) => item.readyState < 2)).toHaveLength(1);
  });

  it('retries failed older history on explicit retry without resetting the chart or viewport', async () => {
    let oldReads = 0;
    candles = async (url) => {
      const interval = url.searchParams.get('interval') as '1s';
      if (!url.searchParams.has('to')) return envelope(snapshot(token.tokenAddress, interval, [candle(1000), candle(1050), candle(1100)]));
      return envelope({ ...snapshot(token.tokenAddress, interval, ++oldReads === 1 ? [] : Array.from({ length: 40 }, (_, i) => candle(900 + i))),
        syncStatus: oldReads === 1 ? 'FAILED' : 'READY' });
    };
    await mount(); fireEvent.click(screen.getByRole('button', { name: '1s' })); await act(async () => {}); await advance(500);
    const canvas = screen.getByTestId('tradingview-chart');
    expect(screen.getByRole('button', { name: '重试' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '重试' })); await act(async () => {}); await advance(500); await advance(500);
    expect(canvas).toHaveAttribute('data-candle-count', '43');
    expect(screen.getByTestId('tradingview-chart')).toBe(canvas);
    expect(engine.create).toHaveBeenCalledTimes(2); expect(engine.fit).toHaveBeenCalledTimes(2);
  });
  it('owns older-history timeouts locally and clears them after retry without account disconnection', async () => {
    let reads=0;
    candles=async(url)=>{
      const interval=url.searchParams.get('interval') as '1s';
      if(!url.searchParams.has('to'))return envelope(snapshot(token.tokenAddress,interval,[candle(1000),candle(1050),candle(1100)]));
      if(++reads===1)throw new Error('history body timeout');
      return envelope(snapshot(token.tokenAddress,interval,Array.from({length:40},(_,i)=>candle(900+i))));
    };
    await mount();fireEvent.click(screen.getByRole('button',{name:'1s'}));await act(async()=>{});await advance(500);
    expect(screen.getByRole('alert')).toHaveTextContent('更早行情加载失败');
    expect(screen.getByRole('alert')).not.toHaveTextContent('账户请求失败');
    expect(screen.getByText('主账户已连接')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'重试'}));await act(async()=>{});await advance(500);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('ends empty earlier coverage during catchup and does not spin forever', async () => {
    candles=async(url)=>envelope(url.searchParams.has('to')
      ? {...snapshot(token.tokenAddress,'1s',[]),syncStatus:'CATCHING_UP',availability:'UNAVAILABLE_BEFORE_START'}
      : snapshot(token.tokenAddress,url.searchParams.get('interval') as '1s',[candle(1000),candle(1050),candle(1100)]));
    await mount();fireEvent.click(screen.getByRole('button',{name:'1s'}));await act(async()=>{});await advance(500);
    const reads=calls('/candles').filter(([u])=>new URL(String(u)).searchParams.has('to')).length;
    await advance(30000);
    expect(calls('/candles').filter(([u])=>new URL(String(u)).searchParams.has('to'))).toHaveLength(reads);
    expect(screen.getByRole('figure')).toHaveAttribute('aria-busy','false');
  });

  it('ends canceled history loading on interval change and ignores its late failure', async () => {
    const gate = deferred<Response>();
    let oldSignal: AbortSignal | undefined;
    candles = async (url, signal) => {
      if (url.searchParams.has('to') && url.searchParams.get('interval') === '1s') {
        oldSignal = signal;
        return gate.promise;
      }
      return envelope(snapshot(token.tokenAddress, url.searchParams.get('interval') as '1s',
        Array.from({ length: 40 }, (_, i) => candle(1000 + i))));
    };
    await mount();
    fireEvent.click(screen.getByRole('button', { name: '1s' }));
    await act(async () => {});
    fireEvent.pointerDown(screen.getByTestId('tradingview-chart'));
    act(() => engine.visible?.({ from: -5, to: 25 }));
    await advance(500);
    expect(screen.getByRole('figure')).toHaveAttribute('aria-busy', 'true');
    expect(document.querySelectorAll('.history-loading-dots span')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: '15m' }));
    await act(async () => {});
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => gate.resolve(new Response('late failure', { status: 500 })));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('figure')).toHaveAttribute('aria-busy', 'false');
  });

});
