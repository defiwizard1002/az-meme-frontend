import type {
  AccountSummary,
  AccountTransaction,
  Asset,
  Candle,
  CandleSnapshot,
  Interval,
  Order,
  QuoteDisplay,
  Token,
  Trade,
  TradePlan,
} from "./types";

interface Envelope<T> {
  rc: number;
  mc: string;
  ma: string[];
  result: T;
}

const apiBaseUrl = (import.meta.env.VITE_MEME_API_BASE_URL as string | undefined) ?? "";
const azApiBaseUrl = (import.meta.env.VITE_AZ_API_BASE_URL as string | undefined) ?? "";
let sessionToken: string | null = null;
export interface SponsoredTransaction {
  from: string;
  to: string;
  data: `0x${string}`;
  value: string;
}
export interface WalletProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
}
let serverSignedTransactions = false;
export function configureServerSignedTransactions(enabled: boolean): void {
  serverSignedTransactions = enabled;
}

const requestTimeoutMs = 15_000;

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function setSessionToken(token: string | null): void {
  sessionToken = token;
}

export function clearSessionToken(): void {
  sessionToken = null;
}

async function readEnvelope<T>(response: Response, prefix: "MEME" | "AZ"): Promise<T> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new ApiError(
      `${prefix}_${response.ok ? "INVALID_RESPONSE" : "REQUEST_FAILED"}`,
      `HTTP ${response.status}: 服务响应读取中断，请检查连接后重试`,
      response.status,
    );
  }
  if (
    prefix === "MEME" &&
    response.status === 403 &&
    text.trim() === "Signing is available only on the private account entry"
  ) {
    throw new ApiError(
      "MEME_PRIVATE_ACCOUNT_ENTRY_REQUIRED",
      "当前为公开行情入口，报价和交易请使用私有主账户入口（Tailscale / 私网）",
      response.status,
    );
  }
  let payload: Partial<Envelope<T>> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed;
  } catch (cause) {
    if (response.ok)
      throw new ApiError(
        `${prefix}_INVALID_RESPONSE`,
        `HTTP ${response.status}: 服务响应无效，请稍后重试`,
        response.status,
      );
    // Non-JSON proxy failures must retain their original HTTP status below.
    if (!(cause instanceof SyntaxError)) throw cause;
  }
  if (!response.ok || (payload && typeof payload.rc === "number" && payload.rc !== 0)) {
    throw new ApiError(
      typeof payload?.mc === "string" ? payload.mc : `${prefix}_REQUEST_FAILED`,
      Array.isArray(payload?.ma) && typeof payload.ma[0] === "string"
        ? payload.ma[0]
        : `HTTP ${response.status}: 请求失败`,
      response.status,
      payload?.result ?? undefined,
    );
  }
  if (!payload || payload.rc !== 0 || !Object.hasOwn(payload, "result")) {
    throw new ApiError(
      `${prefix}_INVALID_RESPONSE`,
      `HTTP ${response.status}: 服务响应格式无效`,
      response.status,
    );
  }
  return payload.result as T;
}
async function send<T>(
  base: string,
  prefix: "MEME" | "AZ",
  path: string,
  init?: RequestInit,
  publicMarket = false,
): Promise<T> {
  init?.signal?.throwIfAborted();
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  const controller = new AbortController();
  const cancel = () => controller.abort(init?.signal?.reason);
  let response: Response | undefined;
  const timer = setTimeout(() => {
    const mutation = !["GET", "HEAD"].includes((init?.method ?? "GET").toUpperCase());
    controller.abort(
      new ApiError(
        `${prefix}_${response && !response.ok ? "REQUEST_FAILED" : "REQUEST_TIMEOUT"}`,
        `${response ? `HTTP ${response.status}: ` : ""}请求超时${
          mutation ? "，结果未确认，交易可能已广播；请先核对交易记录，勿重复提交" : "，请稍后重试"
        }`,
        response?.status ?? 0,
      ),
    );
  }, requestTimeoutMs);
  let rejectAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  init?.signal?.addEventListener("abort", cancel, { once: true });
  try {
    // Race the whole read: aborting fetch alone cannot bound an unresponsive body reader.
    return await Promise.race([
      aborted,
      (async () => {
        if (publicMarket) headers.delete("authorization");
        else if (sessionToken && !headers.has("authorization"))
          headers.set("authorization", `Bearer ${sessionToken}`);
        controller.signal.throwIfAborted();
        response = await fetch(`${base}${path}`, {
          ...init,
          headers,
          signal: controller.signal,
          credentials: publicMarket ? "omit" : "same-origin",
        });
        controller.signal.throwIfAborted();
        return readEnvelope<T>(response, prefix);
      })(),
    ]);
  } catch (cause) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (cause instanceof ApiError) throw cause;
    throw new ApiError(
      `${prefix}_REQUEST_FAILED`,
      "网络请求失败，请检查连接后重试",
      response?.status ?? 0,
    );
  } finally {
    clearTimeout(timer);
    init?.signal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", rejectAbort);
  }
}
function request<T>(path: string, init?: RequestInit): Promise<T> {
  return send(apiBaseUrl, "MEME", path, init);
}
function requestPublicMarket<T>(path: string, init?: RequestInit): Promise<T> {
  return send(apiBaseUrl, "MEME", path, init, true);
}
function requestAz<T>(path: string, init?: RequestInit): Promise<T> {
  return send(azApiBaseUrl, "AZ", path, init);
}

export async function authenticateWallet(address: string, provider: WalletProvider): Promise<void> {
  const nonce = await request<{ message: string }>("/sapi/v1/meme/auth/wallet/nonce", {
    method: "POST",
    body: JSON.stringify({ address }),
  });
  const signature = await provider.request({
    method: "personal_sign",
    params: [nonce.message, address],
  });
  if (typeof signature !== "string")
    throw new ApiError("MEME_WALLET_SIGNATURE_INVALID", "钱包签名无效", 400);
  const verified = await request<{ token: string }>("/sapi/v1/meme/auth/wallet/verify", {
    method: "POST",
    body: JSON.stringify({ address, signature }),
  });
  setSessionToken(verified.token);
}

export const azAuth = {
  loginMock: async (signal?: AbortSignal) => {
    const sourceAddr = `0x${"7".repeat(40)}`;
    const nonce = await requestAz<{ nonce: string; message: string }>(
      "/az-auth/uaapi/user/web3/get-nonce",
      {
        method: "POST",
        signal,
        body: JSON.stringify({ sourceAddr, type: "LOGIN", chainType: "ETHEREUM" }),
      },
    );
    if (!nonce.message) throw new Error("AZ nonce response is missing the sign message");
    const login = await requestAz<{ accessToken: string; expiresAt: number }>(
      "/az-auth/uaapi/user/web3/login",
      {
        method: "POST",
        signal,
        body: JSON.stringify({
          signature: "0xmock-signature",
          sourceAddr,
          chainType: "ETHEREUM",
          chainId: 1,
          loginType: "WALLET",
        }),
      },
    );
    const user = await requestAz<{ userId: string; accountId: string; loginStatus: string }>(
      "/az-auth/uaapi/user/user/getDesensitizedUserInfo",
      { signal, headers: { authorization: `Bearer ${login.accessToken}` } },
    );
    signal?.throwIfAborted();
    setSessionToken(login.accessToken);
    return { ...user, expiresAt: login.expiresAt };
  },
};

export const azFundApi = {
  transfer: (input: {
    bizId: string;
    from: "SPOT" | "MEME";
    to: "SPOT" | "MEME";
    currency: Asset;
    amount: string;
  }) =>
    requestAz<number>("/sapi/v4/fund/balance/transfer", {
      method: "POST",
      body: JSON.stringify(input),
    }),
};

export const memeApi = {
  getConfig: () =>
    requestPublicMarket<{
      serverSignedTransactions?: boolean;
      chainId: number;
      chainName: string;
      explorerBaseUrl: string;
      defaultSlippageBps: number;
      marketRefreshMs: { hot: number; new: number };
      accountMode: "AZ_ACCOUNT" | "MAIN_ACCOUNT_POC";
      mainAccountAddress: string | null;
      settlementAssets: Asset[];
    }>("/sapi/v1/meme/config"),
  getMarkets: (tab: "hot" | "new" = "hot") =>
    requestPublicMarket<{ items: Token[]; stale: boolean }>(
      `/sapi/v1/meme/markets?tab=${tab}&limit=50`,
    ),
  searchMarkets: (query: string) =>
    requestPublicMarket<{ items: Token[]; stale: boolean }>(
      `/sapi/v1/meme/markets?query=${encodeURIComponent(query)}&limit=50`,
    ),
  getToken: (tokenAddress: string, retry = false) =>
    requestPublicMarket<Token>(`/sapi/v1/meme/tokens/${tokenAddress}${retry ? "?retry=1" : ""}`),
  getCandles: (
    tokenAddress: string,
    interval: Interval,
    options?: {
      from?: number;
      to?: number;
      limit?: number;
      series?: Candle["series"];
      signal?: AbortSignal;
    },
  ) => {
    const query = new URLSearchParams({ interval, limit: String(options?.limit ?? 300) });
    if (options?.from !== undefined) query.set("from", String(options.from));
    if (options?.to !== undefined) query.set("to", String(options.to));
    if (options?.series !== undefined) query.set("series", options.series);
    return requestPublicMarket<CandleSnapshot>(
      `/sapi/v1/meme/tokens/${tokenAddress}/candles?${query.toString()}`,
      { signal: options?.signal },
    );
  },
  getTrades: (tokenAddress: string, cursor?: string, signal?: AbortSignal) => {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    return requestPublicMarket<{ items: Trade[]; nextCursor: string | null }>(
      `/sapi/v1/meme/tokens/${tokenAddress}/trades?${query.toString()}`,
      { signal },
    );
  },
  getAccount: (signal?: AbortSignal) =>
    request<AccountSummary>("/sapi/v1/meme/account/summary", { signal }),
  getAccountTransactions: (signal?: AbortSignal) =>
    request<{ items: AccountTransaction[] }>("/sapi/v1/meme/account/transactions?limit=50", {
      signal,
    }),
  getAccountTransaction: (executionId: string) =>
    request<AccountTransaction>(`/sapi/v1/meme/account/transactions/${executionId}`),
  executeMainAccountTrade: (input: {
    clientExecutionId: string;
    side: "BUY" | "SELL";
    tokenAddress: string;
    settlementAsset: "USDG" | "ETH" | "WETH" | "USDC";
    quoteId: string;
    routeFingerprint?: string;
    minAmountOut?: string;
    amountIn: string;
    slippageBps: number;
  }) => executeAccountTrade(input),
  createQuote: (
    input: {
      side: "BUY" | "SELL";
      tokenAddress: string;
      settlementAsset: Asset;
      amountIn: string;
      slippageBps: number;
      purpose?: "ESTIMATE" | "PREPARE_EXECUTION";
      minAmountOut?: string;
    },
    signal?: AbortSignal,
  ) =>
    request<QuoteDisplay | ApprovalRequired>("/sapi/v1/meme/quotes", {
      method: "POST",
      body: JSON.stringify(input),
      signal,
    }).then((value): QuoteDisplay => {
      if ("status" in value && value.status === "APPROVAL_REQUIRED")
        throw new ApiError(
          "MEME_APPROVAL_REQUIRED",
          "需要授权；完成授权后重新准备并确认交易",
          200,
          value,
        );
      return value as QuoteDisplay;
    }),
  approveTrade: (prerequisiteId: string) =>
    request<{ status: "REQUOTE_REQUIRED"; transactions: string[] }>(
      "/sapi/v1/meme/transactions/approval",
      { method: "POST", body: JSON.stringify({ prerequisiteId }) },
    ),
  createOrder: (input: {
    clientOrderId: string;
    quoteId: string;
    maxAmountIn: string;
    minAmountOut: string;
  }) => request<Order>("/sapi/v1/meme/orders", { method: "POST", body: JSON.stringify(input) }),
  getOrders: (signal?: AbortSignal) =>
    request<{ items: Order[]; nextCursor: string | null }>("/sapi/v1/meme/orders", { signal }),
  getOrder: (orderId: string) => request<Order>(`/sapi/v1/meme/orders/${orderId}`),
  getWsTicket: (signal?: AbortSignal, publicMarket = false) =>
    (publicMarket ? requestPublicMarket : request)<{ ticket: string; expiresAt: number }>(
      "/sapi/v1/meme/ws-ticket",
      { method: "POST", signal },
    ),
  planAssetConversion: (input: {
    assetIn: "USDG" | "ETH" | "WETH" | "USDC";
    assetOut: "USDG" | "ETH" | "WETH" | "USDC";
    amountIn: string;
    slippageBps: number;
    simulate: boolean;
  }) =>
    request<TradePlan>("/sapi/v1/meme/transactions/conversion/plan", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  planTrade: (input: {
    side: "BUY" | "SELL";
    tokenAddress: string;
    quoteId?: string;
    settlementAsset?: "USDG" | "ETH" | "WETH" | "USDC";
    amountIn: string;
    slippageBps: number;
    simulate: boolean;
  }) =>
    request<TradePlan>("/sapi/v1/meme/transactions/plan", {
      method: "POST",
      body: JSON.stringify(input),
    }),
};

export interface ApprovalRequired {
  status: "APPROVAL_REQUIRED";
  prerequisiteId: string;
  account: string;
  prerequisites: Array<{ token: string; spender: string; amount: string }>;
  expiresAt: number;
}

export function approvalDetails(cause: unknown): ApprovalRequired | null {
  if (!(cause instanceof ApiError) || !cause.details || typeof cause.details !== "object")
    return null;
  const value = cause.details as ApprovalRequired;
  return value.status === "APPROVAL_REQUIRED" &&
    typeof value.prerequisiteId === "string" &&
    Array.isArray(value.prerequisites) &&
    value.prerequisites.length > 0
    ? value
    : null;
}

export const wsBaseUrl =
  (import.meta.env.VITE_MEME_WS_URL as string | undefined) ||
  `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/sapi/v1/meme/stream`;

type AccountTradeInput = Parameters<typeof memeApi.executeMainAccountTrade>[0];
async function executeAccountTrade(input: AccountTradeInput): Promise<AccountTransaction> {
  if (!serverSignedTransactions)
    return request<AccountTransaction>("/sapi/v1/meme/account/transactions", {
      method: "POST",
      body: JSON.stringify(input),
    });
  const pendingKey = `az:server-signed-pending:${input.tokenAddress.toLowerCase()}`;
  const pendingId = localStorage.getItem(pendingKey);
  if (pendingId) {
    const existing = await request<AccountTransaction>(
      `/sapi/v1/meme/account/transactions/${pendingId}`,
    );
    if (existing.status === "PENDING") return existing;
    localStorage.removeItem(pendingKey);
  }
  const prepared = await request<{
    record: AccountTransaction;
    authorizationRequest: unknown;
  }>("/sapi/v1/meme/privy/transactions", { method: "POST", body: JSON.stringify(input) });
  if (!prepared.authorizationRequest) return prepared.record;
  localStorage.setItem(pendingKey, prepared.record.executionId);
  try {
    const submitted = await request<AccountTransaction>(
      `/sapi/v1/meme/privy/transactions/${prepared.record.executionId}/submit`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    );
    if (submitted.status !== "PENDING") localStorage.removeItem(pendingKey);
    return submitted;
  } catch (cause) {
    if (
      cause instanceof ApiError &&
      ["MEME_ROUTE_STALE", "MEME_PRIVY_SUBMISSION_REJECTED"].includes(cause.code)
    ) {
      localStorage.removeItem(pendingKey);
      throw cause;
    }
    throw new Error(
      `交易 ${prepared.record.executionId} 提交结果待确认，请在交易记录查看：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}
