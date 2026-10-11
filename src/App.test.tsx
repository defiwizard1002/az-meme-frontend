import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { setSessionToken } from './api';

vi.mock('lightweight-charts', () => ({
  CandlestickSeries: 'Candlestick',
  HistogramSeries: 'Histogram',
  ColorType: { Solid: 'solid' },
  CrosshairMode: { Normal: 0 },
  createChart: () => ({
    addSeries: () => ({
      setData: vi.fn(),
      update: vi.fn(),
      priceScale: () => ({ applyOptions: vi.fn() }),
    }),
    applyOptions: vi.fn(),
    timeScale: () => ({
      fitContent: vi.fn(),
      subscribeVisibleLogicalRangeChange: vi.fn(),
      unsubscribeVisibleLogicalRangeChange: vi.fn(),
      getVisibleLogicalRange: vi.fn(() => null),
      setVisibleLogicalRange: vi.fn(),
    }),
    remove: vi.fn(),
  }),
}));

const token = {
  chainId: 4663,
  tokenAddress: '0x1111111111111111111111111111111111111011',
  symbol: 'CASHCAT',
  name: 'Cash Cat',
  launchpad: 'PONS',
  stage: 'GRADUATED',
  quoteAssetKey: 'NATIVE',
  priceUsd: '0.0184',
  marketCapUsd: '18400000',
  volume24hUsd: '1344000',
  change5m: '41',
  change24h: '88',
  holders: 4120,
  ageSeconds: 720,
  pool: { poolKey: 'pool_cashcat', poolType: 'UNISWAP_V4', liquidityUsd: '3200000' },
  tradeStatus: 'TRADABLE',
  riskFlags: [],
  security: {
    isHoneypot: false,
    buyTaxPct: '1',
    sellTaxPct: '1',
    liquidityLocked: true,
    liquidityLockedPct: '0',
    liquidityBurnedPct: '95',
  },
};

function response(result: unknown) {
  if (result && typeof result === 'object' && 'interval' in result && 'tokenAddress' in result && 'items' in result) {
    const candle = result as Record<string, unknown> & { items: Array<Record<string, unknown>> };
    result = { ...candle, marketKey: 'USD:USDG', syncStatus: candle.syncStatus ?? 'READY',
      availability: 'COMPLETE', coverage: { from: 1, to: 100 }, gaps: [], revision: '1',
      asOfBlock: 100, source: 'CHAIN', items: candle.items.map((item) => ({ ...item, revision: String(item.revision ?? 1) })) };
  }
  return Promise.resolve(new Response(JSON.stringify({ rc: 0, mc: 'SUCCESS', ma: [], result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
}

function quoteResult(init?: RequestInit) {
  const input = JSON.parse(String(init?.body)) as { tokenAddress: string; side: 'BUY' | 'SELL'; settlementAsset: 'USDG' | 'ETH'; amountIn: string };
  return { ...input, quoteId: 'rest-quote', expectedAmountOut: '100', minAmountOut: '95', fees: [], expiresAt: Date.now() + 10_000 };
}

class ControlledQuoteSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static latest: ControlledQuoteSocket | null = null;
  readyState = ControlledQuoteSocket.CONNECTING;
  sent: string[] = [];
  private readonly listeners = new Map<string, Array<(event: Event) => void>>();

  constructor(_url: string) { ControlledQuoteSocket.latest = this; }
  addEventListener(name: string, listener: (event: Event) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  send(payload: string): void { this.sent.push(payload); }
  open(): void {
    this.readyState = ControlledQuoteSocket.OPEN;
    this.emit('open', new Event('open'));
  }
  receive(payload: unknown): void {
    this.emit('message', { data: JSON.stringify(payload) } as MessageEvent);
  }
  close(): void {
    if (this.readyState === ControlledQuoteSocket.CLOSED) return;
    this.readyState = ControlledQuoteSocket.CLOSED;
    this.emit('close', new Event('close'));
  }
  private emit(name: string, event: Event): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}

function renderWithDeferredQuotes(options: { settlementAssets?: string[] } = {}) {
  const quotes: Array<{ input: ReturnType<typeof quoteResult>; signal: AbortSignal | undefined; resolve: (value: Response) => void }> = [];
  ControlledQuoteSocket.latest = null;
  vi.stubGlobal('WebSocket', ControlledQuoteSocket);
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.endsWith('/config')) return response({
      chainId: 4663,
      chainName: 'Robinhood Chain',
      explorerBaseUrl: 'https://robinhoodchain.blockscout.com',
      defaultSlippageBps: 300,
      marketRefreshMs: { hot: 14_400_000, new: 300_000 },
      accountMode: 'MAIN_ACCOUNT_POC',
      mainAccountAddress: '0x9999999999999999999999999999999999999999',
      settlementAssets: options.settlementAssets ?? ['USDG', 'ETH'],
    });
    if (url.includes('/markets')) return response({ items: [token], stale: false });
    if (url.endsWith(`/tokens/${token.tokenAddress}`)) return response(token);
    if (url.endsWith('/account/summary')) return response({ quoteBalances: [{ asset: 'USDG', available: '10', frozen: '0' }], positions: [] });
    if (url.includes('/account/transactions?')) return response({ items: [] });
    if (url.endsWith('/orders')) return response({ items: [], nextCursor: null });
    if (url.endsWith('/ws-ticket')) return response({ ticket: 'test-ticket', expiresAt: Date.now() + 30_000 });
    if (url.includes('/trades?')) return response({ items: [], nextCursor: null });
    if (url.includes('/candles')) return response({
      chainId: 4663, tokenAddress: new URL(url).pathname.split('/').at(-2), interval: new URL(url).searchParams.get('interval') ?? '1m', source: 'CHAIN',
      items: [{ t: 1, o: '0.018', h: '0.019', l: '0.017', c: '0.0184', baseVolume: null, quoteVolume: null }],
    });
    if (url.endsWith('/quotes')) {
      let resolve!: (value: Response) => void;
      const promise = new Promise<Response>((done) => { resolve = done; });
      quotes.push({ input: quoteResult(init), signal: init?.signal as AbortSignal | undefined, resolve });
      return promise;
    }
    throw new Error(`Unexpected request ${url}`);
  });
  return { ...render(<App />), quotes };
}

function displayedQuote(): string | null {
  return document.querySelector('.quote-details dd')?.textContent ?? null;
}

describe('App', () => {
  it('displays actual quote assets with hidden pool internals and submits that quote', async () => {
    const { quotes } = renderWithDeferredQuotes({ settlementAssets: ['USDG', 'ETH', 'WETH'] });
    await screen.findByRole('button', { name: '查看 CASHCAT' });
    fireEvent.change(screen.getByLabelText('支付资产'), { target: { value: 'WETH' } });
    await waitFor(() => expect(quotes.at(-1)?.input.settlementAsset).toBe('WETH'));
    const current = quotes.at(-1)!;
    await act(async () => { current.resolve(await response({ ...current.input,
      routeAssets: [{ symbol: 'WETH', address: `0x${'9'.repeat(40)}`, decimals: 18 },
        { symbol: 'BRIDGE', address: `0x${'8'.repeat(40)}`, decimals: 18 }, { symbol: token.symbol, address: token.tokenAddress, decimals: 18 }],
      routePools: [{ poolKey: 'pool-alpha', poolType: 'UNISWAP_V3', liquidityUsd: '10' }, { poolKey: 'pool-beta', poolType: 'UNISWAP_V2', liquidityUsd: '20' }],
    })); });
    await waitFor(() => expect(document.querySelector('.quote-details')).toHaveTextContent('最低得到'));
    expect(document.querySelector('.quote-details')).not.toHaveTextContent(/BRIDGE|→|路由/);
    expect(document.querySelector('.quote-details')).not.toHaveTextContent('pool-alpha');
    expect(document.querySelector('.quote-details')).not.toHaveTextContent('pool-beta');
    expect(document.querySelector('.quote-details')).toHaveTextContent('最低得到');
    const fetch = vi.mocked(globalThis.fetch);
    const fallback = fetch.getMockImplementation()!;
    fetch.mockImplementation((input, init) => String(input).endsWith('/account/transactions')
      ? response({ executionId: 'test', tokenAddress: token.tokenAddress, tokenSymbol: token.symbol, side: 'BUY', settlementAsset: 'WETH',
        amountIn: '1', amountOut: null, status: 'FAILED', txHashes: [], errorMessage: 'test', createdAt: 1, updatedAt: 1 })
      : String(input).endsWith('/account/transactions/test') ? response({ status: 'FAILED', txHashes: [], executionId: 'test' }) : fallback(input, init));
    fireEvent.click(document.querySelector('button.primary')!);
    await waitFor(() => expect(fetch.mock.calls.some(([input, init]) => String(input).endsWith('/account/transactions')
      && JSON.parse(String(init?.body)).settlementAsset === 'WETH' && JSON.parse(String(init?.body)).quoteId === 'rest-quote')).toBe(true));
  });
  it('shows the converted ETH quote amount and explicitly retained WETH',async()=>{
    const {quotes}=renderWithDeferredQuotes({settlementAssets:['USDG','ETH','WETH']});
    await screen.findByRole('button',{name:'查看 CASHCAT'});
    fireEvent.click(screen.getByRole('button',{name:'卖出'}));
    fireEvent.change(screen.getByLabelText('结算资产'),{target:{value:'ETH'}});
    fireEvent.change(screen.getByLabelText('卖出数量'),{target:{value:'1'}});
    await waitFor(()=>expect(quotes.at(-1)?.input.settlementAsset).toBe('ETH'));
    const current=quotes.at(-1)!;
    await act(async()=>{current.resolve(await response({...current.input,expectedAmountOut:'1.94',minAmountOut:'1.94',
      residualAssets:[{address:`0x${'9'.repeat(40)}`,symbol:'WETH',decimals:18,expectedAmountAtomic:'60000000000000000'}]}));});
    await waitFor(()=>expect(document.querySelector('.quote-details')).toHaveTextContent('1.94 ETH'));
    expect(document.querySelector('.quote-details')).toHaveTextContent('预计保留 WETH');
    expect(document.querySelector('.quote-details')).toHaveTextContent('0.06 WETH');
  });
  it('shows 1h search volume and keeps the hot/new 24h change column', async () => {
    renderWithDeferredQuotes();
    await screen.findByRole('button', { name: '查看 CASHCAT' });
    expect(document.querySelector('.token-head')).toHaveTextContent('24h');
    const fetch = vi.mocked(globalThis.fetch);
    const fallback = fetch.getMockImplementation()!;
    fetch.mockImplementation((input, init) => String(input).includes('query=')
      ? response({ items: [{ ...token, volume1hUsd: '1234.56' }], stale: false }) : fallback(input, init));
    fireEvent.change(screen.getByPlaceholderText('搜索代币或粘贴合约地址'), { target: { value: 'CASHCAT' } });
    await waitFor(() => expect(document.querySelector('.token-head')).toHaveTextContent('1h 量'));
    await waitFor(() => expect(document.querySelector('.token-row')).toHaveTextContent('$1,234.56'));
    expect(document.querySelector('.token-row')).not.toHaveTextContent('+88.00%');
    fireEvent.change(screen.getByPlaceholderText('搜索代币或粘贴合约地址'), { target: { value: '' } });
    expect(document.querySelector('.token-head')).toHaveTextContent('24h');
    expect(document.querySelector('.token-row')).toHaveTextContent('+88.00%');
  });

  it.each([undefined, '0', '9876.54'])('preserves search snapshot 1h volume after selecting a result with detail volume %j', async (volume1hUsd) => {
    renderWithDeferredQuotes();
    await screen.findByRole('button', { name: '查看 CASHCAT' });
    const summary = { ...token, tokenAddress: `0x${'2'.repeat(40)}`, symbol: 'SNAPSHOT', volume1hUsd: '1234.56' };
    const fetch = vi.mocked(globalThis.fetch);
    const fallback = fetch.getMockImplementation()!;
    let resolveDetail!: (value: Response) => void;
    fetch.mockImplementation((input, init) => String(input).includes('query=')
      ? response({ items: [summary], stale: false })
      : String(input).endsWith(`/tokens/${summary.tokenAddress}`)
        ? new Promise<Response>((resolve) => { resolveDetail = resolve; }) : fallback(input, init));
    fireEvent.change(screen.getByPlaceholderText('搜索代币或粘贴合约地址'), { target: { value: 'SNAPSHOT' } });
    const row = await screen.findByRole('button', { name: '查看 SNAPSHOT' });
    expect(row).toHaveTextContent('$1,234.56');
    fireEvent.click(row);
    await waitFor(() => expect(resolveDetail).toBeTypeOf('function'));
    await act(async () => { resolveDetail(await response({ ...summary, symbol: 'DETAIL', priceUsd: '2.5', marketCapUsd: '2500000', volume1hUsd })); });
    const updatedRow = await screen.findByRole('button', { name: '查看 DETAIL' });
    expect(updatedRow).toHaveTextContent('$2.5M');
    expect(updatedRow).toHaveTextContent('$1,234.56');
    expect(screen.getByRole('button', { name: '买入 DETAIL' })).toBeInTheDocument();
    expect(fetch.mock.calls.filter(([input]) => String(input).endsWith(`/tokens/${summary.tokenAddress}`))).toHaveLength(1);
  });

  it.each([undefined, '0', '9876.54'])('preserves search snapshot 1h volume after markets:live with volume %j', async (volume1hUsd) => {
    renderWithDeferredQuotes();
    await waitFor(() => expect(ControlledQuoteSocket.latest).not.toBeNull());
    const socket = ControlledQuoteSocket.latest!;
    act(() => socket.open());
    await waitFor(() => expect(socket.sent.some((payload) =>
      (JSON.parse(payload) as { channels: string[] }).channels.includes('markets:live'))).toBe(true));
    const fetch = vi.mocked(globalThis.fetch);
    const fallback = fetch.getMockImplementation()!;
    fetch.mockImplementation((input, init) => String(input).includes('query=')
      ? response({ items: [{ ...token, volume1hUsd: '1234.56' }], stale: false }) : fallback(input, init));
    fireEvent.change(screen.getByPlaceholderText('搜索代币或粘贴合约地址'), { target: { value: 'CASHCAT' } });
    await waitFor(() => expect(screen.getByRole('button', { name: '查看 CASHCAT' })).toHaveTextContent('$1,234.56'));
    const detailCallsBefore = fetch.mock.calls.filter(([input]) => String(input).includes('/tokens/')).length;
    act(() => socket.receive({ channel: 'markets:live', epoch: 'snapshot-test', sequence: 1,
      data: { items: [{ ...token, symbol: 'LIVE', priceUsd: '3.5', marketCapUsd: '3500000', change24h: '12', volume1hUsd }] } }));
    const updatedRow = await screen.findByRole('button', { name: '查看 LIVE' });
    expect(updatedRow).toHaveTextContent('$3.5M');
    expect(updatedRow).toHaveTextContent('$1,234.56');
    expect(fetch.mock.calls.filter(([input]) => String(input).includes('/tokens/'))).toHaveLength(detailCallsBefore);
    fireEvent.change(screen.getByPlaceholderText('搜索代币或粘贴合约地址'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: '查看 LIVE' })).toHaveTextContent('+12.00%');
  });

  it.each([undefined, null, 'invalid'])('shows unknown search volume %j as unavailable instead of substituting 24h or zero', async (volume1hUsd) => {
    renderWithDeferredQuotes();
    await screen.findByRole('button', { name: '查看 CASHCAT' });
    const fetch = vi.mocked(globalThis.fetch);
    const fallback = fetch.getMockImplementation()!;
    fetch.mockImplementation((input, init) => String(input).includes('query=') ? response({ items: [{ ...token, volume1hUsd }], stale: false }) : fallback(input, init));
    fireEvent.change(screen.getByPlaceholderText('搜索代币或粘贴合约地址'), { target: { value: 'CASHCAT' } });
    await waitFor(() => expect(document.querySelector('.token-head')).toHaveTextContent('1h 量'));
    await waitFor(() => expect(fetch.mock.calls.some(([input]) => String(input).includes('query='))).toBe(true));
    expect(screen.getByRole('button', { name: '查看 CASHCAT' })).toHaveTextContent('—');
    expect(screen.getByRole('button', { name: '查看 CASHCAT' })).not.toHaveTextContent('$0');
  });

  it('ignores stale search results and retains the latest empty state', async () => {
    renderWithDeferredQuotes();
    await screen.findByRole('button', { name: '查看 CASHCAT' });
    const pending: Array<(response: Response) => void> = [];
    const fetch = vi.mocked(globalThis.fetch);
    const fallback = fetch.getMockImplementation()!;
    fetch.mockImplementation((input, init) => String(input).includes('query=') ? new Promise<Response>((resolve) => { pending.push(resolve); }) : fallback(input, init));
    const search = screen.getByPlaceholderText('搜索代币或粘贴合约地址');
    fireEvent.change(search, { target: { value: 'old' } });
    await waitFor(() => expect(pending).toHaveLength(1));
    fireEvent.change(search, { target: { value: 'latest' } });
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => { pending[1]!(await response({ items: [], stale: false })); });
    await act(async () => { pending[0]!(await response({ items: [{ ...token, volume1hUsd: '1' }], stale: false })); });
    expect(screen.getByText('没有匹配的代币')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '查看 CASHCAT' })).not.toBeInTheDocument();
  });

  it('explains the public quote denial, clears it on request change and ignores a late denial', async () => {
    const { quotes } = renderWithDeferredQuotes();
    await waitFor(() => expect(quotes).toHaveLength(1));
    const denial = () => new Response('Signing is available only on the private account entry', { status: 403 });
    await act(async () => { quotes[0]!.resolve(denial()); });
    expect(await screen.findByRole('alert')).toHaveTextContent('报价和交易请使用私有主账户入口');
    expect(screen.getByRole('alert')).not.toHaveTextContent('登录已失效');
    expect(document.querySelector('.trade-panel .primary')).toBeDisabled();
    expect(quotes).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('买入金额'), { target: { value: '2' } });
    await waitFor(() => expect(quotes).toHaveLength(2));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('买入金额'), { target: { value: '3' } });
    await waitFor(() => expect(quotes).toHaveLength(3));
    await act(async () => { quotes[2]!.resolve(await response({ ...quotes[2]!.input, expectedAmountOut: '300' })); });
    await act(async () => { quotes[1]!.resolve(denial()); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(displayedQuote()).toBe('≈ 300 CASHCAT');
    expect(vi.mocked(globalThis.fetch).mock.calls.some(([url, init]) => init?.method === 'POST' && /\/orders$|\/account\/transactions$|\/transactions\/plan$/.test(String(url)))).toBe(false);
  });

  it('keeps private unsupported-pool quotes blocked and clears their error when the token changes', async () => {
    const { quotes } = renderWithDeferredQuotes();
    await waitFor(() => expect(quotes).toHaveLength(1));
    await act(async () => { quotes[0]!.resolve(new Response(JSON.stringify({ rc: 409, mc: 'MEME_UNSUPPORTED_POOL_TYPE', ma: ['Unsupported pool'], result: null }), { status: 409 })); });
    expect(await screen.findByRole('alert')).toHaveTextContent('当前池暂不支持交易');
    expect(document.querySelector('.trade-panel .primary')).toBeDisabled();
    const second = { ...token, tokenAddress: `0x${'2'.repeat(40)}`, symbol: 'SECOND', volume1hUsd: '2' };
    const fetch = vi.mocked(globalThis.fetch);
    const fallback = fetch.getMockImplementation()!;
    fetch.mockImplementation((input, init) => String(input).includes('query=') ? response({ items: [second], stale: false })
      : String(input).endsWith(`/tokens/${second.tokenAddress}`) ? response(second) : fallback(input, init));
    fireEvent.change(screen.getByPlaceholderText('搜索代币或粘贴合约地址'), { target: { value: 'SECOND' } });
    fireEvent.click(await screen.findByRole('button', { name: '查看 SECOND' }));
    await waitFor(() => expect(quotes).toHaveLength(2));
    expect(quotes[1]!.input.tokenAddress).toBe(second.tokenAddress);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('retries an empty HTTP account failure and restores the account session', async () => {
    renderWithDeferredQuotes();
    const fetch = vi.mocked(globalThis.fetch);
    const fallback = fetch.getMockImplementation()!;
    let accountCalls = 0;
    fetch.mockImplementation((input, init) => {
      if (String(input).endsWith('/account/summary') && ++accountCalls === 1) return Promise.resolve(new Response('', { status: 502 }));
      return fallback(input, init);
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 502');
    fireEvent.click(screen.getByRole('button', { name: '重试账户连接' }));
    await waitFor(() => expect(accountCalls).toBe(2));
    await waitFor(() => expect(screen.queryByRole('button', { name: '重试账户连接' })).not.toBeInTheDocument());
    expect(screen.queryByText('账户连接失败')).not.toBeInTheDocument();
  });

  it('keeps newer WS trades when a single gap snapshot resolves late', async () => {
    renderWithDeferredQuotes();
    const mockedFetch = vi.mocked(globalThis.fetch);
    const fallback = mockedFetch.getMockImplementation()!;
    let resolveSnapshot!: (response: Response) => void;
    let snapshotCalls = 0;
    let defer = false;
    mockedFetch.mockImplementation((input, init) => {
      if (String(input).includes('/trades?') && defer) {
        snapshotCalls += 1;
        return new Promise<Response>((resolve) => { resolveSnapshot = resolve; });
      }
      return fallback(input, init);
    });
    await waitFor(() => expect(ControlledQuoteSocket.latest).not.toBeNull());
    const socket = ControlledQuoteSocket.latest!;
    act(() => socket.open());
    await waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
    const trade = (index: number) => ({ tradeId: `gap-trade-${index}`, t: 100 + index, side: 'BUY',
      priceUsd: String(index), baseAmount: '2', quoteAmount: '2', quoteAsset: 'USD',
      trader: `0x${'a'.repeat(40)}`, txHash: `0x${'b'.repeat(64)}` });
    const send = (sequence: number) => socket.receive({ channel: `trade:${token.tokenAddress}:USD:USDG`,
      epoch: 'gap-test', sequence, data: { items: [trade(sequence)] } });
    act(() => send(1));
    defer = true;
    act(() => { send(3); send(5); send(6); });
    expect(snapshotCalls).toBe(1);
    await act(async () => resolveSnapshot(await response({ items: [trade(2)], nextCursor: null })));
    await waitFor(() => expect(screen.getAllByTestId('trade-price')).toHaveLength(5));
    expect(screen.getAllByTestId('trade-price')[0]).toHaveTextContent('$6');
  });
  it.each(['candle', 'trade'] as const)('retries failed %s gap recovery single-flight and applies payloads while dirty', async (kind) => {
    const view = renderWithDeferredQuotes();
    const mockedFetch = vi.mocked(globalThis.fetch), fallback = mockedFetch.getMockImplementation()!;
    await waitFor(() => expect(ControlledQuoteSocket.latest).not.toBeNull());
    const socket = ControlledQuoteSocket.latest!;
    act(() => socket.open());
    let calls = 0;
    const candle = (t: number) => ({ t, o: '1', h: '1', l: '1', c: '1', revision: '3', baseVolume: null, quoteVolume: null });
    const trade = (t: number) => ({ tradeId: `recovery-${t}`, t, side: 'BUY', priceUsd: '1', baseAmount: '2',
      quoteAmount: '2', quoteAsset: 'USD', trader: `0x${'a'.repeat(40)}`, txHash: `0x${'b'.repeat(64)}` });
    mockedFetch.mockImplementation((input, init) => {
      if (String(input).includes(kind === 'candle' ? '/candles?' : '/trades?')) {
        calls++;
        if (calls === 1) return Promise.reject(new Error('offline recovery failure'));
        return kind === 'candle' ? response({ chainId: 4663, tokenAddress: token.tokenAddress,
          interval: '1m', items: [candle(2)] }) : response({ items: [trade(2)], nextCursor: null });
      }
      return fallback(input, init);
    });
    const send = (sequence: number) => socket.receive({ channel: `${kind}:${token.tokenAddress}:USD:USDG${kind === 'candle' ? ':1m' : ''}`,
      epoch: 'retry-gap', sequence, data: { items: [kind === 'candle' ? candle(sequence) : trade(sequence)] } });
    await act(async () => { send(1); send(3); send(4); });
    expect(calls).toBe(1);
    if (kind === 'candle') expect(screen.getByTestId('tradingview-chart')).toHaveAttribute('data-candle-count', '3');
    else expect(screen.getAllByTestId('trade-price')).toHaveLength(3);
    await waitFor(() => expect(calls).toBe(2), { timeout: 3500 });
    await waitFor(() => {
      if (kind === 'candle') expect(screen.getByTestId('tradingview-chart')).toHaveAttribute('data-candle-count', '4');
      else expect(screen.getAllByTestId('trade-price')).toHaveLength(4);
    });
    act(() => send(5));
    expect(calls).toBe(2);
    view.unmount();
  });
  it.each(['candle', 'trade'] as const)('cancels %s recovery retries on selection change and unmount', async (kind) => {
    const view = renderWithDeferredQuotes();
    await waitFor(() => expect(ControlledQuoteSocket.latest).not.toBeNull());
    const old = ControlledQuoteSocket.latest!; act(() => old.open());
    const mockedFetch = vi.mocked(globalThis.fetch), fallback = mockedFetch.getMockImplementation()!;
    let calls = 0;
    mockedFetch.mockImplementation((input, init) => {
      if (String(input).includes(kind === 'candle' ? '/candles?' : '/trades?')) {
        calls++; return Promise.reject(new Error('failed recovery'));
      }
      return fallback(input, init);
    });
    const send = (sequence: number) => old.receive({ channel: `${kind}:${token.tokenAddress}:USD:USDG${kind === 'candle' ? ':1m' : ''}`,
      epoch: 'cleanup', sequence, data: { items: [] } });
    await act(async () => { send(1); send(3); });
    expect(calls).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: '1s' }));
    view.unmount();
    const atCleanup = calls;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1200)); });
    expect(calls).toBe(atCleanup);
  });
  it.each(['candle', 'trade'] as const)('aborts in-flight %s recovery on selection changes and ignores late data', async (kind) => {
    const view = renderWithDeferredQuotes();
    await waitFor(() => expect(ControlledQuoteSocket.latest).not.toBeNull());
    const old = ControlledQuoteSocket.latest!; act(() => old.open());
    const mockedFetch = vi.mocked(globalThis.fetch), fallback = mockedFetch.getMockImplementation()!;
    let resolveRecovery!: (value: Response) => void;
    let recoverySignal: AbortSignal | undefined;
    mockedFetch.mockImplementation((input, init) => {
      const url = String(input);
      if (url.includes(kind === 'candle' ? '/candles?' : '/trades?') && init?.signal && !url.includes('interval=1s')) {
        recoverySignal = init.signal as AbortSignal;
        return new Promise((resolve) => { resolveRecovery = resolve; });
      }
      if (url.includes('/candles?') && url.includes('interval=1s')) return response({ chainId: 4663,
        tokenAddress: token.tokenAddress, interval: '1s', items: [] });
      return fallback(input, init);
    });
    const send = (sequence: number) => old.receive({ channel: `${kind}:${token.tokenAddress}:USD:USDG${kind === 'candle' ? ':1m' : ''}`,
      epoch: 'late-cleanup', sequence, data: { items: [] } });
    await act(async () => { send(1); send(3); });
    expect(recoverySignal?.aborted).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '1s' }));
    await waitFor(() => expect(recoverySignal?.aborted).toBe(true));
    await act(async () => resolveRecovery(await (kind === 'candle'
      ? response({ chainId: 4663, tokenAddress: token.tokenAddress, interval: '1m', items: [{ t: 99, o: '1', h: '1', l: '1', c: '1' }] })
      : response({ items: [{ tradeId: 'late-old-selection', t: 99, side: 'BUY', priceUsd: '99999', baseAmount: '1',
        quoteAmount: '1', quoteAsset: 'USD', trader: `0x${'a'.repeat(40)}`, txHash: `0x${'b'.repeat(64)}` }], nextCursor: null }))));
    expect(screen.queryByText('$99,999')).toBeNull();
    expect(screen.getByTestId('tradingview-chart')).toHaveAttribute('data-candle-count', '0');
    view.unmount();
  });
  it('starts streaming when a cached STALE selection becomes READY, including revisit', async () => {
    const view = renderWithDeferredQuotes();
    const mockedFetch = vi.mocked(globalThis.fetch), fallback = mockedFetch.getMockImplementation()!;
    await waitFor(() => expect(ControlledQuoteSocket.latest).not.toBeNull());
    let stale = true;
    mockedFetch.mockImplementation((input, init) => {
      const url = String(input);
      if (url.includes('/candles?') && url.includes('interval=1s')) return response({ chainId: 4663,
        tokenAddress: token.tokenAddress, interval: '1s', syncStatus: stale ? 'STALE' : 'READY', items: [] });
      return fallback(input, init);
    });
    fireEvent.click(screen.getByRole('button', { name: '1s' }));
    await screen.findByRole('button', { name: '重试' });
    const prior = ControlledQuoteSocket.latest;
    stale = false;
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(ControlledQuoteSocket.latest).not.toBe(prior));
    fireEvent.click(screen.getByRole('button', { name: '1m' }));
    await waitFor(() => expect(ControlledQuoteSocket.latest!.readyState).not.toBe(ControlledQuoteSocket.CLOSED));
    view.unmount();
  });
  afterEach(() => {
    cleanup();
    setSessionToken(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders markets, READY candles and account balances from API responses', async () => {
    vi.stubGlobal('WebSocket', undefined);
    let resolveTokenDetail!: (value: Response) => void;
    const tokenDetail = new Promise<Response>((resolve) => { resolveTokenDetail = resolve; });
    let candleRequestedBeforeDetail = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith('/uaapi/user/web3/get-nonce')) return response({ nonce: 'mock-nonce', message: 'AZ login message' });
      if (url.endsWith('/uaapi/user/web3/login')) return response({ accessToken: 'mock-az-session-token', expiresAt: Date.now() + 3600000 });
      if (url.endsWith('/uaapi/user/user/getDesensitizedUserInfo')) {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer mock-az-session-token');
        return response({ userId: 'mock-user', accountId: 'mock-account', loginStatus: 'LOGGED_IN' });
      }
      if (url.endsWith('/config')) return response({
        chainId: 4663,
        chainName: 'Robinhood Chain',
        explorerBaseUrl: 'https://robinhoodchain.blockscout.com',
        defaultSlippageBps: 300,
        marketRefreshMs: { hot: 14_400_000, new: 300_000 },
      });
      if (url.includes('/markets')) return response({
        items: [{ ...token, pool: { ...token.pool, poolType: 'UNSUPPORTED' }, tradeStatus: 'UNSUPPORTED_POOL_TYPE' }],
        stale: false,
      });
      if (url.endsWith(`/tokens/${token.tokenAddress}`)) return tokenDetail;
      if (url.endsWith('/account/summary')) {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer mock-az-session-token');
        return response({
        quoteBalances: [{ asset: 'ETH', available: '0.42', frozen: '0' }, { asset: 'USDC', available: '1250', frozen: '0' }],
        positions: [{ tokenAddress: token.tokenAddress, symbol: 'CASHCAT', available: '0', costUsd: '100', valueUsd: '141' }],
        });
      }
      if (url.endsWith('/orders')) return response({ items: [], nextCursor: null });
      if (url.endsWith('/quotes')) return response(quoteResult(init));
      if (url.includes('/trades?')) return response({ items: [], nextCursor: null });
      if (url.endsWith('/sapi/v4/fund/balance/transfer')) {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer mock-az-session-token');
        expect(JSON.parse(String(init?.body))).toMatchObject({ from: 'SPOT', to: 'MEME', currency: 'ETH', amount: '0.1' });
        return response(10001);
      }
      if (url.includes('/candles')) {
        candleRequestedBeforeDetail = true;
        expect(new URL(url).searchParams.get('limit')).toBe('300');
        return response({
        chainId: 4663,
        tokenAddress: token.tokenAddress,
        marketKey: 'pool_cashcat:NATIVE',
        interval: '1m',
        status: 'READY',
        source: 'BITQUERY+CHAIN',
        items: [{ t: 1, o: '0.018', h: '0.019', l: '0.017', c: '0.0184', baseVolume: null, quoteVolume: null, revision: 1 }],
        });
      }
      throw new Error(`Unexpected request ${url}`);
    });

    render(<App />);
    expect(screen.getByText('正在加载')).toBeInTheDocument();
    expect(await screen.findAllByText('CASHCAT')).not.toHaveLength(0);
    await waitFor(() => expect(screen.getByLabelText('CASHCAT K 线图')).toBeInTheDocument());
    expect(candleRequestedBeforeDetail).toBe(true);
    resolveTokenDetail(await response(token));
    expect(screen.getByText('可用 0.42 ETH')).toBeInTheDocument();
    expect(screen.getByText('已登录')).toBeInTheDocument();
    expect(screen.queryByText(/账户暂不可用/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开账户划转' })).toBeEnabled();
    await waitFor(() => expect(document.querySelector('button.primary')).toBeEnabled());
    expect(document.querySelector('button.primary')).toHaveAccessibleName('买入');
    expect(screen.getByText('3%')).toBeInTheDocument();
    expect(screen.getAllByText('PONS').length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getAllByText('UNISWAP V4').length).toBeGreaterThan(0));
    expect(screen.getByText('税 1%')).toBeInTheDocument();
    expect(screen.getByText('已燃烧 95%')).toBeInTheDocument();
    expect(screen.getByText('非蜜罐')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '买入 CASHCAT' })).toBeEnabled();
    expect(screen.queryByText('预览交易')).not.toBeInTheDocument();
    expect(screen.queryByText('下单无需再次签名')).not.toBeInTheDocument();
    expect(screen.queryByText('拖动查看历史')).not.toBeInTheDocument();
    expect(screen.queryByText('Charts by TradingView')).not.toBeInTheDocument();
    expect(screen.queryByText('关于 CASHCAT')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '打开账户划转' }));
    expect(screen.getByRole('dialog', { name: 'Meme Account 划转' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认划转' }));
    expect(await screen.findByRole('button', { name: '划转成功 / 10001' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '关闭划转' }));

    fireEvent.change(screen.getByPlaceholderText('搜索代币或粘贴合约地址'), { target: { value: 'missing' } });
    expect(screen.getByText('没有匹配的代币')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('搜索代币或粘贴合约地址'), { target: { value: '' } });

    fireEvent.click(screen.getByRole('button', { name: '卖出' }));
    expect(screen.getByLabelText('卖出数量')).toBeInTheDocument();
    expect(screen.getByLabelText('结算资产')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '25%' }));
    expect(screen.getByRole('button', { name: '25%' })).toHaveClass('active');
    expect(screen.getByRole('button', { name: '50%' })).not.toHaveClass('active');
    expect(screen.getByRole('button', { name: '75%' })).not.toHaveClass('active');
    expect(screen.getByRole('button', { name: '100%' })).not.toHaveClass('active');
  });

  it.each(['config', 'markets'])('keeps a genuine %s bootstrap failure fatal after markets refresh', async (endpoint) => {
    vi.stubGlobal('WebSocket', undefined);
    let marketCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith('/config')) {
        if (endpoint === 'config') return Promise.reject(new Error('mock provider unavailable'));
        return response({ chainName: 'Robinhood Chain', defaultSlippageBps: 300 });
      }
      if (url.includes('/markets')) {
        marketCalls += 1;
        if (endpoint === 'markets' && marketCalls === 1) return Promise.reject(new Error('mock provider unavailable'));
        return response({ items: [token], stale: false });
      }
      return new Promise<Response>(() => {});
    });
    render(<App />);
    expect(await screen.findByText(/启动失败：.*网络请求失败/)).toBeInTheDocument();
    await waitFor(() => expect(marketCalls).toBeGreaterThanOrEqual(2), { timeout: 2_500 });
    expect(screen.getByText(/启动失败：.*网络请求失败/)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('搜索代币或粘贴合约地址')).not.toBeInTheDocument();
  });

  it.each([
    ['/uaapi/user/web3/get-nonce', '登录失败'],
    ['/uaapi/user/web3/login', '登录失败'],
    ['/uaapi/user/user/getDesensitizedUserInfo', '登录失败'],
    ['/account/summary', '账户余额加载失败'],
    ['/orders', '订单状态恢复失败'],
  ])('keeps empty markets browsable in an explicit account error when %s fails', async (endpoint, message) => {
    vi.stubGlobal('WebSocket', undefined);
    let marketCalls = 0;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith(endpoint)) return Promise.resolve(new Response(JSON.stringify({
        rc: 1, mc: 'AZ_ACCOUNT_UNAVAILABLE', ma: ['account service unavailable'], result: null,
      }), { status: 503, headers: { 'content-type': 'application/json' } }));
      if (url.endsWith('/config')) return response({
        chainId: 4663, chainName: 'Robinhood Chain', explorerBaseUrl: 'https://robinhoodchain.blockscout.com',
        defaultSlippageBps: 300, marketRefreshMs: { hot: 14_400_000, new: 300_000 },
        accountMode: 'AZ_ACCOUNT', settlementAssets: ['ETH', 'USDC', 'USDT'],
      });
      if (url.includes('/markets')) {
        marketCalls += 1;
        return response({ items: marketCalls === 1 ? [] : [token], stale: false });
      }
      if (url.endsWith('/uaapi/user/web3/get-nonce')) return response({ nonce: 'mock-nonce', message: 'AZ login message' });
      if (url.endsWith('/uaapi/user/web3/login')) return response({ accessToken: 'mock-az-session-token', expiresAt: Date.now() + 3600000 });
      if (url.endsWith('/uaapi/user/user/getDesensitizedUserInfo')) return response({ userId: 'mock-user', accountId: 'mock-account', loginStatus: 'LOGGED_IN' });
      if (url.endsWith('/account/summary')) return response({ quoteBalances: [], positions: [] });
      if (url.endsWith('/orders')) return response({ items: [], nextCursor: null });
      if (url.endsWith(`/tokens/${token.tokenAddress}`)) return response(token);
      if (url.includes('/trades?')) return response({ items: [], nextCursor: null });
      if (url.includes('/candles')) return response({ tokenAddress: token.tokenAddress, interval: '1m', items: [] });
      throw new Error(`Unexpected request ${url}`);
    });

    render(<App />);
    const warning = await screen.findByRole('alert');
    expect(warning).toHaveTextContent(`账户请求失败：${message}`);
    expect(screen.getByText('没有匹配的代币')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('搜索代币或粘贴合约地址')).toBeEnabled();
    expect(screen.getByRole('button', { name: '新币' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '打开账户划转' })).toBeDisabled();
    expect(document.querySelector('button.primary')).toBeDisabled();
    expect(screen.queryByText('登录中')).not.toBeInTheDocument();
    expect(screen.queryByText('已登录')).not.toBeInTheDocument();
    expect(screen.queryByText(/启动失败/)).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole('button', { name: '查看 CASHCAT' })).toBeInTheDocument(), { timeout: 2_500 });
    expect(await screen.findByLabelText('CASHCAT K 线图')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '查看 CASHCAT' }));
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('button', { name: '打开账户划转' })).toBeDisabled();
    expect(document.querySelector('button.primary')).toBeDisabled();
    expect(fetch.mock.calls.some(([input, init]) => String(input).endsWith('/quotes')
      || init?.method === 'POST' && /\/(orders|account\/transactions|fund\/balance\/transfer)$/.test(String(input)))).toBe(false);
    if (endpoint.includes('/uaapi/')) {
      expect(fetch.mock.calls.some(([input]) => String(input).endsWith('/account/summary') || String(input).endsWith('/orders'))).toBe(false);
      const [, refreshInit] = fetch.mock.calls.filter(([input]) => String(input).includes('/markets'))[1];
      expect(new Headers(refreshInit?.headers).has('authorization')).toBe(false);
    }
  });

  it('retries an empty market snapshot while workers warm the database', async () => {
    vi.stubGlobal('WebSocket', undefined);
    let marketCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith('/config')) return response({
        chainId: 4663,
        chainName: 'Robinhood Chain',
        explorerBaseUrl: 'https://robinhoodchain.blockscout.com',
        defaultSlippageBps: 300,
        marketRefreshMs: { hot: 14_400_000, new: 300_000 },
      });
      if (url.includes('/markets')) {
        marketCalls += 1;
        return response({ items: marketCalls === 1 ? [] : [token], stale: false });
      }
      if (url.endsWith(`/tokens/${token.tokenAddress}`)) return response(token);
      if (url.includes('/candles')) return response({
        chainId: 4663,
        tokenAddress: token.tokenAddress,
        marketKey: 'pool_cashcat:NATIVE',
        interval: '1m',
        status: 'READY',
        source: 'CHAIN',
        items: [{ t: 1, o: '0.018', h: '0.019', l: '0.017', c: '0.0184', baseVolume: null, quoteVolume: null, revision: 1 }],
      });
      if (url.includes('/trades?')) return response({ items: [], nextCursor: null });
      if (url.endsWith('/uaapi/user/web3/get-nonce')) return response({ nonce: 'mock-nonce', message: 'AZ login message' });
      if (url.endsWith('/uaapi/user/web3/login')) return response({ accessToken: 'mock-az-session-token', expiresAt: Date.now() + 3600000 });
      if (url.endsWith('/uaapi/user/user/getDesensitizedUserInfo')) return response({ userId: 'mock-user', accountId: 'mock-account', loginStatus: 'LOGGED_IN' });
      if (url.endsWith('/account/summary')) return response({ quoteBalances: [], positions: [] });
      if (url.endsWith('/orders')) return response({ items: [], nextCursor: null });
      if (url.endsWith('/quotes')) return response(quoteResult(init));
      throw new Error(`Unexpected request ${url}`);
    });

    render(<App />);
    expect(await screen.findByText('没有匹配的代币')).toBeInTheDocument();
    expect(await screen.findAllByText('CASHCAT', {}, { timeout: 2_500 })).not.toHaveLength(0);
    expect(marketCalls).toBeGreaterThanOrEqual(2);
  });

  it('uses the local main account without AZ login or transfer controls', async () => {
    vi.stubGlobal('WebSocket', undefined);
    let azRequests = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url.includes('/az-auth/') || url.includes('/sapi/v4/fund/')) {
        azRequests += 1;
        throw new Error(`Unexpected AZ request ${url}`);
      }
      if (url.endsWith('/config')) return response({
        chainId: 4663,
        chainName: 'Robinhood Chain',
        explorerBaseUrl: 'https://robinhoodchain.blockscout.com',
        defaultSlippageBps: 300,
        marketRefreshMs: { hot: 14_400_000, new: 300_000 },
        accountMode: 'MAIN_ACCOUNT_POC',
        mainAccountAddress: '0x9999999999999999999999999999999999999999',
        settlementAssets: ['USDG', 'ETH'],
      });
      if (url.includes('/markets')) return response({ items: [token], stale: false });
      if (url.endsWith(`/tokens/${token.tokenAddress}`)) return response(token);
      if (url.endsWith('/account/summary')) return response({
        quoteBalances: [
          { asset: 'USDG', available: '10', frozen: '0' },
          { asset: 'ETH', available: '0.01', frozen: '0' },
        ],
        positions: [],
      });
      if (url.includes('/account/transactions?')) return response({
        items: [{
          executionId: 'poc_history_1',
          tokenAddress: token.tokenAddress,
          tokenSymbol: token.symbol,
          side: 'BUY',
          settlementAsset: 'USDG',
          amountIn: '0.1',
          amountOut: '1000',
          status: 'CONFIRMED',
          txHashes: [`0x${'a'.repeat(64)}`],
          errorMessage: null,
          createdAt: 1,
          updatedAt: 1,
        }],
      });
      if (url.endsWith('/orders')) return response({ items: [], nextCursor: null });
      if (url.endsWith('/quotes')) return response(quoteResult(init));
      if (url.includes('/trades?')) return response({ items: [], nextCursor: null });
      if (url.includes('/candles')) return response({
        chainId: 4663,
        tokenAddress: token.tokenAddress,
        marketKey: 'pool_cashcat:NATIVE',
        interval: '1m',
        status: 'READY',
        source: 'BITQUERY+CHAIN',
        items: [],
      });
      throw new Error(`Unexpected request ${url}`);
    });

    render(<App />);

    expect(await screen.findByText('10 USDG / 0.01 ETH')).toBeInTheDocument();
    expect(screen.getByText('主账户已连接')).toBeInTheDocument();
    const paymentAsset = screen.getByLabelText('支付资产') as HTMLSelectElement;
    expect(paymentAsset).toHaveValue('USDG');
    expect(Array.from(paymentAsset.options, (option) => option.value)).toEqual(['USDG', 'ETH']);
    expect(screen.getByLabelText('买入金额')).toHaveValue('1');
    expect(screen.getByText('交易记录')).toBeInTheDocument();
    expect(screen.getByText('买入 CASHCAT')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Tx1 ↗' })).toHaveAttribute(
      'href',
      `https://robinhoodchain.blockscout.com/tx/0x${'a'.repeat(64)}`,
    );
    expect(screen.queryByRole('button', { name: '打开账户划转' })).not.toBeInTheDocument();
    expect(azRequests).toBe(0);
  });

  it('submits a real local main-account trade from the button and refreshes its result', async () => {
    const sent: string[] = [];
    let submittedBody: Record<string, unknown> | null = null;
    let accountLoads = 0;
    const executionId = '06983bd8-79ef-4e70-b4d4-e3cb4532bb58';
    class TradeWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static latest: TradeWebSocket | null = null;
      readyState = TradeWebSocket.CONNECTING;
      private readonly listeners = new Map<string, Array<(event: Event) => void>>();
      constructor(_url: string) {
        TradeWebSocket.latest = this;
        queueMicrotask(() => {
          this.readyState = TradeWebSocket.OPEN;
          this.emit('open', new Event('open'));
        });
      }
      addEventListener(name: string, listener: (event: Event) => void): void {
        this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
      }
      send(payload: string): void { sent.push(payload); }
      close(): void {
        if (this.readyState === TradeWebSocket.CLOSED) return;
        this.readyState = TradeWebSocket.CLOSED;
        this.emit('close', new Event('close'));
      }
      receive(payload: unknown): void {
        this.emit('message', { data: JSON.stringify(payload) } as MessageEvent);
      }
      private emit(name: string, event: Event): void {
        for (const listener of this.listeners.get(name) ?? []) listener(event);
      }
    }
    vi.stubGlobal('WebSocket', TradeWebSocket);
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(executionId);
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith('/config')) return response({
        chainId: 4663,
        chainName: 'Robinhood Chain',
        explorerBaseUrl: 'https://robinhoodchain.blockscout.com',
        defaultSlippageBps: 300,
        marketRefreshMs: { hot: 14_400_000, new: 300_000 },
        accountMode: 'MAIN_ACCOUNT_POC',
        mainAccountAddress: '0x9999999999999999999999999999999999999999',
        settlementAssets: ['USDG', 'ETH'],
      });
      if (url.includes('/markets')) return response({ items: [token], stale: false });
      if (url.endsWith(`/tokens/${token.tokenAddress}`)) return response(token);
      if (url.endsWith('/account/summary')) {
        accountLoads += 1;
        return response({
          quoteBalances: [{ asset: 'USDG', available: accountLoads > 1 ? '9.9' : '10', frozen: '0' }],
          positions: accountLoads > 1
            ? [{ tokenAddress: token.tokenAddress, symbol: token.symbol, available: '123', costUsd: '0', valueUsd: '2.26' }]
            : [],
        });
      }
      if (url.includes('/account/transactions?')) return response({
        items: submittedBody ? [{
          executionId,
          tokenAddress: token.tokenAddress,
          tokenSymbol: token.symbol,
          side: 'BUY',
          settlementAsset: 'USDG',
          amountIn: '1',
          amountOut: '123',
          status: 'CONFIRMED',
          txHashes: [`0x${'d'.repeat(64)}`],
          errorMessage: null,
          createdAt: 1,
          updatedAt: 2,
        }] : [],
      });
      if (url.endsWith('/account/transactions') && init?.method === 'POST') {
        submittedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return response({
          executionId,
          tokenAddress: token.tokenAddress,
          tokenSymbol: token.symbol,
          side: 'BUY',
          settlementAsset: 'USDG',
          amountIn: '1',
          amountOut: null,
          status: 'PENDING',
          txHashes: [],
          errorMessage: null,
          createdAt: 1,
          updatedAt: 1,
        });
      }
      if (url.endsWith(`/account/transactions/${executionId}`)) return response({
        executionId,
        tokenAddress: token.tokenAddress,
        tokenSymbol: token.symbol,
        side: 'BUY',
        settlementAsset: 'USDG',
        amountIn: '1',
        amountOut: '123',
        status: 'CONFIRMED',
        txHashes: [`0x${'d'.repeat(64)}`],
        errorMessage: null,
        createdAt: 1,
        updatedAt: 2,
      });
      if (url.endsWith('/orders')) return response({ items: [], nextCursor: null });
      if (url.endsWith('/quotes')) return response(quoteResult(init));
      if (url.endsWith('/ws-ticket')) return response({ ticket: 'trade-ticket', expiresAt: Date.now() + 30_000 });
      if (url.includes('/trades?')) return response({ items: [], nextCursor: null });
      if (url.includes('/candles')) return response({
        chainId: 4663,
        tokenAddress: token.tokenAddress,
        marketKey: 'pool_cashcat:NATIVE',
        interval: '1m',
        status: 'READY',
        source: 'BITQUERY+CHAIN',
        items: [],
      });
      throw new Error(`Unexpected request ${url}`);
    });

    render(<App />);
    await waitFor(() => expect(sent.some((payload) => (JSON.parse(payload) as { quote?: unknown }).quote)).toBe(true));
    act(() => {
      TradeWebSocket.latest?.receive({
        channel: `quote:${token.tokenAddress.toLowerCase()}`,
        epoch: 'trade-epoch',
        sequence: 1,
        data: {
          quoteId: 'live-quote-1',
          tokenAddress: token.tokenAddress,
          side: 'BUY',
          settlementAsset: 'USDG',
          amountIn: '1',
          expectedAmountOut: '123',
          minAmountOut: '120',
          fees: [],
          expiresAt: Date.now() + 10_000,
        },
      });
    });

    const buy = (await screen.findAllByRole('button', { name: '买入' })).at(-1)!;
    await waitFor(() => expect(buy).toBeEnabled());
    fireEvent.click(buy);

    await waitFor(() => expect(submittedBody).toMatchObject({
      clientExecutionId: executionId,
      side: 'BUY',
      tokenAddress: token.tokenAddress,
      settlementAsset: 'USDG',
      amountIn: '1',
      slippageBps: 300,
    }));
    expect(await screen.findByText('交易成功')).toBeInTheDocument();
    expect(await screen.findByText('1 USDG → 123 CASHCAT')).toBeInTheDocument();
    expect(await screen.findByText('123 枚')).toBeInTheDocument();
  });

  it('switches to the requested token even when its detail request fails', async () => {
    vi.stubGlobal('WebSocket', undefined);
    const second = {
      ...token,
      tokenAddress: '0x2222222222222222222222222222222222222022',
      symbol: 'SECOND',
      name: 'Second token',
      pool: { ...token.pool, poolKey: 'pool_second' },
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith('/uaapi/user/web3/get-nonce')) return response({ nonce: 'mock-nonce', message: 'AZ login message' });
      if (url.endsWith('/uaapi/user/web3/login')) return response({ accessToken: 'mock-az-session-token', expiresAt: Date.now() + 3600000 });
      if (url.endsWith('/uaapi/user/user/getDesensitizedUserInfo')) return response({ userId: 'mock-user', accountId: 'mock-account', loginStatus: 'LOGGED_IN' });
      if (url.endsWith('/config')) return response({
        chainId: 4663,
        chainName: 'Robinhood Chain',
        explorerBaseUrl: 'https://robinhoodchain.blockscout.com',
        defaultSlippageBps: 300,
        marketRefreshMs: { hot: 14_400_000, new: 300_000 },
      });
      if (url.includes('/markets')) return response({ items: [token, second], stale: false });
      if (url.endsWith(`/tokens/${token.tokenAddress}`)) return response(token);
      if (url.endsWith(`/tokens/${second.tokenAddress}`)) {
        return Promise.resolve(new Response(JSON.stringify({ rc: 1, mc: 'MEME_PROVIDER_ERROR', ma: ['upstream failed'], result: null }), { status: 502 }));
      }
      if (url.includes(`/tokens/${second.tokenAddress}/candles`)) return response({
        chainId: 4663, tokenAddress: second.tokenAddress, marketKey: 'pool_second:NATIVE', interval: '1m', status: 'READY', source: 'BITQUERY+CHAIN', items: [],
      });
      if (url.includes('/candles')) return response({
        chainId: 4663, tokenAddress: token.tokenAddress, marketKey: 'pool_cashcat:NATIVE', interval: '1m', status: 'READY', source: 'BITQUERY+CHAIN', items: [],
      });
      if (url.endsWith('/account/summary')) return response({ quoteBalances: [], positions: [] });
      if (url.endsWith('/orders')) return response({ items: [], nextCursor: null });
      if (url.endsWith('/quotes')) return response(quoteResult(init));
      if (url.includes('/trades?')) return response({ items: [], nextCursor: null });
      throw new Error(`Unexpected request ${url}`);
    });

    render(<App />);
    const target = await screen.findByRole('button', { name: '查看 SECOND' });
    fireEvent.click(target);

    await waitFor(() => expect(document.querySelector('.token-title strong')).toHaveTextContent(/^SECOND$/));
    expect(screen.queryByText('代币详情加载失败')).not.toBeInTheDocument();
  });

  it('loads 100 persisted trades, pages to older rows, and copies rendered addresses', async () => {
    vi.stubGlobal('WebSocket', undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const storedTrades = Array.from({ length: 102 }, (_, index) => ({
      tradeId: `stored-${index}`,
      t: Math.floor(Date.now() / 1000) - index,
      side: index % 2 === 0 ? 'BUY' : 'SELL',
      priceUsd: String(0.02 + index / 10_000),
      baseAmount: String(index + 1),
      notionalUsd: String((index + 1) * (0.02 + index / 10_000)),
      quoteAmount: '0.1',
      quoteAsset: 'SPCX',
      trader: `0x${index.toString(16).padStart(40, '0')}`,
      txHash: `0x${index.toString(16).padStart(64, '0')}`,
    }));
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith('/uaapi/user/web3/get-nonce')) return response({ nonce: 'mock-nonce', message: 'AZ login message' });
      if (url.endsWith('/uaapi/user/web3/login')) return response({ accessToken: 'mock-az-session-token', expiresAt: Date.now() + 3600000 });
      if (url.endsWith('/uaapi/user/user/getDesensitizedUserInfo')) return response({ userId: 'mock-user', accountId: 'mock-account', loginStatus: 'LOGGED_IN' });
      if (url.endsWith('/config')) return response({
        chainId: 4663,
        chainName: 'Robinhood Chain',
        explorerBaseUrl: 'https://robinhoodchain.blockscout.com',
        defaultSlippageBps: 300,
        marketRefreshMs: { hot: 14_400_000, new: 300_000 },
      });
      if (url.includes('/markets')) return response({ items: [token], stale: false });
      if (url.endsWith(`/tokens/${token.tokenAddress}`)) return response(token);
      if (url.endsWith('/account/summary')) return response({ quoteBalances: [], positions: [] });
      if (url.endsWith('/orders')) return response({ items: [], nextCursor: null });
      if (url.endsWith('/quotes')) return response(quoteResult(init));
      if (url.includes('/candles')) return response({
        chainId: 4663,
        tokenAddress: token.tokenAddress,
        marketKey: 'pool_cashcat:NATIVE',
        interval: '1m',
        status: 'READY',
        source: 'BITQUERY+CHAIN',
        items: [],
      });
      if (url.includes('/trades?')) {
        const cursor = new URL(url).searchParams.get('cursor');
        return cursor === 'older-page'
          ? response({ items: storedTrades.slice(100), nextCursor: null })
          : response({ items: storedTrades.slice(0, 100), nextCursor: 'older-page' });
      }
      throw new Error(`Unexpected request ${url}`);
    });

    render(<App />);
    expect(await screen.findByText('100 笔')).toBeInTheDocument();
    expect(screen.getByText('Quote')).toBeInTheDocument();
    expect(screen.getByText('Value')).toBeInTheDocument();
    expect(screen.getAllByText('0.1 SPCX')).toHaveLength(100);
    expect(screen.getAllByTestId('trade-value')[0]).toHaveTextContent('$0.02');
    expect(screen.getAllByRole('link', { name: /打开交易者地址/ })[0]).toHaveAttribute(
      'href',
      `https://robinhoodchain.blockscout.com/address/${storedTrades[0]!.trader}`,
    );
    const tradeRows = screen.getByLabelText('实时成交').querySelector('.trade-rows') as HTMLDivElement;
    Object.defineProperties(tradeRows, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, value: 600 },
    });
    fireEvent.scroll(tradeRows);
    expect(await screen.findByText('102 笔')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /查看交易/ })).toHaveLength(102);

    fireEvent.click(screen.getByRole('button', { name: `复制地址 ${token.tokenAddress}` }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(token.tokenAddress));
    fireEvent.click(screen.getByRole('button', { name: `复制地址 ${storedTrades[0]!.trader}` }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(storedTrades[0]!.trader));
  });

  it('renders authoritative trade notionals, including a PONS trade and the 0.01 USD boundary', async () => {
    renderWithDeferredQuotes();
    await waitFor(() => expect(ControlledQuoteSocket.latest).not.toBeNull());
    const socket = ControlledQuoteSocket.latest!;
    act(() => socket.open());
    await waitFor(() => expect(socket.sent.some((payload) =>
      (JSON.parse(payload) as { channels: string[] }).channels.includes(`trade:${token.tokenAddress.toLowerCase()}:USD:USDG`))).toBe(true));

    const shared = {
      t: Math.floor(Date.now() / 1000), side: 'BUY', quoteAsset: 'SPCX',
      trader: `0x${'a'.repeat(40)}`, txHash: `0x${'b'.repeat(64)}`,
    };
    act(() => socket.receive({
      channel: `trade:${token.tokenAddress.toLowerCase()}:USD:USDG`, epoch: 'notional-test', sequence: 1,
      data: { items: [
        { ...shared, tradeId: 'boundary', baseAmount: '1', priceUsd: '0.02',
          quoteAmount: '0.01', notionalUsd: '0.01' },
        { ...shared, tradeId: 'pons', protocol: 'PONS', poolKey: 'pool_cashcat',
          baseAmount: '100', priceUsd: '0.02', counterAmount: '0.005',
          quoteAmount: '0.1', notionalUsd: '0.37' },
      ] },
    }));

    expect(screen.getAllByTestId('trade-value').map((value) => value.textContent)).toEqual(['$0.37', '$0.01']);
    const ponsRow = screen.getAllByTestId('trade-value')[0]!.closest('.trade-row');
    expect(ponsRow).toHaveTextContent('0.1 SPCX');
    expect(ponsRow).not.toHaveTextContent('0.005 SPCX');
  });

  it('marks missing and invalid trade notionals unavailable without deriving a value from price', async () => {
    renderWithDeferredQuotes();
    await waitFor(() => expect(ControlledQuoteSocket.latest).not.toBeNull());
    const socket = ControlledQuoteSocket.latest!;
    act(() => socket.open());
    await waitFor(() => expect(socket.sent.some((payload) =>
      (JSON.parse(payload) as { channels: string[] }).channels.includes(`trade:${token.tokenAddress.toLowerCase()}:USD:USDG`))).toBe(true));
    const shared = {
      t: Math.floor(Date.now() / 1000), side: 'BUY', quoteAsset: 'SPCX',
      trader: `0x${'a'.repeat(40)}`, txHash: `0x${'b'.repeat(64)}`,
      baseAmount: '100', priceUsd: '2', quoteAmount: '0.1',
    };
    act(() => socket.receive({
      channel: `trade:${token.tokenAddress.toLowerCase()}:USD:USDG`, epoch: 'legacy-notional', sequence: 1,
      data: { items: [
        { ...shared, tradeId: 'missing' },
        { ...shared, tradeId: 'invalid', notionalUsd: 'Infinity' },
        { ...shared, tradeId: 'zero', notionalUsd: '0' },
      ] },
    }));
    expect(screen.getAllByTestId('trade-value').map((value) => value.textContent)).toEqual(['$0', '—', '—']);
  });

  it('loads an initial REST quote while the market socket is still connecting', async () => {
    const { quotes } = renderWithDeferredQuotes();
    await waitFor(() => expect(quotes).toHaveLength(1));
    await waitFor(() => expect(ControlledQuoteSocket.latest).not.toBeNull());
    expect(ControlledQuoteSocket.latest?.readyState).toBe(ControlledQuoteSocket.CONNECTING);
    expect(quotes[0]!.input).toMatchObject({ side: 'BUY', tokenAddress: token.tokenAddress, settlementAsset: 'USDG', amountIn: '1' });

    await act(async () => { quotes[0]!.resolve(await response({ ...quotes[0]!.input, expectedAmountOut: '100' })); });
    await waitFor(() => expect(displayedQuote()).toBe('≈ 100 CASHCAT'));

    act(() => ControlledQuoteSocket.latest?.open());
    expect(ControlledQuoteSocket.latest?.sent.some((payload) =>
      (JSON.parse(payload) as { quote?: { amountIn: string } }).quote?.amountIn === '1')).toBe(true);
    expect(quotes).toHaveLength(1);
  });

  it('keeps the quote when quick buy and an already selected amount leave the request unchanged', async () => {
    const { quotes } = renderWithDeferredQuotes();
    await waitFor(() => expect(quotes).toHaveLength(1));
    await act(async () => { quotes[0]!.resolve(await response({ ...quotes[0]!.input, expectedAmountOut: '100' })); });
    await waitFor(() => expect(displayedQuote()).toBe('≈ 100 CASHCAT'));

    fireEvent.click(screen.getByRole('button', { name: '买入 CASHCAT' }));
    fireEvent.click(screen.getByRole('button', { name: /^1$/ }));
    expect(displayedQuote()).toBe('≈ 100 CASHCAT');
    expect(quotes).toHaveLength(1);
  });

  it('rejects a late REST quote after the amount changes', async () => {
    const { quotes } = renderWithDeferredQuotes();
    await waitFor(() => expect(quotes).toHaveLength(1));
    fireEvent.change(screen.getByLabelText('买入金额'), { target: { value: '2' } });
    await waitFor(() => expect(quotes).toHaveLength(2));
    expect(quotes[0]!.signal?.aborted).toBe(true);
    expect(quotes[1]!.input.amountIn).toBe('2');

    await act(async () => { quotes[1]!.resolve(await response({ ...quotes[1]!.input, expectedAmountOut: '200' })); });
    await waitFor(() => expect(displayedQuote()).toBe('≈ 200 CASHCAT'));
    await act(async () => { quotes[0]!.resolve(await response({ ...quotes[0]!.input, expectedAmountOut: '999' })); });
    expect(displayedQuote()).toBe('≈ 200 CASHCAT');
  });

  it('lets matching live WS quotes replace REST quotes and ignores an older REST completion', async () => {
    const { quotes } = renderWithDeferredQuotes();
    await waitFor(() => expect(quotes).toHaveLength(1));
    await act(async () => { quotes[0]!.resolve(await response({ ...quotes[0]!.input, expectedAmountOut: '100' })); });
    await waitFor(() => expect(displayedQuote()).toBe('≈ 100 CASHCAT'));
    await waitFor(() => expect(ControlledQuoteSocket.latest).not.toBeNull());
    act(() => ControlledQuoteSocket.latest?.open());

    act(() => ControlledQuoteSocket.latest?.receive({
      channel: `quote:${token.tokenAddress.toLowerCase()}`, epoch: 'quote-test', sequence: 1,
      data: { ...quotes[0]!.input, quoteId: 'live-quote', expectedAmountOut: '150' },
    }));
    expect(displayedQuote()).toBe('≈ 150 CASHCAT');

    fireEvent.change(screen.getByLabelText('买入金额'), { target: { value: '2' } });
    await waitFor(() => expect(quotes).toHaveLength(2));
    act(() => ControlledQuoteSocket.latest?.receive({
      channel: `quote:${token.tokenAddress.toLowerCase()}`, epoch: 'quote-test', sequence: 2,
      data: { ...quotes[1]!.input, quoteId: 'new-live-quote', expectedAmountOut: '250' },
    }));
    expect(displayedQuote()).toBe('≈ 250 CASHCAT');
    await act(async () => { quotes[1]!.resolve(await response({ ...quotes[1]!.input, expectedAmountOut: '200' })); });
    expect(displayedQuote()).toBe('≈ 250 CASHCAT');
  });
});
