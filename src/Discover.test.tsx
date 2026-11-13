import { describe, expect, it } from "vitest";
import { lifecycleLabel, orderMarkets, reconcileMarkets, mergeLiveToken } from "./discovery";
import { money, percent, safeUrl } from "./display";
import type { Token } from "./types";
const token = (id: string, volume: string | null, age: number | null): Token =>
  ({ tokenAddress: id, volume24hUsd: volume, ageSeconds: age }) as Token;
describe("Discover ordering and honest missing values", () => {
  it("Discover ordering and honest missing values: 4 related scenarios", async () => {
    // orders new tokens by age, volume by descending value and missing values last
    await (async () => {
      const a = token("a", "10", 30),
        b = token("b", "20", 20),
        c = token("c", null, null);
      expect(orderMarkets([c, a, b], "ageSeconds", "asc").map((t) => t.tokenAddress)).toEqual([
        "b",
        "a",
        "c",
      ]);
      expect(orderMarkets([c, a, b], "volume24hUsd", "desc").map((t) => t.tokenAddress)).toEqual([
        "b",
        "a",
        "c",
      ]);
    })();

    // freezes insertion and position while still updating quote-related token data
    await (async () => {
      const a = token("a", "10", 30),
        b = token("b", "20", 20),
        c = token("c", "30", 10);
      const changed = { ...a, security: { isHoneypot: true } } as Token;
      const result = reconcileMarkets([a, b], [c, b, changed], true);
      expect(result.items.map((t) => t.tokenAddress)).toEqual(["a", "b"]);
      expect(result.items[0].security.isHoneypot).toBe(true);
      expect(result.added).toBe(1);
      const live = {
        ...a,
        chainId: 4663,
        priceObservedAt: 200,
        liveRevision: "2",
        marketCapUsd: "10",
      };
      expect(
        mergeLiveToken(live, {
          tokenAddress: "a",
          chainId: 4663,
          priceObservedAt: 199,
          marketCapUsd: "5",
        }),
      ).toBe(live);
      expect(
        mergeLiveToken(live, {
          tokenAddress: "a",
          chainId: 4663,
          priceObservedAt: 201,
          liveRevision: "3",
          marketCapUsd: null,
        }),
      ).toMatchObject({ marketCapUsd: null, liveRevision: "3" });
      expect(reconcileMarkets([a, b], [c, b, changed], false).items[0]).toBe(c);
    })();

    // never derives graduation from a missing progress value or an old stage
    await (async () => {
      expect(lifecycleLabel({ stage: "GRADUATED" } as Token)).toBe("—");
      expect(lifecycleLabel({ lifecycle: { state: "CURVE", progressPct: null } } as Token)).toBe(
        "On curve",
      );
      expect(
        lifecycleLabel({ lifecycle: { state: "NEAR_GRADUATION", progressPct: "80" } } as Token),
      ).toBe("Graduating soon");
    })();

    // distinguishes unknown from a known zero and rejects unsafe social URLs
    await (async () => {
      expect(money(null)).toBe("—");
      expect(money("0")).toBe("$0");
      expect(percent(undefined)).toBe("—");
      expect(safeUrl("javascript:alert(1)")).toBeUndefined();
      expect(safeUrl("https://x.com/test")).toBe("https://x.com/test");
    })();
  });
});
