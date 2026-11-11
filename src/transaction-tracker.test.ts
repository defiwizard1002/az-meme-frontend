import { afterEach, describe, expect, it, vi } from "vitest";
import { pollTransactionUntilTerminal } from "./transaction-tracker";
import type { AccountTransaction } from "./types";

const pending: AccountTransaction = {
  executionId: "execution-1",
  tokenAddress: "0x1111111111111111111111111111111111111111",
  tokenSymbol: "MEME",
  side: "BUY",
  settlementAsset: "USDG",
  amountIn: "0.1",
  amountOut: null,
  status: "PENDING",
  txHashes: [],
  errorMessage: null,
  createdAt: 1,
  updatedAt: 1,
};

describe("main-account transaction tracking", () => {
  const cleanScenario1 = () => vi.useRealTimers();
  afterEach(cleanScenario1);

  it("main-account transaction tracking: 2 related scenarios", async () => {
    // polls until the transaction is confirmed
    await (async () => {
      vi.useFakeTimers();
      let calls = 0;
      const tracking = pollTransactionUntilTerminal(pending.executionId, {
        signal: new AbortController().signal,
        pollIntervalMs: 1_000,
        loadTransaction: async () =>
          ++calls === 2 ? { ...pending, status: "CONFIRMED" } : pending,
        onUpdate: vi.fn(),
      });

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(tracking).resolves.toMatchObject({ status: "CONFIRMED" });
      expect(calls).toBe(2);
    })();
    await cleanScenario1();
    // keeps unknown submissions pending until a verified final result without resubmitting
    await (async () => {
      vi.useFakeTimers();
      const loadTransaction = vi
        .fn()
        .mockResolvedValueOnce({ ...pending, status: "SUBMISSION_UNKNOWN" })
        .mockResolvedValueOnce({ ...pending, status: "CONFIRMED" });
      const tracking = pollTransactionUntilTerminal(pending.executionId, {
        signal: new AbortController().signal,
        loadTransaction,
        onUpdate: vi.fn(),
        pollIntervalMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(1000);
      await expect(tracking).resolves.toMatchObject({ status: "CONFIRMED" });
      expect(loadTransaction).toHaveBeenCalledTimes(2);
    })();
  });
});
