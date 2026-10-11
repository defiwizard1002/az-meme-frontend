export type Interval = '1s' | '1m' | '15m' | '1h' | '4h';
export type Asset = 'WETH' | 'ETH' | 'USDC' | 'USDT' | 'USDG';

export interface Token {
  chainId: number;
  tokenAddress: string;
  symbol: string;
  name: string;
  launchpad: string;
  stage: 'CURVE' | 'GRADUATED';
  quoteAssetKey: 'NATIVE' | 'USDC' | 'USDT' | 'USDG' | 'OTHER';
  priceQuote: string;
  priceUsd: string;
  marketCapUsd: string;
  volume1hUsd?: string;
  volume24hUsd: string;
  change5m: string;
  change24h: string;
  holders: number;
  ageSeconds: number;
  pool: { poolKey: string; poolType: string; liquidityUsd: string; quoteTokenSymbol?: string };
  tradeStatus: 'TRADABLE' | 'UNSUPPORTED_POOL_TYPE';
  riskFlags: string[];
  security: {
    isHoneypot: boolean | null;
    buyTaxPct: string | null;
    sellTaxPct: string | null;
    liquidityLocked: boolean | null;
    liquidityLockedPct: string | null;
    liquidityBurnedPct: string | null;
  };
}
export interface Candle {
  retracted?: true;
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  baseVolume: string | null;
  quoteVolume: string | null;
  rawVolume?: string;
  rawVolumeUnit?: 'BASE' | 'QUOTE' | 'USD' | 'UNKNOWN';
  revision: string;
}

export interface CandleSnapshot {
  chainId: number;
  tokenAddress: string;
  marketKey: string;
  interval: Interval;
  syncStatus: 'BACKFILLING' | 'CATCHING_UP' | 'READY' | 'STALE' | 'FAILED';
  availability: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE_BEFORE_START';
  coverage: { from: number | null; to: number | null };
  gaps: Array<{ from: number; to: number; reason: 'BEFORE_SCAN_START' | 'EVENT_EXPIRED' }>;
  revision: string;
  asOfBlock: number | null;
  source: 'CHAIN';
  items: Candle[];
  retractions?: Array<{t:number;revision:string}>;
}

export interface Trade {
  /** Historical stream updates merge without indicating new live activity. */
  history?: boolean;
  correction?: boolean;
  /** Available on chain Trade projections; older providers may omit these facts. */
  protocol?: string;
  poolKey?: string;
  notionalUsd?: string;
  counterAmount?: string;
  counterAddress?: string;
  tradeId: string;
  t: number;
  side: 'BUY' | 'SELL';
  priceUsd: string;
  baseAmount: string;
  quoteAmount: string;
  quoteAsset: string;
  trader: string;
  txHash: string;
}

export interface AccountSummary {
  quoteBalances: Array<{ asset: Asset; available: string; frozen: string }>;
  positions: Array<{ tokenAddress: string; symbol: string; available: string; costUsd: string; valueUsd: string }>;
}

export interface Quote {
  quoteId: string;
  tokenAddress: string;
  side: 'BUY' | 'SELL';
  amountIn: string;
  expectedAmountOut: string;
  minAmountOut: string;
  settlementAsset: Asset;
  executionMode?: 'DIRECT_ETH' | 'PLATFORM_ETH_INVENTORY' | 'MAIN_ACCOUNT';
  residualAssets?: Array<{address:string;symbol:string;decimals:number;expectedAmountAtomic:string}>;
  routeAssets?: Array<{address:string;symbol:string;decimals:number}>;
  routePools?: Array<{poolKey:string;poolType:string;liquidityUsd:string;fee?:number;factoryAddress?:string}>;
  routeFingerprint?: string;
  fees: Array<{ type: string; asset: Asset; amount: string; estimated: boolean }>;
  expiresAt: number;
}

export interface Order {
  orderId: string;
  status: 'CREATED' | 'RESERVED' | 'SIGNED' | 'SUBMITTING' | 'SUBMITTED' | 'CONFIRMED' | 'SETTLED' | 'FAILED_FINAL' | 'SUBMISSION_UNKNOWN' | 'MANUAL_REVIEW';
  fundStatus: 'RESERVED' | 'SETTLED' | 'RELEASED';
  txHash?: string;
}

export interface AccountTransaction {
  executionId: string;
  tokenAddress: string;
  tokenSymbol: string;
  side: 'BUY' | 'SELL';
  settlementAsset: 'USDG' | 'ETH' | 'WETH' | 'USDC';
  amountIn: string;
  amountOut: string | null;
  status: 'PENDING' | 'CONFIRMED' | 'FAILED' | 'PARTIAL' | 'SUBMISSION_UNKNOWN';
  confirmedSteps?: Array<{stepIndex:number;kind:string;txHash:string}>;
  txHashes: string[];
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TradePlan {
  route: 'MULTI_HOP' | 'DIRECT' | 'USDG_BRIDGE' | 'SETTLEMENT_BRIDGE';
  selectedPool: { poolType: string; liquidityUsd: string; quoteTokenSymbol?: string };
  routeAssets?: Quote['routeAssets'];
  routePools?: Quote['routePools'];
  routeFingerprint?: string;
  simulation?: { status: 'SUCCESS'; bufferedGas: string; estimatedFeeWei: string };
}
