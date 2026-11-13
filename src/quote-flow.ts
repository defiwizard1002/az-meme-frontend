import type { Asset, Quote, QuoteDisplay } from "./types";

export interface QuoteRequest {
  side: "BUY" | "SELL";
  tokenAddress: string;
  settlementAsset: Asset;
  amountIn: string;
  purpose?: "ESTIMATE" | "PREPARE_EXECUTION";
  slippageBps?: number;
  slippageMode?: "AUTO";
  estimateId?: string;
  minAmountOut?: string;
  feeConfigVersion?: string;
}

function decimal(value: string): [bigint, number] {
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw Error("金额格式无效");
  const [whole, fraction = ""] = value.split(".");
  return [BigInt(whole + fraction), fraction.length];
}
export function compareAmounts(a: string, b: string): number {
  const [av, ad] = decimal(a),
    [bv, bd] = decimal(b),
    d = Math.max(ad, bd);
  const left = av * 10n ** BigInt(d - ad),
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
export type QuoteTerms = {
  idealOut: string;
  targetOut: string;
  minOut: string;
  slippageBps: number;
  configuredFeeBps: string;
  effectiveFeeBps: string;
  feeRecipient: string;
  reference: NonNullable<Quote["reference"]>;
  feeConfigVersion: string;
};
export type ValidQuote = QuoteDisplay & QuoteTerms;
export class QuoteExpiredError extends Error {}

// 报价参考价有两种合法来源：最近一根已收盘 1 秒 K 线，或按本次金额算出的当前池状态。
// 池状态必须带明确来源和所在区块，避免把无来源的数字当成可成交价格。
function isLiveReference(reference: NonNullable<Quote["reference"]>): boolean {
  if (reference.interval === "1s") return true;
  return (
    reference.interval === "STATE" &&
    reference.source === "LOCAL_POOL_STATE" &&
    Number.isSafeInteger(reference.asOfBlock) &&
    (reference.asOfBlock ?? 0) > 0
  );
}

/** Validate the server contract once. The browser never derives trading limits from chart data. */
export function requireQuoteTerms(
  value: QuoteDisplay,
  request: QuoteRequest,
  now = Date.now(),
): ValidQuote {
  for (const amount of [value.idealOut, value.targetOut, value.minOut]) {
    if (typeof amount !== "string" || !/^\d+(?:\.\d+)?$/.test(amount))
      throw Error("报价缺少净输出或最低到账，暂时无法交易");
    if (compareAmounts(amount, "0") <= 0) throw Error("报价输出必须大于 0");
  }
  const serviceFee = value.fees?.find((fee) => fee.type === "SERVICE");
  if (
    typeof value.effectiveFeeBps !== "string" ||
    !/^\d+$/.test(value.effectiveFeeBps) ||
    BigInt(value.effectiveFeeBps) >= 10000n ||
    typeof value.configuredFeeBps !== "string" ||
    !/^\d+$/.test(value.configuredFeeBps) ||
    typeof value.feeRecipient !== "string" ||
    !/^0x[0-9a-f]{40}$/i.test(value.feeRecipient) ||
    !serviceFee ||
    serviceFee.asset !== "USDG" ||
    !/^\d+(?:\.\d+)?$/.test(serviceFee.amount) ||
    typeof value.feeConfigVersion !== "string" ||
    !/^\d+$/.test(value.feeConfigVersion)
  )
    throw Error("报价缺少有效费用配置，暂时无法交易");
  if (
    !value.reference ||
    !isLiveReference(value.reference) ||
    !Number.isFinite(value.reference.observedAt) ||
    !Number.isFinite(value.reference.maxAgeMs) ||
    value.reference.maxAgeMs <= 0 ||
    now - value.reference.observedAt >= value.reference.maxAgeMs
  )
    throw Error("报价缺少有效 K 线参考价，暂时无法交易");
  if (!value.quoteId) throw Error("报价缺少身份，请刷新报价");
  if (!Number.isInteger(value.slippageBps) || value.slippageBps! < 0 || value.slippageBps! >= 10000)
    throw Error("报价缺少有效滑点，暂时无法交易");
  if (!Number.isFinite(value.expiresAt)) throw Error("报价缺少有效期");
  if (value.expiresAt <= now) throw new QuoteExpiredError("报价已过期，请刷新报价");
  if (!matchesDraft(value, request)) throw Error("报价与当前输入不匹配");
  if (compareAmounts(value.minAmountOut, value.minOut!) !== 0)
    throw Error("报价最低到账不一致，请刷新报价");
  return value as ValidQuote;
}
export function preparationInput(request: QuoteRequest, estimate: ValidQuote): QuoteRequest {
  if (!matchesDraft(estimate, request)) throw Error("报价与当前输入不匹配");
  if (estimate.expiresAt <= Date.now()) throw new QuoteExpiredError("报价已过期，请刷新报价");
  return {
    ...request,
    purpose: "PREPARE_EXECUTION",
    estimateId: estimate.quoteId,
    slippageMode: "AUTO",
    minAmountOut: estimate.minOut,
    slippageBps: estimate.slippageBps,
    feeConfigVersion: estimate.feeConfigVersion,
  };
}
export function requirePreparedQuote(
  value: ValidQuote,
  request: QuoteRequest,
  now = Date.now(),
): Quote & QuoteTerms {
  if (value.status === "LOCAL_ESTIMATE" || !value.quoteId)
    throw Error("准备未完成，报价不能提交交易");
  if (!matchesDraft(value, request)) throw Error("准备结果与当前输入不匹配");
  if (value.expiresAt <= now) throw new QuoteExpiredError("报价已过期，请刷新报价");
  if (value.feeConfigVersion !== request.feeConfigVersion)
    throw Error("费用配置已改变，请重新报价");
  if (
    value.slippageBps !== request.slippageBps ||
    request.minAmountOut === undefined ||
    compareAmounts(value.minOut, request.minAmountOut) !== 0
  )
    throw Error("滑点或最低到账已改变，请重新报价");
  if (
    !value.routeFingerprint ||
    !value.routePools?.length ||
    !value.routeAssets ||
    value.routeAssets.length < 2
  )
    throw Error("准备结果缺少交易路径");
  return value as Quote & QuoteTerms;
}
