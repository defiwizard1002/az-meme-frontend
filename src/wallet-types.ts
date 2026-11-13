/** Wallet facts use atomic integers and decimal USD strings; null means unknown. */
export type WalletLabel = "KOL" | "SMART_MONEY";
export interface WalletActivity {
  eventId: string;
  chainId: number;
  address: string;
  token: string;
  txHash: string;
  blockNumber: number;
  transactionIndex: number;
  timestampMs: number;
  kind: "BUY" | "SELL" | "TRANSFER_IN" | "TRANSFER_OUT";
  quantityAtomic: string;
  decimals: number;
  amountUsd: string | null;
  realizedPnlUsd: string | null;
  cycleClosed: boolean;
  closedCyclePnlUsd: string | null;
  gap: string | null;
  source: "LOCAL_TRANSFERS";
  labels?: WalletLabel[];
  labelSource?: "LOCAL_MANUAL";
  walletName?: string | null;
  walletAvatarUrl?: string | null;
  tokenName?: string | null;
  tokenSymbol?: string | null;
  tokenLogo?: string | null;
  marketCapUsd?: string | null;
  marketCapCoverage?: "SUPPLY_OR_PRICE_UNAVAILABLE" | "LOCAL_SUPPLY_AND_EXECUTION";
}
export interface WalletPosition {
  name?: string | null;
  symbol?: string | null;
  logo?: string | null;
  chainId: number;
  address: string;
  token: string;
  decimals: number;
  quantityAtomic: string | null;
  observedNetAtomic: string;
  quantityComplete: boolean;
  costUsd: string | null;
  boughtAtomic: string;
  soldAtomic: string;
  boughtUsd: string | null;
  soldUsd: string | null;
  realizedPnlUsd: string | null;
  cyclePnlUsd: string | null;
  cycleNumber: number;
  updatedAt: number;
  /** Valuations are unavailable until the API has a current local price and supply. */
  valueUsd?: string | null;
  currentMarketCapUsd?: string | null;
  averageEntryMarketCapUsd?: string | null;
  unrealizedPnlUsd?: string | null;
}
export interface WalletStats {
  buyCount: number;
  sellCount: number;
  boughtUsd: string | null;
  soldUsd: string | null;
  realizedPnlUsd: string | null;
  closedCycles: number;
  computableCycles: number;
  winningCycles: number;
  gapCount: number;
  winRate: string | null;
}
export interface WalletProfileData {
  chainId: number;
  address: string;
  name: string | null;
  avatarUrl: string | null;
  xUrl: string | null;
  labels: WalletLabel[];
  own: boolean;
  trackingStatus: "UNTRACKED" | "PENDING_SNAPSHOT" | "TRACKING";
  trackingRequestedAt: number | null;
  trackingStartedAt: number | null;
  snapshotBlock: number | null;
  snapshotHash: string | null;
  processedBlock: number | null;
  coverage: "UNKNOWN" | "LOCAL_TOKEN_DIRECTORY";
  stats: WalletStats | null;
  statsAt: number | null;
  gapCount: number;
  source: "LOCAL";
  window: { fromMs: number; toMs: number } | null;
  coverageMs: number | null;
  windowComplete: boolean;
  unrealizedPnlUsd: string | null;
}
export interface ActivityCursor {
  timestampMs: number;
  eventId: string;
}
export interface ActivityPage {
  items: WalletActivity[];
  nextCursor: ActivityCursor | null;
  source?: string;
  updatedAt?: number;
}
export interface ActivityQuery {
  scope: "ALL" | "FOLLOWING" | "SMART_MONEY" | "KOL";
  side: "ANY" | "BUY" | "SELL";
  minUsd: "ANY" | "500" | "2000";
  fromMs: number;
  limit?: number;
  before?: ActivityCursor;
}
export type UserStateKind = "FOLLOW" | "NOTE" | "WATCHLIST" | "SETTINGS";
export interface UserStateValue {
  note?: string;
  quickBuyAmounts?: string[];
}
export interface UserStateRow {
  target: string;
  value: UserStateValue;
  updatedAt: number;
}
export interface UserStatePage {
  items: UserStateRow[];
  nextCursor: string | null;
}
