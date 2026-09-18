import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';

const token = {
  chainId: 4663,
  tokenAddress: '0x1111111111111111111111111111111111111011',
  symbol: 'CASHCAT',
  name: 'Cash Cat',
  stage: 'GRADUATED',
  priceUsd: '0.0184',
  change5m: '41',
  holders: 4120,
  ageSeconds: 720,
  pool: { poolKey: 'pool_cashcat', poolType: 'UNISWAP_V4', liquidityUsd: '3200000' },
  tradeStatus: 'TRADABLE',
  riskFlags: [],
};

function response(result: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ rc: 0, mc: 'SUCCESS', ma: [], result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
}

describe('App', () => {
  afterEach(() => vi.restoreAllMocks());

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
      if (url.endsWith('/config')) return response({ chainId: 4663, chainName: 'Robinhood Chain', defaultSlippageBps: 500 });
      if (url.includes('/markets')) return response({ items: [token], stale: false });
      if (url.endsWith('/account/summary')) {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer mock-az-session-token');
        return response({
        quoteBalances: [{ asset: 'ETH', available: '0.42', frozen: '0' }, { asset: 'USDC', available: '1250', frozen: '0' }],
        positions: [{ tokenAddress: token.tokenAddress, symbol: 'CASHCAT', available: '1000', costUsd: '100', valueUsd: '141' }],
        });
      }
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
        source: 'GECKOTERMINAL',
        items: [{ t: 1, o: '0.018', h: '0.019', l: '0.017', c: '0.0184', baseVolume: null, quoteVolume: null, revision: 1 }],
      });
      throw new Error(`Unexpected request ${url}`);
    });

    render(<App />);
    expect(screen.getByText('正在连接 AZ MEME BOT Mock 服务')).toBeInTheDocument();
    expect(await screen.findAllByText('CASHCAT')).not.toHaveLength(0);
    await waitFor(() => expect(screen.getByLabelText('CASHCAT K 线图')).toBeInTheDocument());
    expect(screen.getByText('可用 0.42 ETH')).toBeInTheDocument();
    expect(screen.getByText('MOCK 已登录')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '打开账户划转' }));
    expect(screen.getByRole('dialog', { name: 'Meme Account 划转' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认划转' }));
    expect(await screen.findByRole('button', { name: '划转成功 · 10001' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '关闭划转' }));

    fireEvent.change(screen.getByPlaceholderText('粘贴代币合约地址 0x...'), { target: { value: 'missing' } });
    expect(screen.getByText('没有匹配的代币')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('粘贴代币合约地址 0x...'), { target: { value: '' } });

    fireEvent.click(screen.getByRole('button', { name: '卖' }));
    expect(screen.getByLabelText('卖出数量')).toBeInTheDocument();
    expect(screen.getByLabelText('结算资产')).toBeInTheDocument();
  });

  it('shows an explicit startup error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('mock provider unavailable'));
    render(<App />);
    expect(await screen.findByText('启动失败：mock provider unavailable')).toBeInTheDocument();
  });
});
