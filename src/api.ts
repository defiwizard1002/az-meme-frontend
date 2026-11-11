import { forgetExecution, pendingExecutionId, rememberExecution } from "./transaction-tracker";
import { requireQuoteTerms, type QuoteRequest, type ValidQuote } from "./quote-flow";
import type {
  AccountSummary,
  AccountTransaction,
  Asset,
  Candle,
  CandleSnapshot,
  Interval,
  QuoteDisplay,
  Token,
  Trade,
} from "./types";

interface Envelope<T> {
  rc: number;
  mc: string;
  ma: string[];
  result: T;
}

export function resolveApiBaseUrl(configuredUrl: string | undefined): string {
  return configuredUrl ?? "";
}

export function resolveWsBaseUrl(
  configuredUrl: string | undefined,
  location: Pick<Location, "protocol" | "host"> = window.location,
): string {
  return (
    configuredUrl ||
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/sapi/v1/meme/stream`
  );
}

const apiBaseUrl = resolveApiBaseUrl(import.meta.env.VITE_MEME_API_BASE_URL as string | undefined);
const sessionStorageKey = "az:meme:wallet-session";
let sessionToken: string | null =
  typeof window === "undefined" || !window.localStorage
    ? null
    : window.localStorage.getItem(sessionStorageKey);
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
  if (typeof window !== "undefined" && window.localStorage) {
    if (token) window.localStorage.setItem(sessionStorageKey, token);
    else window.localStorage.removeItem(sessionStorageKey);
  }
}

export function clearSessionToken(): void {
  setSessionToken(null);
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
export function request<T>(path: string, init?: RequestInit): Promise<T> {
  return send(apiBaseUrl, "MEME", path, init);
}
export function requestPublicMarket<T>(path: string, init?: RequestInit): Promise<T> {
  return send(apiBaseUrl, "MEME", path, init, true);
}
export interface WalletSession {
  userId: string;
  accountId: string;
  loginAddress: string | null;
}

export async function restoreWalletSession(address: string): Promise<WalletSession | null> {
  const token = sessionToken;
  if (!token) return null;
  try {
    const session = await request<WalletSession>("/sapi/v1/meme/auth/session");
    if (token !== sessionToken) return null;
    if (session.loginAddress?.toLowerCase() !== address.toLowerCase()) {
      clearSessionToken();
      return null;
    }
    return session;
  } catch (cause) {
    if (token !== sessionToken) return null;
    if (cause instanceof ApiError && cause.status === 401) {
      clearSessionToken();
      return null;
    }
    throw cause;
  }
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
  executeMainAccountTrade: (input: AccountTradeInput) => executeAccountTrade(input),
  createQuote: (input: QuoteRequest, signal?: AbortSignal) => {
    const { feeConfigVersion: _boundFeeVersion, ...body } = input;
    return request<QuoteDisplay | ApprovalRequired>("/sapi/v1/meme/quotes", {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }).then((value): ValidQuote => {
      if ("status" in value && value.status === "APPROVAL_REQUIRED")
        throw new ApiError("MEME_APPROVAL_REQUIRED", "需要授权，完成后将重新获取报价", 200, value);
      return requireQuoteTerms(value as QuoteDisplay, input);
    });
  },
  approveTrade: (prerequisiteId: string) =>
    request<{ status: "REQUOTE_REQUIRED"; transactions: string[] }>(
      "/sapi/v1/meme/transactions/approval",
      { method: "POST", body: JSON.stringify({ prerequisiteId }) },
    ),
  getWsTicket: (signal?: AbortSignal, publicMarket = false) =>
    (publicMarket ? requestPublicMarket : request)<{ ticket: string; expiresAt: number }>(
      "/sapi/v1/meme/ws-ticket",
      { method: "POST", signal },
    ),
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

export const wsBaseUrl = resolveWsBaseUrl(
  import.meta.env.VITE_MEME_WS_URL as string | undefined,
  window.location,
);

export interface AccountTradeInput {
  walletAddress: string;
  clientExecutionId: string;
  side: "BUY" | "SELL";
  tokenAddress: string;
  settlementAsset: Asset;
  quoteId: string;
  routeFingerprint?: string;
  minAmountOut: string;
  amountIn: string;
  slippageBps: number;
  feeConfigVersion: string;
}

async function executeAccountTrade(input: AccountTradeInput): Promise<AccountTransaction> {
  const executionSession = sessionToken;
  const pendingId = pendingExecutionId(input.walletAddress);
  if (pendingId) {
    const existing = await memeApi.getAccountTransaction(pendingId);
    if (sessionToken !== executionSession) throw new Error("钱包已切换，请返回原钱包查看交易状态");
    if (existing.status !== "CONFIRMED" && existing.status !== "FAILED") return existing;
    forgetExecution(input.walletAddress, pendingId);
  }
  const { walletAddress, feeConfigVersion: _boundFeeVersion, ...body } = input;
  // Save before POST: either prepare or submit can time out after reaching the server.
  rememberExecution(walletAddress, input.clientExecutionId);
  let recordCreated = false;
  try {
    if (!serverSignedTransactions) {
      const result = await request<AccountTransaction>("/sapi/v1/meme/account/transactions", {
        method: "POST",
        body: JSON.stringify(body),
      });
      rememberExecution(walletAddress, result.executionId);
      if (result.status === "CONFIRMED" || result.status === "FAILED")
        forgetExecution(walletAddress, result.executionId);
      return result;
    }
    const prepared = await request<{ record: AccountTransaction; authorizationRequest: unknown }>(
      "/sapi/v1/meme/privy/transactions",
      { method: "POST", body: JSON.stringify(body) },
    );
    recordCreated = true;
    rememberExecution(walletAddress, prepared.record.executionId);
    if (sessionToken !== executionSession) throw new Error("钱包已切换，请返回原钱包查看交易状态");
    if (!prepared.authorizationRequest) {
      if (prepared.record.status === "CONFIRMED" || prepared.record.status === "FAILED")
        forgetExecution(walletAddress, prepared.record.executionId);
      return prepared.record;
    }
    const submitted = await request<AccountTransaction>(
      `/sapi/v1/meme/privy/transactions/${prepared.record.executionId}/submit`,
      { method: "POST", body: JSON.stringify({}) },
    );
    if (submitted.status === "CONFIRMED" || submitted.status === "FAILED")
      forgetExecution(walletAddress, submitted.executionId);
    return submitted;
  } catch (cause) {
    if (
      !recordCreated &&
      cause instanceof ApiError &&
      ((typeof cause.details === "object" &&
        cause.details !== null &&
        "executionStage" in cause.details &&
        cause.details.executionStage === "NOT_CREATED") ||
        [
          "MEME_ROUTE_STALE",
          "MEME_FEE_CONFIG_CHANGED",
          "MEME_QUOTE_REQUEST_MISMATCH",
          "MEME_UNAUTHORIZED",
          "MEME_ATOMIC_BALANCE_INSUFFICIENT",
          "MEME_ATOMIC_SIMULATION_FAILED",
          "MEME_TREASURY_APPROVAL_REQUIRED",
          "MEME_PRIVY_WALLET_REQUIRED",
          "MEME_PRIVY_SUBMISSION_REJECTED",
          "MEME_MAIN_ACCOUNT_BUSY",
          "MEME_MAIN_ACCOUNT_EXECUTION_DISABLED",
          "MEME_USER_SEND_REQUIRED",
        ].includes(cause.code))
    ) {
      // Only a known pre-create rejection retires this attempt. Once a record exists,
      // even an authentication error must leave its ID available for receipt recovery.
      forgetExecution(walletAddress, input.clientExecutionId);
    }
    throw cause;
  }
}
