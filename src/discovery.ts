import { percent } from "./display";
import type { Token } from "./types";
export type MarketSort =
  | "ageSeconds"
  | "priceUsd"
  | "change1h"
  | "change24h"
  | "marketCapUsd"
  | "volume1hUsd"
  | "volume24hUsd"
  | "liquidityUsd"
  | "holders"
  | "smartMoneyCount"
  | "kolCount";
export function orderMarkets(
  items: Token[],
  field: MarketSort,
  direction: "asc" | "desc",
): Token[] {
  return [...items].sort((a, b) => {
    const left = a[field],
      right = b[field];
    if (left == null) return right == null ? a.tokenAddress.localeCompare(b.tokenAddress) : 1;
    if (right == null) return -1;
    const delta = Number(left) - Number(right);
    return (direction === "asc" ? delta : -delta) || a.tokenAddress.localeCompare(b.tokenAddress);
  });
}
export function reconcileMarkets(
  current: Token[],
  incoming: Token[],
  frozen: boolean,
): { items: Token[]; added: number } {
  if (!frozen) return { items: incoming, added: 0 };
  const next = new Map(incoming.map((token) => [token.tokenAddress.toLowerCase(), token]));
  const existing = new Set(current.map((token) => token.tokenAddress.toLowerCase()));
  return {
    items: current.map((token) => next.get(token.tokenAddress.toLowerCase()) ?? token),
    added: incoming.filter((token) => !existing.has(token.tokenAddress.toLowerCase())).length,
  };
}
export function lifecycleLabel(token: Token): string {
  const life = token.lifecycle;
  if (!life) return "阶段未知";
  const labels: Record<string, string> = {
    CURVE: "内盘",
    NEAR_GRADUATION: "即将毕业",
    GRADUATED: "已毕业",
    SWEPT: "等待建池",
    RESCUED: "已救援",
    NOT_APPLICABLE: "外盘",
    UNKNOWN: "阶段未知",
  };
  const text = labels[life.state] ?? "阶段未知";
  return life.state === "CURVE" || life.state === "NEAR_GRADUATION"
    ? `${text} · ${life.progressPct == null ? "进度未知" : percent(life.progressPct)}`
    : text;
}

/** Apply committed price patches without regressing a newer observation. */
export function mergeLiveToken(current: Token, patch: Partial<Token>): Token {
  if (
    patch.tokenAddress?.toLowerCase() !== current.tokenAddress.toLowerCase() ||
    (patch.chainId !== undefined && patch.chainId !== current.chainId)
  )
    return current;
  if (
    patch.priceObservedAt !== undefined &&
    current.priceObservedAt !== undefined &&
    (patch.priceObservedAt < current.priceObservedAt ||
      (patch.priceObservedAt === current.priceObservedAt &&
        patch.liveRevision &&
        current.liveRevision &&
        BigInt(patch.liveRevision) <= BigInt(current.liveRevision)))
  )
    return current;
  return { ...current, ...patch };
}
