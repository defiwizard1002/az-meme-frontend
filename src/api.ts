import type { AccountSummary, AccountTransaction, Asset, CandleSnapshot, Interval, Order, Quote, Token, Trade, TradePlan } from './types';

interface Envelope<T> {
  rc: number;
  mc: string;
  ma: string[];
  result: T;
}

const apiBaseUrl = (import.meta.env.VITE_MEME_API_BASE_URL as string | undefined) ?? '';
const azApiBaseUrl = (import.meta.env.VITE_AZ_API_BASE_URL as string | undefined) ?? '';
let sessionToken: string | null = null;

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
  }
}

export function setSessionToken(token: string | null): void {
  sessionToken = token;
}

async function readEnvelope<T>(response: Response, prefix: 'MEME' | 'AZ'): Promise<T> {
  const text = await response.text();
  let payload: Partial<Envelope<T>> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
  } catch (cause) {
    if (response.ok) throw new ApiError(`${prefix}_INVALID_RESPONSE`, `HTTP ${response.status}: 服务响应无效，请稍后重试`, response.status);
    // Non-JSON proxy failures must retain their original HTTP status below.
    if (!(cause instanceof SyntaxError)) throw cause;
  }
  if (!response.ok || payload && typeof payload.rc === 'number' && payload.rc !== 0) {
    throw new ApiError(typeof payload?.mc === 'string' ? payload.mc : `${prefix}_REQUEST_FAILED`,
      Array.isArray(payload?.ma) && typeof payload.ma[0] === 'string' ? payload.ma[0] : `HTTP ${response.status}: 请求失败`, response.status);
  }
  if (!payload || payload.rc !== 0 || !Object.hasOwn(payload, 'result')) {
    throw new ApiError(`${prefix}_INVALID_RESPONSE`, `HTTP ${response.status}: 服务响应格式无效`, response.status);
  }
  return payload.result as T;
}
async function send<T>(base: string, prefix: 'MEME' | 'AZ', path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set('content-type', 'application/json');
  if (sessionToken) headers.set('authorization', `Bearer ${sessionToken}`);
  return readEnvelope<T>(await fetch(`${base}${path}`, { ...init, headers, credentials: 'same-origin' }), prefix);
}
function request<T>(path: string, init?: RequestInit): Promise<T> { return send(apiBaseUrl, 'MEME', path, init); }
function requestAz<T>(path: string, init?: RequestInit): Promise<T> { return send(azApiBaseUrl, 'AZ', path, init); }

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
  getConfig: () => request<{
    chainId: number;
    chainName: string;
    explorerBaseUrl: string;
    defaultSlippageBps: number;
    marketRefreshMs: { hot: number; new: number };
    accountMode: 'AZ_ACCOUNT' | 'MAIN_ACCOUNT_POC';
    mainAccountAddress: string | null;
    settlementAssets: Asset[];
  }>('/sapi/v1/meme/config'),
  getMarkets: (tab: 'hot' | 'new' = 'hot') => request<{ items: Token[]; stale: boolean }>(`/sapi/v1/meme/markets?tab=${tab}&limit=50`),
  searchMarkets: (query: string) => request<{ items: Token[]; stale: boolean }>(`/sapi/v1/meme/markets?query=${encodeURIComponent(query)}&limit=50`),
  getToken: (tokenAddress: string) => request<Token>(`/sapi/v1/meme/tokens/${tokenAddress}`),
  getCandles: (tokenAddress: string, interval: Interval, options?: { from?: number; to?: number; limit?: number; signal?: AbortSignal }) => {
    const query = new URLSearchParams({ interval, limit: String(options?.limit ?? 300) });
    if (options?.from !== undefined) query.set('from', String(options.from));
    if (options?.to !== undefined) query.set('to', String(options.to));
    return request<CandleSnapshot>(`/sapi/v1/meme/tokens/${tokenAddress}/candles?${query.toString()}`, { signal: options?.signal });
  },
  getTrades: (tokenAddress: string, cursor?: string, signal?: AbortSignal) => {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor) query.set('cursor', cursor);
    return request<{ items: Trade[]; nextCursor: string | null }>(`/sapi/v1/meme/tokens/${tokenAddress}/trades?${query.toString()}`, { signal });
  },
  getAccount: () => request<AccountSummary>('/sapi/v1/meme/account/summary'),
  getAccountTransactions: () => request<{ items: AccountTransaction[] }>('/sapi/v1/meme/account/transactions?limit=50'),
  getAccountTransaction: (executionId: string) => request<AccountTransaction>(`/sapi/v1/meme/account/transactions/${executionId}`),
  executeMainAccountTrade: (input: {
    clientExecutionId: string;
    side: 'BUY' | 'SELL';
    tokenAddress: string;
    settlementAsset: 'USDG' | 'ETH' | 'USDC';
    amountIn: string;
    slippageBps: number;
  }) => request<AccountTransaction>('/sapi/v1/meme/account/transactions', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  createQuote: (input: { side: 'BUY' | 'SELL'; tokenAddress: string; settlementAsset: Asset; amountIn: string; slippageBps: number }, signal?: AbortSignal) =>
    request<Quote>('/sapi/v1/meme/quotes', { method: 'POST', body: JSON.stringify(input), signal }),
  createOrder: (input: { clientOrderId: string; quoteId: string; maxAmountIn: string; minAmountOut: string }) =>
    request<Order>('/sapi/v1/meme/orders', { method: 'POST', body: JSON.stringify(input) }),
  getOrders: () => request<{ items: Order[]; nextCursor: string | null }>('/sapi/v1/meme/orders'),
  getOrder: (orderId: string) => request<Order>(`/sapi/v1/meme/orders/${orderId}`),
  getWsTicket: () => request<{ ticket: string; expiresAt: number }>('/sapi/v1/meme/ws-ticket', { method: 'POST' }),
  planTrade: (input: { side: 'BUY' | 'SELL'; tokenAddress: string; settlementAsset?: 'USDG' | 'ETH' | 'USDC'; amountIn: string; slippageBps: number; simulate: boolean }) =>
    request<TradePlan>('/sapi/v1/meme/transactions/plan', { method: 'POST', body: JSON.stringify(input) }),
};

export const wsBaseUrl = (import.meta.env.VITE_MEME_WS_URL as string | undefined)
  || `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/sapi/v1/meme/stream`;
