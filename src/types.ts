export type Interval = '1s' | '1m' | '15m' | '1h' | '4h';
export type Asset = 'ETH' | 'USDC' | 'USDT';

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
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  baseVolume: string | null;
  quoteVolume: string | null;
  rawVolume?: string;
  rawVolumeUnit?: 'BASE' | 'QUOTE' | 'USD' | 'UNKNOWN';
  revision: number;
}

export interface CandleSnapshot {
  chainId: number;
  tokenAddress: string;
  marketKey: string;
  interval: Interval;
  status: 'BACKFILLING' | 'CATCHING_UP' | 'READY' | 'STALE';
  source: string;
  items: Candle[];
}

export interface Trade {
  tradeId: string;
  t: number;
  side: 'BUY' | 'SELL';
  priceUsd: string;
  baseAmount: string;
  quoteAmount: string;
  quoteAsset: 'ETH' | 'USDC' | 'USDT' | 'USDG';
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
  fees: Array<{ type: string; asset: Asset; amount: string; estimated: boolean }>;
  expiresAt: number;
}

export interface Order {
  orderId: string;
  status: 'CREATED' | 'RESERVED' | 'SIGNED' | 'SUBMITTING' | 'SUBMITTED' | 'CONFIRMED' | 'SETTLED' | 'FAILED_FINAL' | 'SUBMISSION_UNKNOWN' | 'MANUAL_REVIEW';
  fundStatus: 'RESERVED' | 'SETTLED' | 'RELEASED';
  txHash?: string;
}
