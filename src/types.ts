export type Interval = "1s" | "30s" | "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
export type Asset = "WETH" | "ETH" | "USDC" | "USDT" | "USDG";

export interface Token {
  priceObservedAt?: number;
  priceSource?: "CHAIN" | "GMGN";
  liveRevision?: string;
  asOfBlock?: number;
  chainId: number;
  tokenAddress: string;
  symbol: string | null;
  name: string | null;
  logo?: string | null;
  description?: string | null;
  website?: string | null;
  twitterUsername?: string | null;
  telegram?: string | null;
  discord?: string | null;
  createdAt?: number | null;
  launchpad?: string | null;
  stage?: "CURVE" | "GRADUATED" | "AMM" | "UNKNOWN";
  lifecycle?: {
    state:
      | "CURVE"
      | "NEAR_GRADUATION"
      | "GRADUATED"
      | "SWEPT"
      | "RESCUED"
      | "NOT_APPLICABLE"
      | "UNKNOWN";
    progressPct: string | null;
    source: "LOCAL";
    asOfBlock?: number | null;
    reason?: string | null;
    updatedAt?: number;
    observedAt?: number;
  };
  quoteAssetKey?: "NATIVE" | "USDC" | "USDT" | "USDG" | "OTHER";
  priceQuote?: string | null;
  priceUsd: string | null;
  marketCapUsd: string | null;
  liquidityUsd?: string | null;
  circulatingSupply?: string | null;
  totalSupply?: string | null;
  volume1hUsd?: string | null;
  volume24hUsd: string | null;
  change5m?: string | null;
  change1h?: string | null;
  change24h: string | null;
  holders: number | null;
  ageSeconds: number | null;
  smartMoneyCount?: number | null;
  kolCount?: number | null;
  pool?: { poolKey: string; poolType: string; liquidityUsd: string; quoteTokenSymbol?: string };
  tradeStatus?: "TRADABLE" | "UNSUPPORTED_POOL_TYPE";
  riskFlags?: string[];
  source?: "GMGN";
  observedAt?: number | null;
  updatedAt?: number | null;
  stale?: boolean;
  coverage?: { missing: string[]; complete: boolean; fieldObservedAt?: Record<string, number> };
  safety?: {
    source: "GMGN";
    observedAt: number;
    updatedAt: number;
    stale: boolean;
    complete: boolean;
    missing: string[];
    error: string | null;
    data: Token["security"];
  };
  security: {
    isHoneypot: boolean | null;
    isShowAlert?: boolean | null;
    isWashTrading?: boolean | null;
    buyTaxPct: string | null;
    sellTaxPct: string | null;
    /** All Pct values are percentage points: 0.27 means 0.27%. */
    top10HolderPct?: string | null;
    devHoldingPct?: string | null;
    sniperHoldingPct?: string | null;
    ratHoldingPct?: string | null;
    phishingHoldingPct?: string | null;
    bundlerHoldingPct?: string | null;
    /** GMGN volume fractions must not be presented as holding shares. */
    ratVolumePct?: string | null;
    bundlerVolumePct?: string | null;
    phishingVolumePct?: string | null;
    rugRatio?: string | null;
    isOpenSource?: boolean | null;
    isRenounced?: boolean | null;
    buyBlocked?: boolean;
    informationIncomplete?: boolean;
  };
}
export interface Candle {
  series?: "USD" | "USD_EXEC_01_V1";
  retracted?: true;
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  previousClose: string | null;
  baseVolume: string | null;
  quoteVolume: string | null;
  rawVolume?: string;
  rawVolumeUnit?: "BASE" | "QUOTE" | "USD" | "UNKNOWN";
  revision: string;
}

export interface CandleSnapshot {
  candleRules?: {
    series: "USD" | "USD_EXEC_01_V1";
    minTradeNotionalUsd: "0.01" | "0.1";
    ohlc: "LEGACY_CONTINUOUS" | "BUCKET_TRADES";
    historyRebuilt: boolean;
  };
  chainId: number;
  tokenAddress: string;
  marketKey: string;
  interval: Interval;
  syncStatus: "BACKFILLING" | "CATCHING_UP" | "READY" | "STALE" | "FAILED";
  availability: "COMPLETE" | "PARTIAL" | "UNAVAILABLE_BEFORE_START";
  coverage: { from: number | null; to: number | null };
  gaps: Array<{
    from: number;
    to: number;
    reason: "BEFORE_SCAN_START" | "EVENT_EXPIRED" | "PRICING_SUPPRESSED";
  }>;
  revision: string;
  asOfBlock: number | null;
  source: "CHAIN";
  items: Candle[];
  retractions?: Array<{ t: number; revision: string }>;
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
  side: "BUY" | "SELL";
  priceUsd: string;
  baseAmount: string;
  quoteAmount: string;
  quoteAsset: string;
  trader: string | null;
  wallets?: Array<{
    address: string;
    labels: string[];
    labelSource: "LOCAL_MANUAL";
    marketCapUsd: string | null;
  }>;
  marketCapUsd?: string | null;
  coverage?: "TRACKED_WALLETS" | "WALLET_ATTRIBUTION_UNAVAILABLE";
  txHash: string;
}

export interface AccountSummary {
  walletAssets?: { address: string; balances: AccountSummary["quoteBalances"] };
  quoteBalances: Array<{ asset: Asset; available: string; frozen: string }>;
  positions: Array<{
    tokenAddress: string;
    symbol: string;
    available: string;
    costUsd: string | null;
    valueUsd: string | null;
  }>;
}

export interface GasEstimate {
  estimated: true;
  source: "RECENT_ATOMIC_RECEIPT";
  gasUnits: string;
  gasPriceWei: string;
  estimatedFeeWei: string;
  nativeAmount: string;
  usdAmount?: string;
  sampleTransactionHash: string;
  observedAt: number;
}

export interface Quote {
  quoteId: string;
  status?: "PREPARED_ROUTE";
  precision?: "CORE_CURVE_ESTIMATE";
  netRecipientGuaranteed?: false;
  simulationStatus?: "NOT_SIMULATED";
  tokenAddress: string;
  side: "BUY" | "SELL";
  amountIn: string;
  expectedAmountOut: string;
  minAmountOut: string;
  idealOut?: string;
  targetOut?: string;
  minOut?: string;
  slippageBps?: number;
  configuredFeeBps?: string;
  effectiveFeeBps?: string;
  feeRecipient?: string;
  slippageMode?: "AUTO" | "MANUAL";
  reference?: {
    closeUsd: string;
    observedAt: number;
    interval: "1s";
    revision: string;
    maxAgeMs: number;
  };
  feeConfigVersion?: string;
  settlementAsset: Asset;
  executionMode?: "DIRECT_ETH" | "PLATFORM_ETH_INVENTORY" | "MAIN_ACCOUNT";
  residualAssets?: Array<{
    address: string;
    symbol: string;
    decimals: number;
    expectedAmountAtomic: string;
  }>;
  routeAssets?: Array<{ address: string; symbol: string; decimals: number }>;
  routePools?: Array<{
    poolKey: string;
    poolType: string;
    liquidityUsd: string;
    fee?: number;
    factoryAddress?: string;
  }>;
  routeHops?: Array<{
    poolKey: string;
    poolType: string;
    venue: string;
    tokenIn: string;
    tokenOut: string;
  }>;
  routeFingerprint?: string;
  fees: Array<{ type: string; asset: Asset; amount: string; estimated: boolean }>;
  gasEstimate?: GasEstimate;
  expiresAt: number;
}

export interface LocalEstimate extends Omit<
  Quote,
  "quoteId" | "status" | "executionMode" | "routeAssets"
> {
  expectedAmountOutAtomic: string;
  outputDecimals: number;
  inputPriceUsd?: string;
  outputPriceUsd?: string;
  quoteId: string;
  status: "LOCAL_ESTIMATE";
  requiresExecutionPreparation: true;
  precision: "CORE_CURVE_ESTIMATE";
  netRecipientGuaranteed: false;
  routeAssets?: string[];
}
export type QuoteDisplay = Quote | LocalEstimate;

export interface AccountTransaction {
  executionId: string;
  tokenAddress: string;
  tokenSymbol: string;
  side: "BUY" | "SELL";
  settlementAsset: Asset;
  amountIn: string;
  amountOut: string | null;
  status: "PENDING" | "CONFIRMED" | "FAILED" | "SUBMISSION_UNKNOWN";
  confirmedSteps?: Array<{ stepIndex: number; kind: string; txHash: string }>;
  txHashes: string[];
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  /** Actual amounts and fees, independently verified from the execution receipt. */
  settlement?: {
    amountIn: string;
    amountOut: string;
    priceUsd: string;
    marketCapUsd: string | null;
    fee: {
      asset: "USDG";
      tokenAddress: string;
      recipient: string;
      amount: string;
      received: string;
      estimated: false;
    };
  };
}
