import { describe, expect, it, vi, afterEach } from "vitest";
import {
  preparationInput,
  requirePreparedQuote,
  compareAmounts,
  withSlippageMinimum,
} from "./quote-flow";
import { memeApi } from "./api";
import type { LocalEstimate, Quote } from "./types";
const request = {
  side: "BUY" as const,
  tokenAddress: "token",
  settlementAsset: "USDG" as const,
  amountIn: "1.000000000000000001",
  slippageBps: 100,
  purpose: "ESTIMATE" as const,
};
const estimate: LocalEstimate = {
  ...request,
  status: "LOCAL_ESTIMATE",
  requiresExecutionPreparation: true,
  precision: "CORE_CURVE_ESTIMATE",
  netRecipientGuaranteed: false,
  expectedAmountOut: "10",
  expectedAmountOutAtomic: "10000000000000000000",
  outputDecimals: 18,
  minAmountOut: "9.900000000000000001",
  fees: [],
  expiresAt: Date.now() + 30000,
};
const ready: Quote = {
  ...request,
  quoteId: "prepared-id",
  expectedAmountOut: "10",
  minAmountOut: estimate.minAmountOut,
  fees: [],
  expiresAt: 2000,
  routeFingerprint: "chosen",
  routeAssets: [
    { address: "input", symbol: "USDG", decimals: 18 },
    { address: "token", symbol: "TOKEN", decimals: 18 },
  ],
  routePools: [{ poolKey: "actual", poolType: "UNISWAP_V3", liquidityUsd: "1" }],
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("estimate → internal preparation → execution binding", () => {
  it("preserves the exact draft amount and minimum in the preparation POST; no execution POST", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ rc: 0, result: ready })));
    vi.stubGlobal("fetch", fetch);
    const input = preparationInput(request, estimate);
    await memeApi.createQuote(input);
    expect(input).toEqual({
      ...request,
      purpose: "PREPARE_EXECUTION",
      minAmountOut: estimate.minAmountOut,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]![0])).toContain("/quotes");
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual(input);
  });
  it("an estimate cannot pass execution validation; prepared result can only pass with the preserved minimum", () => {
    const input = preparationInput(request, estimate);
    expect(() => requirePreparedQuote(estimate, input, 1000)).toThrow("估计不能提交");
    expect(requirePreparedQuote(ready, input, 1000).quoteId).toBe("prepared-id");
    expect(() =>
      requirePreparedQuote({ ...ready, minAmountOut: "9.900000000000000000" }, input, 1000),
    ).toThrow("不能降低");
  });
  it("rejects edited input, expired preparation and preserves a stricter existing minimum", () => {
    const input = preparationInput({ ...request, minAmountOut: "9.99" }, estimate);
    expect(input.minAmountOut).toBe("9.99");
    expect(() => requirePreparedQuote(ready, { ...input, amountIn: "2" }, 1000)).toThrow(
      "输入不匹配",
    );
    expect(() => requirePreparedQuote(ready, input, 2000)).toThrow("过期");
    expect(() => preparationInput({ ...request, amountIn: "2" }, estimate)).toThrow("不匹配");
  });
  it("requires the prepared route and preserves the exact requested minimum", () => {
    const input = preparationInput(request, estimate);
    expect(() => requirePreparedQuote({ ...ready, routeAssets: [] }, input, 1000)).toThrow(
      "缺少路径",
    );
    expect(() => requirePreparedQuote({ ...ready, minAmountOut: "9.99" }, input, 1000)).toThrow(
      "最低得到与请求值不一致",
    );
  });
  it("handles approval-required preparation explicitly without executing or approving", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ rc: 0, result: { status: "APPROVAL_REQUIRED", prerequisiteId: "id" } }),
        ),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(memeApi.createQuote(preparationInput(request, estimate))).rejects.toMatchObject({
      code: "MEME_APPROVAL_REQUIRED",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("compares minimums beyond Number precision in both BUY and SELL drafts", () => {
    expect(compareAmounts("9.900000000000000001", "9.900000000000000000")).toBe(1);
    expect(compareAmounts("1.00", "1")).toBe(0);
    const sell = { ...request, side: "SELL" as const };
    expect(preparationInput(sell, { ...estimate, side: "SELL" }).amountIn).toBe(request.amountIn);
  });
});

it("uses atomic integer floors at 18 and 8 decimals, validates precision and never prepares an expired estimate", () => {
  const q = {
    ...estimate,
    outputDecimals: 18,
    expectedAmountOut: "10.000000000000000002",
    expectedAmountOutAtomic: "10000000000000000002",
  };
  expect(withSlippageMinimum(q, 2000).minAmountOut).toBe("8.000000000000000001");
  expect(withSlippageMinimum(q, 300).minAmountOut).toBe("9.700000000000000001");
  expect(
    withSlippageMinimum(
      { ...q, outputDecimals: 8, expectedAmountOut: "0.00000026", expectedAmountOutAtomic: "26" },
      2000,
    ).minAmountOut,
  ).toBe("0.0000002");
  expect(() => withSlippageMinimum({ ...q, expectedAmountOutAtomic: "1" }, 2000)).toThrow();
  expect(() => preparationInput(request, { ...q, expiresAt: Date.now() - 1 })).toThrow("过期");
});
