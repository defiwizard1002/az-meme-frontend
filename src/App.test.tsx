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
  security: { isHoneypot: false, buyTaxPct: '0', sellTaxPct: '0', liquidityLocked: true },
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
      if (url.endsWith(`/tokens/${token.tokenAddress}`)) return response(token);
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
      if (url.includes('/candles')) return response({
        chainId: 4663,
        tokenAddress: token.tokenAddress,
        marketKey: 'pool_cashcat:NATIVE',
        interval: '1m',
        status: 'READY',
        source: 'BITQUERY+CHAIN',
        items: [{ t: 1, o: '0.018', h: '0.019', l: '0.017', c: '0.0184', baseVolume: null, quoteVolume: null, revision: 1 }],
      });
      throw new Error(`Unexpected request ${url}`);
    });

    render(<App />);
    expect(screen.getByText('正在加载')).toBeInTheDocument();
    expect(await screen.findAllByText('CASHCAT')).not.toHaveLength(0);
    await waitFor(() => expect(screen.getByLabelText('CASHCAT K 线图')).toBeInTheDocument());
    expect(screen.getByText('可用 0.42 ETH')).toBeInTheDocument();
    expect(screen.getByText('已登录')).toBeInTheDocument();
    expect(screen.getByText('3%')).toBeInTheDocument();
    expect(screen.getAllByText('PONS').length).toBeGreaterThan(0);
    expect(screen.getAllByText('UNISWAP V4').length).toBeGreaterThan(0);
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

  it('subscribes while catching up but keeps the chart hidden until READY', async () => {
    const sent: string[] = [];
    class TestWebSocket {
      static readonly OPEN = 1;
      static latest: TestWebSocket | null = null;
      readonly readyState = TestWebSocket.OPEN;
      private readonly listeners = new Map<string, Array<(event: Event) => void>>();
      constructor(_url: string) {
        TestWebSocket.latest = this;
        queueMicrotask(() => this.emit('open', new Event('open')));
      }
      addEventListener(name: string, listener: (event: Event) => void): void {
        this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
      }
      send(payload: string): void { sent.push(payload); }
      close(): void { this.emit('close', new Event('close')); }
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
      if (url.includes('/markets')) return response({ items: [token], stale: false });
      if (url.endsWith(`/tokens/${token.tokenAddress}`)) return response(token);
      if (url.endsWith('/account/summary')) return response({ quoteBalances: [], positions: [] });
      if (url.endsWith('/orders')) return response({ items: [], nextCursor: null });
      if (url.endsWith('/ws-ticket')) return response({ ticket: 'ticket', expiresAt: Date.now() + 30_000 });
      if (url.includes('/candles')) return response({
        chainId: 4663,
        tokenAddress: token.tokenAddress,
        marketKey: 'pool_cashcat:NATIVE',
        interval: '1m',
        status: 'CATCHING_UP',
        source: 'BITQUERY+CHAIN',
        items: [{ t: 1, o: '0.018', h: '0.019', l: '0.017', c: '0.0184', baseVolume: '1', quoteVolume: '1', revision: 1 }],
      });
      throw new Error(`Unexpected request ${url}`);
    });

    render(<App />);
    await waitFor(() => expect(sent.some((payload) => {
      const message = JSON.parse(payload) as { op?: string; channels?: string[] };
      return message.op === 'subscribe' && message.channels?.some((channel) => channel.startsWith('candle:'));
    })).toBe(true));
    expect(screen.getByText('正在加载行情')).toBeInTheDocument();
    expect(screen.queryByLabelText('CASHCAT K 线图')).not.toBeInTheDocument();

    const subscription = sent
      .map((payload) => JSON.parse(payload) as { channels?: string[] })
      .find((message) => message.channels?.some((channel) => channel.startsWith('trade:')));
    const tradeChannel = subscription?.channels?.find((channel) => channel.startsWith('trade:'));
    expect(tradeChannel).toBeDefined();
    expect(TestWebSocket.latest).not.toBeNull();

    act(() => {
      for (let sequence = 1; sequence <= 25; sequence += 1) {
        const suffix = sequence.toString(16).padStart(64, '0');
        TestWebSocket.latest?.receive({
          channel: tradeChannel,
          epoch: 'epoch-1',
          sequence,
          data: {
            tradeId: `trade-${sequence}`,
            t: 1_700_000_000 + sequence,
            side: sequence % 2 === 0 ? 'SELL' : 'BUY',
            priceUsd: `0.0${sequence}`,
            baseAmount: String(sequence),
            quoteAmount: '0.1',
            quoteAsset: 'ETH',
            trader: `0x${String(sequence).padStart(40, '0')}`,
            txHash: `0x${suffix}`,
          },
        });
      }
    });

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

    fireEvent.click(screen.getByRole('button', { name: '1s' }));
    expect(screen.getByText('25 笔')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /查看交易/ })).toHaveLength(25);
  });
});
