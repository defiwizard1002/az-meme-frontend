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
  return Promise.resolve(new Response(JSON.stringify({ rc: 0, mc: 'SUCCESS', ma: [], result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
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

  it('switches to the requested token even when its detail request fails', async () => {
    vi.stubGlobal('WebSocket', undefined);
    const second = {
      ...token,
      tokenAddress: '0x2222222222222222222222222222222222222022',
      symbol: 'SECOND',
      name: 'Second token',
      pool: { ...token.pool, poolKey: 'pool_second' },
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
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
      throw new Error(`Unexpected request ${url}`);
    });

    render(<App />);
    const target = await screen.findByRole('button', { name: '查看 SECOND' });
    fireEvent.click(target);

    expect(await screen.findByText('SECOND / ETH')).toBeInTheDocument();
    expect(screen.queryByText('代币详情加载失败')).not.toBeInTheDocument();
  });

  it('shows persisted candles while realtime scanning catches up', async () => {
    const sent: string[] = [];
    const marketToken = {
      ...token,
      quoteAssetKey: 'OTHER' as const,
      pool: { ...token.pool, poolKey: 'pool_cashcat_other', quoteTokenSymbol: 'GOOGL' },
      tradeStatus: 'UNSUPPORTED_POOL_TYPE' as const,
    };
    class TestWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static latest: TestWebSocket | null = null;
      static created = 0;
      static active = 0;
      static maxActive = 0;
      readyState = TestWebSocket.CONNECTING;
      private readonly listeners = new Map<string, Array<(event: Event) => void>>();
      constructor(_url: string) {
        TestWebSocket.created += 1;
        TestWebSocket.active += 1;
        TestWebSocket.maxActive = Math.max(TestWebSocket.maxActive, TestWebSocket.active);
        TestWebSocket.latest = this;
        queueMicrotask(() => {
          if (this.readyState === TestWebSocket.CLOSED) return;
          this.readyState = TestWebSocket.OPEN;
          this.emit('open', new Event('open'));
        });
      }
      addEventListener(name: string, listener: (event: Event) => void): void {
        this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
      }
      send(payload: string): void { sent.push(payload); }
      close(): void {
        if (this.readyState === TestWebSocket.CLOSED) return;
        this.readyState = TestWebSocket.CLOSED;
        TestWebSocket.active -= 1;
        this.emit('close', new Event('close'));
      }
      receive(payload: unknown): void {
        this.emit('message', { data: JSON.stringify(payload) } as MessageEvent);
      }
      private emit(name: string, event: Event): void {
        for (const listener of this.listeners.get(name) ?? []) listener(event);
      }
    }
    vi.stubGlobal('WebSocket', TestWebSocket);
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
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
      if (url.includes('/markets')) return response({ items: [marketToken], stale: false });
      if (url.endsWith(`/tokens/${marketToken.tokenAddress}`)) return response(marketToken);
      if (url.endsWith('/account/summary')) return response({ quoteBalances: [], positions: [] });
      if (url.endsWith('/orders')) return response({ items: [], nextCursor: null });
      if (url.endsWith('/ws-ticket')) return response({ ticket: 'ticket', expiresAt: Date.now() + 30_000 });
      if (url.includes('/candles')) {
        const requestedInterval = new URL(url).searchParams.get('interval');
        return response({
          chainId: 4663,
          tokenAddress: marketToken.tokenAddress,
          marketKey: 'pool_cashcat_other:OTHER',
          interval: requestedInterval,
          status: 'CATCHING_UP',
          source: 'BITQUERY+CHAIN',
          items: [{ t: 1, o: '0.018', h: '0.019', l: '0.017', c: '0.0184', baseVolume: '1', quoteVolume: '1', revision: 1 }],
        });
      }
      throw new Error(`Unexpected request ${url}`);
    });

    render(<App />);
    await waitFor(() => expect(sent.some((payload) => {
      const message = JSON.parse(payload) as { op?: string; channels?: string[] };
      return message.op === 'subscribe' && message.channels?.some((channel) => channel.startsWith('candle:'));
    })).toBe(true));
    expect(screen.getByLabelText('CASHCAT K 线图')).toBeInTheDocument();

    const subscription = sent
      .map((payload) => JSON.parse(payload) as { channels?: string[] })
      .find((message) => message.channels?.some((channel) => channel.startsWith('trade:')));
    expect(subscription).not.toHaveProperty('quote');
    const tradeChannel = subscription?.channels?.find((channel) => channel.startsWith('trade:'));
    expect(tradeChannel).toBeDefined();
    expect(TestWebSocket.latest).not.toBeNull();

    act(() => {
      TestWebSocket.latest?.receive({
        channel: 'markets:live',
        epoch: 'epoch-1',
        sequence: 1,
        data: { items: [{ ...marketToken, priceUsd: '0.02', change24h: '90' }] },
      });
      for (let sequence = 1; sequence <= 5; sequence += 1) {
        const start = (sequence - 1) * 5 + 1;
        TestWebSocket.latest?.receive({
          channel: tradeChannel,
          epoch: 'epoch-1',
          sequence,
          data: {
            items: Array.from({ length: 5 }, (_, offset) => {
              const tradeNumber = start + offset;
              const suffix = tradeNumber.toString(16).padStart(64, '0');
              return {
                tradeId: `trade-${tradeNumber}`,
                t: Math.floor(Date.now() / 1000) - tradeNumber,
                side: tradeNumber % 2 === 0 ? 'SELL' : 'BUY',
                priceUsd: `0.0${tradeNumber}`,
                baseAmount: String(tradeNumber),
                quoteAmount: '0.1',
                quoteAsset: 'ETH',
                trader: `0x${String(tradeNumber).padStart(40, '0')}`,
                txHash: `0x${suffix}`,
              };
            }),
          },
        });
      }
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(TestWebSocket.created).toBe(1);
    expect(TestWebSocket.active).toBe(1);
    expect(TestWebSocket.maxActive).toBe(1);

    expect(await screen.findByText('25 笔')).toBeInTheDocument();
    const newestTxLink = screen.getAllByRole('link', { name: /查看交易/ })[0];
    expect(newestTxLink).toHaveAttribute('href', `https://robinhoodchain.blockscout.com/tx/0x${'19'.padStart(64, '0')}`);
    expect(screen.getAllByRole('link', { name: /查看交易/ })).toHaveLength(20);
    const tradeRows = screen.getByLabelText('实时成交').querySelector('.trade-rows') as HTMLDivElement;
    Object.defineProperties(tradeRows, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, value: 600 },
    });
    fireEvent.scroll(tradeRows);
    expect(screen.getAllByRole('link', { name: /查看交易/ })).toHaveLength(25);
    expect(screen.getAllByText(/2[5-7]s/).length).toBeGreaterThan(0);

    const candleStatusChannel = subscription?.channels?.find((channel) => channel.startsWith('candle-status:'));
    expect(candleStatusChannel).toBeDefined();
    act(() => {
      TestWebSocket.latest?.receive({
        channel: candleStatusChannel,
        epoch: 'epoch-1',
        sequence: 1,
        data: {
          chainId: 4663,
          tokenAddress: marketToken.tokenAddress,
          marketKey: 'pool_cashcat_other:OTHER',
          interval: '1m',
          status: 'READY',
          source: 'BITQUERY+CHAIN',
          items: [{ t: 1, o: '0.018', h: '0.019', l: '0.017', c: '0.0184', baseVolume: '1', quoteVolume: '1', revision: 1 }],
        },
      });
    });
    expect(await screen.findByLabelText('CASHCAT K 线图')).toBeInTheDocument();

    act(() => TestWebSocket.latest?.close());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_100)); });
    await waitFor(() => expect(TestWebSocket.created).toBe(2));
    expect(TestWebSocket.active).toBe(1);
    expect(TestWebSocket.maxActive).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: '1s' }));
    await waitFor(() => expect(TestWebSocket.created).toBe(3));
    expect(TestWebSocket.active).toBe(1);
    expect(TestWebSocket.maxActive).toBe(1);
    expect(screen.getByText('25 笔')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /查看交易/ })).toHaveLength(25);
  });
});
