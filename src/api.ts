import type { AccountSummary, Asset, CandleSnapshot, Interval, Quote, Token } from './types';

interface Envelope<T> {
  rc: number;
  mc: string;
  ma: string[];
  result: T;
}

const apiBaseUrl = (import.meta.env.VITE_MEME_API_BASE_URL as string | undefined) ?? 'http://127.0.0.1:3000';
const azApiBaseUrl = (import.meta.env.VITE_AZ_API_BASE_URL as string | undefined) ?? 'http://127.0.0.1:4100';
let sessionToken: string | null = null;

export function setSessionToken(token: string | null): void {
  sessionToken = token;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set('content-type', 'application/json');
  if (sessionToken) headers.set('authorization', `Bearer ${sessionToken}`);
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers,
  });
  const payload = await response.json() as Envelope<T>;
  if (!response.ok || payload.rc !== 0) {
    throw new Error(payload.ma?.[0] ?? payload.mc ?? `HTTP ${response.status}`);
  }
  return payload.result;
}

async function requestAz<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set('content-type', 'application/json');
  if (sessionToken) headers.set('authorization', `Bearer ${sessionToken}`);
  const response = await fetch(`${azApiBaseUrl}${path}`, { ...init, headers });
  const payload = await response.json() as Envelope<T>;
  if (!response.ok || payload.rc !== 0) {
    throw new Error(payload.ma?.[0] ?? payload.mc ?? `HTTP ${response.status}`);
  }
  return payload.result;
}

export const azAuth = {
  loginMock: async () => {
    const sourceAddr = `0x${'7'.repeat(40)}`;
    const nonce = await requestAz<{ nonce: string; message: string }>('/az-auth/uaapi/user/web3/get-nonce', {
      method: 'POST',
      body: JSON.stringify({ sourceAddr, type: 'LOGIN', chainType: 'ETHEREUM' }),
    });
    if (!nonce.message) throw new Error('AZ nonce response is missing the sign message');
    const login = await requestAz<{ accessToken: string; expiresAt: number }>('/az-auth/uaapi/user/web3/login', {
      method: 'POST',
      body: JSON.stringify({
        signature: '0xmock-signature',
        sourceAddr,
        chainType: 'ETHEREUM',
        chainId: 1,
        loginType: 'WALLET',
      }),
    });
    setSessionToken(login.accessToken);
    const user = await requestAz<{ userId: string; accountId: string; loginStatus: string }>('/az-auth/uaapi/user/user/getDesensitizedUserInfo');
    return { ...user, expiresAt: login.expiresAt };
  },
};

export const azFundApi = {
  transfer: (input: { bizId: string; from: 'SPOT' | 'MEME'; to: 'SPOT' | 'MEME'; currency: Asset; amount: string }) =>
    requestAz<number>('/sapi/v4/fund/balance/transfer', { method: 'POST', body: JSON.stringify(input) }),
};

export const memeApi = {
  getConfig: () => request<{ chainId: number; chainName: string; defaultSlippageBps: number }>('/sapi/v1/meme/config'),
  getMarkets: (tab: 'hot' | 'new' = 'hot') => request<{ items: Token[]; stale: boolean }>(`/sapi/v1/meme/markets?tab=${tab}&limit=50`),
  getCandles: (tokenAddress: string, interval: Interval, options?: { to?: number; limit?: number }) => {
    const query = new URLSearchParams({ interval, limit: String(options?.limit ?? 120) });
    if (options?.to !== undefined) query.set('to', String(options.to));
    return request<CandleSnapshot>(`/sapi/v1/meme/tokens/${tokenAddress}/candles?${query.toString()}`);
  },
  getAccount: () => request<AccountSummary>('/sapi/v1/meme/account/summary'),
  createQuote: (input: { side: 'BUY' | 'SELL'; tokenAddress: string; settlementAsset: Asset; amountIn: string; slippageBps: number }) =>
    request<Quote>('/sapi/v1/meme/quotes', { method: 'POST', body: JSON.stringify(input) }),
  createOrder: (input: { clientOrderId: string; quoteId: string; maxAmountIn: string; minAmountOut: string }) =>
    request<{ orderId: string; status: string; fundStatus: string }>('/sapi/v1/meme/orders', { method: 'POST', body: JSON.stringify(input) }),
  getOrder: (orderId: string) => request<{ orderId: string; status: string; fundStatus: string }>(`/sapi/v1/meme/orders/${orderId}`),
  getWsTicket: () => request<{ ticket: string; expiresAt: number }>('/sapi/v1/meme/ws-ticket', { method: 'POST' }),
};

export const wsBaseUrl = (import.meta.env.VITE_MEME_WS_URL as string | undefined)
  ?? 'ws://127.0.0.1:3000/sapi/v1/meme/stream';
