import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';

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
    result = { ...candle, marketKey: 'USD:USDG', syncStatus: candle.syncStatus ?? candle.status ?? 'READY',
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

function renderWithDeferredQuotes() {
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
      settlementAssets: ['USDG', 'ETH'],
    });
    if (url.includes('/markets')) return response({ items: [token], stale: false });
    if (url.endsWith(`/tokens/${token.tokenAddress}`)) return response(token);
    if (url.endsWith('/account/summary')) return response({ quoteBalances: [{ asset: 'USDG', available: '10', frozen: '0' }], positions: [] });
    if (url.includes('/account/transactions?')) return response({ items: [] });
    if (url.endsWith('/orders')) return response({ items: [], nextCursor: null });
    if (url.endsWith('/ws-ticket')) return response({ ticket: 'test-ticket', expiresAt: Date.now() + 30_000 });
    if (url.includes('/trades?')) return response({ items: [], nextCursor: null });
    if (url.includes('/candles')) return response({
      chainId: 4663, tokenAddress: token.tokenAddress, interval: '1m', source: 'CHAIN',
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
  afterEach(() => {
    cleanup();
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

  it('shows an explicit startup error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('mock provider unavailable'));
    render(<App />);
    expect(await screen.findByText('启动失败：mock provider unavailable')).toBeInTheDocument();
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
    expect(screen.getByText('验证账户')).toBeInTheDocument();
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

    expect(await screen.findByText('SECOND / ETH')).toBeInTheDocument();
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
