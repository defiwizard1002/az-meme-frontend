import { expect, it } from "vitest";
import { calculatedSlippage, settlementUsdPrice, withSlippageMinimum } from "./quote-flow";
import type { LocalEstimate } from "./types";
const quote = (side: "BUY" | "SELL", amountIn: string, expectedAmountOut: string) =>
  ({ side, amountIn, expectedAmountOut, settlementAsset: "USDG" }) as LocalEstimate;
it("normalizes BUY/SELL USD and native units, uses selected response output and adds 5pp above 30%", () => {
  expect(
    settlementUsdPrice("ETH", { quoteAssetKey: "NATIVE", priceUsd: "2", priceQuote: "0.001" }),
  ).toBe("2000.000000000000000000000000000000000000");
  expect(
    settlementUsdPrice("WETH", { quoteAssetKey: "OTHER", priceUsd: "2", priceQuote: "0.001" }),
  ).toBe("0");
  expect(calculatedSlippage(quote("BUY", "100", "30"), "2", "1")).toMatchObject({
    impactBps: 4000,
    suggestedBps: 4500,
  });
  expect(calculatedSlippage(quote("SELL", "50", "60"), "2", "1")).toMatchObject({
    impactBps: 4000,
    suggestedBps: 4500,
  });
  expect(calculatedSlippage(quote("BUY", "0.05", "30"), "2", "2000")).toMatchObject({
    impactBps: 4000,
    suggestedBps: 4500,
  });
  expect(calculatedSlippage(quote("SELL", "50", "0.03"), "2", "2000")).toMatchObject({
    impactBps: 4000,
    suggestedBps: 4500,
  });
});
it("rounds bps up exactly; favorable quotes keep 5pp and missing or >=100% defaults stay unavailable", () => {
  expect(calculatedSlippage(quote("BUY", "1", "0.999999999999999999"), "1", "1")).toMatchObject({
    impactBps: 1,
    suggestedBps: 501,
  });
  expect(calculatedSlippage(quote("BUY", "1", "2"), "1", "1")).toMatchObject({
    impactBps: -10000,
    suggestedBps: 500,
  });
  expect(calculatedSlippage(quote("BUY", "1", "1"), "0", "1")).toBeNull();
  expect(calculatedSlippage(quote("BUY", "1", "0.01"), "1", "1")).toMatchObject({
    impactBps: 9900,
    suggestedBps: null,
  });
});
it("applies an above30% tolerance to exact atomic minOut without Number rounding", () => {
  const result = withSlippageMinimum(
    {
      ...quote("BUY", "1", "1000000000000000000.000000000000000001"),
      status: "LOCAL_ESTIMATE",
      expectedAmountOutAtomic: "1000000000000000000000000000000000001",
      outputDecimals: 18,
    } as LocalEstimate,
    4500,
  );
  expect(result.minAmountOut).toBe("550000000000000000");
});
