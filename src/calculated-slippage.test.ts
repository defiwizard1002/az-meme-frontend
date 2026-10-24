import { expect, it } from "vitest";
import {
  calculatedSlippage,
  latestTradePrice,
  settlementUsdPrice,
  withSlippageMinimum,
} from "./quote-flow";
import type { LocalEstimate, Trade } from "./types";
const quote = (side: "BUY" | "SELL", amountIn: string, expectedAmountOut: string) =>
  ({ side, amountIn, expectedAmountOut, settlementAsset: "USDG" }) as LocalEstimate;
it("uses exactly positive target-minus-reference / reference plus five percentage points", () => {
  for (const [target, bps] of [
    ["110", 1500],
    ["90", 500],
    ["100", 500],
  ] as const)
    expect(calculatedSlippage(quote("BUY", "100", target), "1", "1")?.suggestedBps).toBe(bps);
  expect(calculatedSlippage(quote("BUY", "100", "200"), "1", "1")?.suggestedBps).toBe(10500);
});
it("converts BUY and SELL output units including native settlement", () => {
  expect(
    settlementUsdPrice("ETH", { quoteAssetKey: "NATIVE", priceUsd: "2", priceQuote: "0.001" }),
  ).toBe("2000.000000000000000000000000000000000000");
  for (const q of [quote("BUY", "100", "55"), quote("SELL", "50", "110")])
    expect(calculatedSlippage(q, "2", "1")?.suggestedBps).toBe(1500);
  for (const q of [quote("BUY", "0.05", "55"), quote("SELL", "50", "0.055")])
    expect(calculatedSlippage(q, "2", "2000")?.suggestedBps).toBe(1500);
});
it("keeps exact arithmetic until final integer bps; absent/zero latest price is unknown", () => {
  expect(
    calculatedSlippage(quote("BUY", "1", "1.000000000000000001"), "1", "1")?.suggestedBps,
  ).toBe(501);
  for (const p of ["0", ""]) expect(calculatedSlippage(quote("BUY", "1", "1"), p, "1")).toBeNull();
  expect(
    calculatedSlippage(
      {
        ...quote("BUY", "1", "999"),
        status: "LOCAL_ESTIMATE",
        expectedAmountOutAtomic: "1100000",
        outputDecimals: 6,
      },
      "1",
      "1",
    )?.suggestedBps,
  ).toBe(1500);
});
it("selects latest event independent of array order; same-transaction logs order numerically, ambiguous ties stay unknown", () => {
  const t = (time: number, tx: string, log: number, priceUsd: string) =>
    ({ t: time, txHash: tx, tradeId: `4663:${tx}:${log}`, priceUsd }) as Trade;
  const rows = [t(10, "a", 9, "1"), t(9, "b", 20, "8"), t(10, "a", 10, "2")];
  expect(latestTradePrice(rows)).toBe("2");
  expect(latestTradePrice(rows.reverse())).toBe("2");
  expect(latestTradePrice([...rows, t(10, "b", 1, "3")])).toBeNull();
  expect(latestTradePrice([...rows, t(11, "b", 1, "0")])).toBeNull();
});
it("floors client minimum from atomic output exactly once", () => {
  const q = {
    ...quote("BUY", "1", "1000000000000000000.000000000000000001"),
    status: "LOCAL_ESTIMATE",
    expectedAmountOutAtomic: "1000000000000000000000000000000000001",
    outputDecimals: 18,
  } as LocalEstimate;
  expect(withSlippageMinimum(withSlippageMinimum(q, 500), 1500).minAmountOut).toBe(
    "850000000000000000",
  );
});
