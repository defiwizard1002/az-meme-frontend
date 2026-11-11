import { afterEach, expect, it, vi } from "vitest";
import { configureServerSignedTransactions, memeApi } from "./api";
import { pendingExecutionId, rememberExecution } from "./transaction-tracker";
const wallet = `0x${"1".repeat(40)}`;
const input = {
  walletAddress: wallet,
  clientExecutionId: "attempt-1",
  side: "BUY" as const,
  tokenAddress: `0x${"2".repeat(40)}`,
  settlementAsset: "USDG" as const,
  quoteId: "quote-1",
  amountIn: "1",
  minAmountOut: "1",
  slippageBps: 1000,
  feeConfigVersion: "1",
};
const rejection = (code: string, status = 409) =>
  new Response(JSON.stringify({ rc: status, mc: code, ma: [code], result: null }), { status });
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  configureServerSignedTransactions(false);
});
it("pre-create simulation rejection permits a new quote/attempt, clearing only that attempt", async () => {
  configureServerSignedTransactions(true);
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(rejection("MEME_ATOMIC_SIMULATION_FAILED"))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          rc: 0,
          result: {
            record: { executionId: "attempt-2", status: "PENDING" },
            authorizationRequest: null,
          },
        }),
      ),
    );
  vi.stubGlobal("fetch", fetch);
  await expect(memeApi.executeMainAccountTrade(input)).rejects.toMatchObject({
    code: "MEME_ATOMIC_SIMULATION_FAILED",
  });
  expect(pendingExecutionId(wallet)).toBeNull();
  await expect(
    memeApi.executeMainAccountTrade({
      ...input,
      clientExecutionId: "attempt-2",
      quoteId: "quote-2",
    }),
  ).resolves.toMatchObject({ executionId: "attempt-2" });
  expect(fetch.mock.calls.map((call) => call[1].method)).toEqual(["POST", "POST"]);
  localStorage.clear();
  fetch.mockImplementationOnce(async () => {
    rememberExecution(wallet, "another-attempt");
    return rejection("MEME_ATOMIC_SIMULATION_FAILED");
  });
  await expect(memeApi.executeMainAccountTrade(input)).rejects.toThrow();
  expect(pendingExecutionId(wallet)).toBe("another-attempt");
});
it("unknown responses, 404 and post-create rejections keep the original ID for recovery", async () => {
  configureServerSignedTransactions(true);
  for (const failure of [
    new Error("timeout"),
    rejection("MEME_TRANSACTION_NOT_FOUND", 404),
    rejection("MEME_INTERNAL_ERROR", 500),
  ]) {
    localStorage.clear();
    const fetch = vi.fn().mockImplementationOnce(async () => {
      if (failure instanceof Error) throw failure;
      return failure;
    });
    vi.stubGlobal("fetch", fetch);
    await expect(memeApi.executeMainAccountTrade(input)).rejects.toThrow();
    expect(pendingExecutionId(wallet)).toBe(input.clientExecutionId);
    fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          rc: 0,
          result: { executionId: input.clientExecutionId, status: "SUBMISSION_UNKNOWN" },
        }),
      ),
    );
    await expect(
      memeApi.executeMainAccountTrade({ ...input, clientExecutionId: "attempt-2" }),
    ).resolves.toMatchObject({ status: "SUBMISSION_UNKNOWN" });
    expect(fetch.mock.calls).toHaveLength(2);
    expect(fetch.mock.calls[1]![1].method).toBeUndefined();
  }
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            rc: 0,
            result: {
              record: { executionId: input.clientExecutionId, status: "PENDING" },
              authorizationRequest: {},
            },
          }),
        ),
      )
      .mockResolvedValueOnce(rejection("MEME_UNAUTHORIZED", 401)),
  );
  await expect(memeApi.executeMainAccountTrade(input)).rejects.toThrow();
  expect(pendingExecutionId(wallet)).toBe(input.clientExecutionId);
});

it("server pre-create classification clears new definitive errors without extending a code list", async () => {
  configureServerSignedTransactions(true);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          rc: 409,
          mc: "MEME_PRIVY_DELEGATE_UNSUPPORTED",
          result: { executionStage: "NOT_CREATED" },
        }),
        { status: 409 },
      ),
    ),
  );
  await expect(memeApi.executeMainAccountTrade(input)).rejects.toThrow();
  expect(pendingExecutionId(wallet)).toBeNull();
});
