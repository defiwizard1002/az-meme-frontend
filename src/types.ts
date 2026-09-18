export type Interval = '1s' | '1m' | '15m' | '1h' | '4h';
export type Asset = 'ETH' | 'USDC' | 'USDT';

export interface Token {
  chainId: number;
  tokenAddress: string;
  symbol: string;
  name: string;
  stage: 'CURVE' | 'GRADUATED';
  priceUsd: string;
  change5m: string;
  holders: number;
  ageSeconds: number;
  pool: { poolKey: string; poolType: string; liquidityUsd: string };
  tradeStatus: 'TRADABLE' | 'UNSUPPORTED_POOL_TYPE';
  riskFlags: string[];
}
export interface Candle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  baseVolume: string | null;
  quoteVolume: string | null;
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

export interface AccountSummary {
  quoteBalances: Array<{ asset: Asset; available: string; frozen: string }>;
  positions: Array<{ tokenAddress: string; symbol: string; available: string; costUsd: string; valueUsd: string }>;
}

export interface Quote {
  quoteId: string;
  expectedAmountOut: string;
  minAmountOut: string;
  settlementAsset: Asset;
  fees: Array<{ type: string; asset: Asset; amount: string; estimated: boolean }>;
  expiresAt: number;
}
