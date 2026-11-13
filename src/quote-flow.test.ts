import { describe, expect, it } from "vitest";
import { requireQuoteTerms } from "./quote-flow";
import type { Quote } from "./types";

const tokenAddress = `0x${"2".repeat(40)}`;
const draft = {
  side: "BUY" as const,
  tokenAddress,
  settlementAsset: "USDG" as const,
  amountIn: "100",
};
const quote = {
  ...draft,
  quoteId: "quote-1",
  expectedAmountOut: "90",
  minAmountOut: "80",
  idealOut: "100",
  targetOut: "90",
  minOut: "80",
  slippageBps: 2000,
  configuredFeeBps: "100",
  effectiveFeeBps: "0",
  feeRecipient: `0x${"0".repeat(40)}`,
  reference: {
    closeUsd: "1",
    observedAt: Date.now(),
    interval: "1s" as const,
    revision: "1",
    maxAgeMs: 60000,
  },
  feeConfigVersion: "1",
  fees: [{ type: "SERVICE" as const, asset: "USDG" as const, amount: "0", estimated: true }],
  expiresAt: Date.now() + 60_000,
  routeFingerprint: "route-1",
  routeAssets: [
    { address: `0x${"1".repeat(40)}`, symbol: "USDG", decimals: 18 },
    { address: tokenAddress, symbol: "MEME", decimals: 18 },
  ],
  routePools: [{ poolKey: "pool-1", poolType: "V2" as const, liquidityUsd: "1000" }],
} satisfies Quote;

describe("quote reference sources", () => {
  it("accepts a closed 1s candle reference", () => {
    expect(requireQuoteTerms(quote, draft)).toBeTruthy();
  });

  it("accepts a quote priced from the current pool state with its block", () => {
    const stateQuote = {
      ...quote,
      reference: {
        closeUsd: "1",
        observedAt: Date.now(),
        interval: "STATE" as const,
        source: "LOCAL_POOL_STATE" as const,
        asOfBlock: 112935553,
        blockHash: null,
        revision: "112935553",
        maxAgeMs: 60000,
      },
    } satisfies Quote;
    expect(requireQuoteTerms(stateQuote, draft)).toBeTruthy();
  });

  it("rejects a state reference without a source block", () => {
    const stateQuote = {
      ...quote,
      reference: {
        closeUsd: "1",
        observedAt: Date.now(),
        interval: "STATE" as const,
        source: "LOCAL_POOL_STATE" as const,
        revision: "1",
        maxAgeMs: 60000,
      },
    } as unknown as Quote;
    expect(() => requireQuoteTerms(stateQuote, draft)).toThrow(/参考价/);
  });
});
