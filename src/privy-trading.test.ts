import { afterEach, expect, it, vi } from "vitest";
import { configurePrivyTransport, memeApi } from "./api";
const input = {
  clientExecutionId: crypto.randomUUID(),
  side: "SELL" as const,
  tokenAddress: `0x${"1".repeat(40)}`,
  settlementAsset: "USDG" as const,
  quoteId: "quote",
  amountIn: "5",
  minAmountOut: "4",
  routeFingerprint: "plan",
  slippageBps: 100,
};
const signedRequest = {
  version: 1,
  method: "POST",
  url: "https://api.privy.io/v1/wallets/owned/rpc",
  headers: { "privy-app-id": "app", "privy-idempotency-key": input.clientExecutionId },
  body: {
    method: "wallet_sendCalls",
    chain_type: "ethereum",
    caip2: "eip155:4663",
    sponsor: true,
    params: {
      calls: [
        { to: input.tokenAddress, data: "0x1234", value: "0x0" },
        { to: input.tokenAddress, data: "0xabcd", value: "0x0" },
      ],
    },
  },
};
const result = (value: unknown) => new Response(JSON.stringify({ rc: 0, result: value }));
afterEach(() => {
  localStorage.clear();
  configurePrivyTransport(null);
  vi.unstubAllGlobals();
});
it.each(["BUY", "SELL"] as const)(
  "%s signs once and submits one fixed batch without approval sends or requotes",
  async (side) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        result({
          record: { executionId: input.clientExecutionId },
          authorizationRequest: signedRequest,
        }),
      )
      .mockResolvedValueOnce(
        result({ executionId: input.clientExecutionId, status: "PENDING", txHashes: [] }),
      );
    vi.stubGlobal("fetch", fetch);
    const sign = vi.fn(async () => "signed-request");
    configurePrivyTransport({
      accountId: input.tokenAddress,
      getAccessToken: async () => "token",
      sign,
    });
    await memeApi.executeMainAccountTrade({ ...input, side });
    expect(sign).toHaveBeenCalledExactlyOnceWith(signedRequest);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ ...input, side });
    expect(String(fetch.mock.calls[1]![0])).toMatch(/\/submit$/);
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ signature: "signed-request" });
  },
);
it("resumes a stored pending execution without signing or submitting again", async () => {
  const fetch = vi.fn().mockResolvedValue(
    result({
      record: { executionId: input.clientExecutionId, status: "PENDING" },
      authorizationRequest: null,
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const sign = vi.fn();
  configurePrivyTransport({
    accountId: input.tokenAddress,
    getAccessToken: async () => "token",
    sign,
  });
  expect((await memeApi.executeMainAccountTrade(input)).status).toBe("PENDING");
  expect(sign).not.toHaveBeenCalled();
});
it("uncertain submit reports original execution id without automatic resend", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      result({
        record: { executionId: input.clientExecutionId },
        authorizationRequest: signedRequest,
      }),
    )
    .mockRejectedValueOnce(Error("offline"));
  vi.stubGlobal("fetch", fetch);
  const sign = vi.fn(async () => "signed-request");
  configurePrivyTransport({
    accountId: input.tokenAddress,
    getAccessToken: async () => "token",
    sign,
  });
  await expect(memeApi.executeMainAccountTrade(input)).rejects.toThrow(input.clientExecutionId);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(sign).toHaveBeenCalledTimes(1);
});

it("reload or a new quote resumes the original wallet execution without another submit", async () => {
  localStorage.setItem(`az:privy-pending:${input.tokenAddress}`, "original-execution");
  const fetch = vi
    .fn()
    .mockResolvedValue(result({ executionId: "original-execution", status: "PENDING" }));
  vi.stubGlobal("fetch", fetch);
  const sign = vi.fn();
  configurePrivyTransport({
    accountId: input.tokenAddress,
    getAccessToken: async () => "token",
    sign,
  });
  expect(
    (await memeApi.executeMainAccountTrade({ ...input, quoteId: "new-quote" })).executionId,
  ).toBe("original-execution");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(sign).not.toHaveBeenCalled();
  expect(String(fetch.mock.calls[0]![0])).toMatch(/original-execution$/);
});
