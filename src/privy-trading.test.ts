import { afterEach, expect, it, vi } from "vitest";
import { configurePrivyTransport, memeApi, type SponsoredTransaction } from "./api";
import { sendSponsoredTransaction } from "./privy-wallet";
const user = `0x${"1".repeat(40)}`,
  router = `0x${"2".repeat(40)}`;
const hash = `0x${"a".repeat(64)}` as const;
const swap: SponsoredTransaction = { from: user, to: router, data: "0x1234", value: "0x0" };
afterEach(() => {
  configurePrivyTransport(null);
  vi.unstubAllGlobals();
});
it.each([421614, 4663])(
  "uses chain %s, selected embedded wallet, and sponsorship",
  async (chainId) => {
    const send = vi.fn(async () => ({ hash }));
    expect(await sendSponsoredTransaction(swap, user, chainId, send)).toBe(hash);
    expect(send).toHaveBeenCalledWith(
      { to: router, data: "0x1234", value: 0n, chainId },
      { sponsor: true, address: user },
    );
    await expect(
      sendSponsoredTransaction({ ...swap, from: router }, user, chainId, send),
    ).rejects.toThrow("不匹配");
    expect(send).toHaveBeenCalledTimes(1);
  },
);
it("sends approval then requotes with the same minimum, sends user swap and records actual hash", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const result = (value: unknown) =>
    new Response(JSON.stringify({ rc: 0, mc: "", ma: [], result: value }), { status: 200 });
  fetch
    .mockResolvedValueOnce(
      result({ record: null, transaction: null, approvals: [{ ...swap, to: user }] }),
    )
    .mockResolvedValueOnce(result({ status: "CONFIRMED" }))
    .mockResolvedValueOnce(result({ quoteId: "new-quote", routeFingerprint: "new-plan" }))
    .mockResolvedValueOnce(
      result({ record: { executionId: "saved" }, transaction: swap, approvals: [] }),
    )
    .mockResolvedValueOnce(result({ executionId: "saved", status: "PENDING", txHashes: [hash] }));
  const send = vi.fn(async () => hash);
  configurePrivyTransport({ getAccessToken: async () => "fresh-access-token", send });
  const t = await memeApi.executeMainAccountTrade({
    clientExecutionId: crypto.randomUUID(),
    side: "SELL",
    tokenAddress: user,
    settlementAsset: "USDG",
    quoteId: "old",
    amountIn: "5",
    minAmountOut: "4",
    routeFingerprint: "old-plan",
    slippageBps: 100,
  });
  expect(t.txHashes).toEqual([hash]);
  expect(send).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetch.mock.calls[2]![1].body).minAmountOut).toBe("4");
  expect(JSON.parse(fetch.mock.calls[3]![1].body).routeFingerprint).toBe("new-plan");
  expect(fetch.mock.calls.every((c) => !String(c[0]).endsWith("/account/transactions"))).toBe(true);
  expect((fetch.mock.calls[0]![1].headers as Headers).get("authorization")).toBe(
    "Bearer fresh-access-token",
  );
});
it("reports a known broadcast hash without automatically resending if recording fails", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  fetch
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          rc: 0,
          result: { record: { executionId: "saved" }, transaction: swap, approvals: [] },
        }),
      ),
    )
    .mockRejectedValueOnce(new Error("offline"));
  const send = vi.fn(async () => hash);
  configurePrivyTransport({ getAccessToken: async () => "token", send });
  await expect(
    memeApi.executeMainAccountTrade({
      clientExecutionId: crypto.randomUUID(),
      side: "BUY",
      tokenAddress: user,
      settlementAsset: "USDG",
      quoteId: "q",
      routeFingerprint: "p",
      amountIn: "1",
      minAmountOut: "1",
      slippageBps: 100,
    }),
  ).rejects.toThrow(hash);
  expect(send).toHaveBeenCalledTimes(1);
});
