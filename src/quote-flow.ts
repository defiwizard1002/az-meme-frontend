import type { Asset, Quote, QuoteDisplay } from "./types";
export type QuoteRequest = {
  side: "BUY" | "SELL";
  tokenAddress: string;
  settlementAsset: Asset;
  amountIn: string;
  slippageBps: number;
  purpose?: "ESTIMATE" | "PREPARE_EXECUTION";
  minAmountOut?: string;
};
function decimal(value: string): [bigint, number] {
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw Error("金额格式无效");
  const [whole, fraction = ""] = value.split(".");
  return [BigInt(whole! + fraction), fraction.length];
}
export function compareAmounts(a: string, b: string): number {
  const [av, ad] = decimal(a),
    [bv, bd] = decimal(b),
    d = Math.max(ad, bd),
    left = av * 10n ** BigInt(d - ad),
    right = bv * 10n ** BigInt(d - bd);
  return left < right ? -1 : left > right ? 1 : 0;
}
export function matchesDraft(q: QuoteDisplay, r: QuoteRequest): boolean {
  return (
    q.tokenAddress.toLowerCase() === r.tokenAddress.toLowerCase() &&
    q.side === r.side &&
    q.settlementAsset === r.settlementAsset &&
    compareAmounts(q.amountIn, r.amountIn) === 0
  );
}
export function withSlippageMinimum(quote: QuoteDisplay, slippageBps: number): QuoteDisplay {
  if (quote.status !== "LOCAL_ESTIMATE") return quote;
  const decimals = quote.outputDecimals;
  if (
    !Number.isInteger(slippageBps) ||
    slippageBps < 1 ||
    slippageBps > 9999 ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255 ||
    !/^\d+$/.test(quote.expectedAmountOutAtomic)
  )
    throw Error("报价精度无效，请刷新报价");
  const [value, scale] = decimal(quote.expectedAmountOut);
  const expected = BigInt(quote.expectedAmountOutAtomic);
  if (scale > decimals || value * 10n ** BigInt(decimals - scale) !== expected)
    throw Error("报价数量与精度不一致，请刷新报价");
  const minimum = (expected * BigInt(10000 - slippageBps)) / 10000n;
  const digits = minimum.toString().padStart(decimals + 1, "0");
  const minAmountOut = decimals
    ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`.replace(/\.?0+$/, "")
    : digits;
  return { ...quote, minAmountOut };
}
/** Prices are USD per unit. The quote is already the first selected path; never rerank it. */
export function calculatedSlippage(
  quote: QuoteDisplay,
  tokenPriceUsd: string,
  settlementPriceUsd: string,
) {
  if (
    ![tokenPriceUsd, settlementPriceUsd, quote.amountIn, quote.expectedAmountOut].every((v) =>
      /^\d+(?:\.\d+)?$/.test(v),
    )
  )
    return null;
  const [amount, ad] = decimal(quote.amountIn),
    [out, od] = decimal(quote.expectedAmountOut);
  const [token, td] = decimal(tokenPriceUsd),
    [settlement, sd] = decimal(settlementPriceUsd);
  if (amount <= 0n || token <= 0n || settlement <= 0n) return null;
  const [ip, id, op, opd] =
    quote.side === "BUY" ? [settlement, sd, token, td] : [token, td, settlement, sd];
  const idealNumerator = amount * ip * 10n ** BigInt(opd);
  const idealDenominator = op * 10n ** BigInt(ad + id);
  const denominator = idealNumerator * 10n ** BigInt(od);
  const gap = (denominator - out * idealDenominator) * 10000n;
  const rounded = gap > 0n ? (gap + denominator - 1n) / denominator : gap / denominator;
  const impactBps = Number(rounded);
  const suggested = (rounded > 0n ? rounded : 0n) + 500n;
  return { impactBps, suggestedBps: suggested < 10000n ? Number(suggested) : null };
}
/** Use the same-chain native quote and USD price already supplied for the selected asset. */
export function settlementUsdPrice(
  asset: Asset,
  token: { quoteAssetKey: string; priceUsd: string; priceQuote: string },
): string {
  if (asset !== "ETH" && asset !== "WETH") return "1";
  if (
    token.quoteAssetKey !== "NATIVE" ||
    !/^\d+(?:\.\d+)?$/.test(token.priceUsd ?? "") ||
    !/^\d+(?:\.\d+)?$/.test(token.priceQuote ?? "")
  )
    return "0";
  const [usd, ud] = decimal(token.priceUsd),
    [native, nd] = decimal(token.priceQuote);
  if (native <= 0n) return "0";
  const value = (usd * 10n ** BigInt(nd + 36)) / (native * 10n ** BigInt(ud));
  const digits = value.toString().padStart(37, "0");
  return `${digits.slice(0, -36)}.${digits.slice(-36)}`;
}
export function preparationInput(request: QuoteRequest, estimate: QuoteDisplay): QuoteRequest {
  if (!matchesDraft(estimate, request)) throw Error("估计与当前输入不匹配");
  if (estimate.expiresAt <= Date.now()) throw Error("报价已过期，请等待新报价后重新准备");
  return {
    ...request,
    purpose: "PREPARE_EXECUTION",
    amountIn: request.amountIn,
    minAmountOut: request.minAmountOut ?? estimate.minAmountOut,
  };
}
export function requirePreparedQuote(
  value: QuoteDisplay,
  request: QuoteRequest,
  now = Date.now(),
): Quote {
  if (value.status === "LOCAL_ESTIMATE" || !value.quoteId)
    throw Error("准备未完成：估计不能提交交易，请重试");
  if (!matchesDraft(value, request)) throw Error("准备结果与当前输入不匹配");
  if (value.expiresAt <= now) throw Error("准备结果已过期，请重试");
  if (
    request.minAmountOut === undefined ||
    compareAmounts(value.minAmountOut, request.minAmountOut) < 0
  )
    throw Error("准备结果不能降低最低得到");
  if (compareAmounts(value.minAmountOut, request.minAmountOut) !== 0)
    throw Error("最低得到与请求值不一致，请重试");
  if (
    !value.routeFingerprint ||
    !value.routePools?.length ||
    !value.routeAssets ||
    value.routeAssets.length < 2
  )
    throw Error("准备结果缺少路径，请重新准备");
  return value as Quote;
}
