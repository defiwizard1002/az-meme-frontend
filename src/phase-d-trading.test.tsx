import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import TradingPanel from "./TradingPanel";
import Portfolio from "./Portfolio";
import { configureServerSignedTransactions, memeApi, setSessionToken } from "./api";
import { preparationInput, requirePreparedQuote, requireQuoteTerms } from "./quote-flow";
import { forgetExecution, pendingExecutionId } from "./transaction-tracker";
import { walletApi } from "./wallet-api";
import type { WalletPosition } from "./wallet-types";
import type { AccountSummary, Quote, Token } from "./types";

const wallet = `0x${"1".repeat(40)}`;
const tokenAddress = `0x${"2".repeat(40)}`;
const draft = {
  side: "BUY" as const,
  tokenAddress,
  settlementAsset: "USDG" as const,
  amountIn: "100",
};
const terms = {
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
    interval: "1s",
    revision: "1",
    maxAgeMs: 60000,
  },
  feeConfigVersion: "1",
  fees: [{ type: "SERVICE", asset: "USDG", amount: "0", estimated: true }],
  expiresAt: Date.now() + 60_000,
  routeFingerprint: "route-1",
  routeAssets: [
    { address: wallet, symbol: "USDG", decimals: 18 },
    { address: tokenAddress, symbol: "MEME", decimals: 18 },
  ],
  routePools: [{ poolKey: "pool-1", poolType: "V2", liquidityUsd: "1000" }],
} satisfies Quote;
const token = {
  tokenAddress,
  symbol: "MEME",
  tradeStatus: "TRADABLE",
  security: { isHoneypot: false },
} as Token;
const account: AccountSummary = {
  quoteBalances: [{ asset: "USDG", available: "1000", frozen: "0" }],
  positions: [],
};

const prepareScenario1 = () => {
  vi.spyOn(walletApi, "positions").mockResolvedValue({ items: [], nextCursor: null });
};
beforeEach(prepareScenario1);

const cleanScenario2 = () => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  setSessionToken(null);
  configureServerSignedTransactions(false);
};
afterEach(cleanScenario2);

describe("phase D trading", () => {
  it("phase D trading: 4 related scenarios", async () => {
    // uses server net amounts and refuses absent terms, expiry or changed preparation
    await (async () => {
      expect(requireQuoteTerms(terms, draft).minOut).toBe("80");
      const prepared = preparationInput(draft, terms);
      expect(prepared).toMatchObject({
        minAmountOut: "80",
        slippageBps: 2000,
        feeConfigVersion: "1",
        estimateId: "quote-1",
      });
      expect(requirePreparedQuote(terms, prepared).minOut).toBe("80");
      expect(() =>
        requireQuoteTerms({ ...terms, idealOut: undefined } as unknown as Quote, draft),
      ).toThrow("报价缺少");
      expect(() => requireQuoteTerms({ ...terms, expiresAt: 1 }, draft)).toThrow("过期");
      expect(() => requirePreparedQuote({ ...terms, feeConfigVersion: "2" }, prepared)).toThrow(
        "费用配置",
      );
      expect(() =>
        requirePreparedQuote({ ...terms, minOut: "79", minAmountOut: "79" }, prepared),
      ).toThrow("最低到账");
    })();
    await cleanScenario2();
    await prepareScenario1();
    // resumes the same wallet execution after a timeout without submitting again or leaking across wallets
    await (async () => {
      configureServerSignedTransactions(true);
      setSessionToken("session");
      const executionId = "ac111111-1111-4111-a111-111111111111";
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              rc: 0,
              result: { record: { executionId, status: "PENDING" }, authorizationRequest: {} },
            }),
          ),
        )
        .mockRejectedValueOnce(new Error("offline"));
      vi.stubGlobal("fetch", fetch);
      await expect(
        memeApi.executeMainAccountTrade({
          ...draft,
          walletAddress: wallet,
          clientExecutionId: executionId,
          quoteId: terms.quoteId,
          routeFingerprint: terms.routeFingerprint,
          minAmountOut: "80",
          slippageBps: 2000,
          feeConfigVersion: "1",
        }),
      ).rejects.toThrow();
      expect(pendingExecutionId(wallet)).toBe(executionId);
      expect(pendingExecutionId(`0x${"3".repeat(40)}`)).toBeNull();
      fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ rc: 0, result: { executionId, status: "PENDING" } })),
      );
      await memeApi.executeMainAccountTrade({
        ...draft,
        walletAddress: wallet,
        clientExecutionId: "different",
        quoteId: terms.quoteId,
        minAmountOut: "80",
        slippageBps: 2000,
        feeConfigVersion: "1",
      });
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(fetch.mock.calls[2]![1].method).toBeUndefined();
      forgetExecution(wallet, executionId);
      fetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            rc: 1,
            mc: "MEME_FEE_CONFIG_CHANGED",
            ma: ["Fees changed"],
            result: null,
          }),
          { status: 409 },
        ),
      );
      await expect(
        memeApi.executeMainAccountTrade({
          ...draft,
          walletAddress: wallet,
          clientExecutionId: executionId,
          quoteId: terms.quoteId,
          routeFingerprint: terms.routeFingerprint,
          minAmountOut: "80",
          slippageBps: 2000,
          feeConfigVersion: "1",
        }),
      ).rejects.toThrow("Fees changed");
      expect(pendingExecutionId(wallet)).toBeNull();
      expect(JSON.parse(fetch.mock.calls[0]![1].body)).not.toHaveProperty("walletAddress");
      expect(JSON.parse(fetch.mock.calls[0]![1].body)).not.toHaveProperty("feeConfigVersion");
    })();
    await cleanScenario2();
    await prepareScenario1();
    // quick buy prepares and executes once using the server minimum, with no extra confirmation
    await (async () => {
      vi.spyOn(memeApi, "createQuote").mockResolvedValue(terms);
      const execute = vi.spyOn(memeApi, "executeMainAccountTrade").mockResolvedValue({
        executionId: "done",
        tokenSymbol: "MEME",
        ...draft,
        amountOut: "89",
        status: "CONFIRMED",
        txHashes: [],
        errorMessage: null,
        createdAt: 1,
        updatedAt: 1,
      });
      render(
        <TradingPanel
          token={token}
          account={account}
          walletAddress={wallet}
          onConnect={vi.fn()}
          onAccountRefresh={vi.fn()}
          quickRequest={{ id: "quick-1", side: "BUY", amountIn: "100" }}
        />,
      );
      await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ minAmountOut: "80", slippageBps: 2000, feeConfigVersion: "1" }),
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByText(/共享资金/)).toBeInTheDocument();
    })();
    await cleanScenario2();
    await prepareScenario1();
    // blocks honeypots and unspecified quick amounts, paginates own balances, and shows only actual order outcomes
    await (async () => {
      const createQuote = vi.spyOn(memeApi, "createQuote").mockResolvedValue(terms);
      render(
        <TradingPanel
          token={{ ...token, security: { ...token.security, isHoneypot: true } }}
          account={account}
          walletAddress={wallet}
          onConnect={vi.fn()}
          onAccountRefresh={vi.fn()}
          quickRequest={{ id: "blocked", side: "BUY", amountIn: "100" }}
        />,
      );
      await waitFor(() => expect(screen.getByText(/禁止买入/)).toBeInTheDocument());
      expect(createQuote).not.toHaveBeenCalled();
      cleanup();
      const position = {
        chainId: 4663,
        address: wallet,
        token: tokenAddress,
        decimals: 2,
        quantityAtomic: "123",
        quantityComplete: true,
        costUsd: null,
        realizedPnlUsd: null,
        updatedAt: 1,
      } as WalletPosition;
      vi.mocked(walletApi.positions)
        .mockResolvedValueOnce({ items: [], nextCursor: "first-page" })
        .mockResolvedValueOnce({ items: [position], nextCursor: null });
      render(
        <TradingPanel
          token={token}
          account={account}
          walletAddress={wallet}
          onConnect={vi.fn()}
          onAccountRefresh={vi.fn()}
          quickRequest={{ id: "sell", side: "SELL" }}
        />,
      );
      await waitFor(() => expect(screen.getByText(/当前钱包余额：1.23 MEME/)).toBeInTheDocument());
      expect(walletApi.positions).toHaveBeenCalledWith(
        wallet,
        "first-page",
        expect.any(AbortSignal),
      );
      expect(createQuote).not.toHaveBeenCalled();
      cleanup();
      render(
        <TradingPanel
          token={token}
          account={account}
          walletAddress={wallet}
          onConnect={vi.fn()}
          onAccountRefresh={vi.fn()}
          quickRequest={{ id: "no-preset", side: "BUY" }}
        />,
      );
      await waitFor(() => expect(screen.getByLabelText("交易金额")).toHaveValue(""));
      expect(createQuote).not.toHaveBeenCalled();
      cleanup();
      vi.mocked(walletApi.positions).mockResolvedValue({ items: [position], nextCursor: null });
      vi.spyOn(memeApi, "getAccountTransactions").mockResolvedValue({
        items: [
          {
            executionId: "failed",
            ...draft,
            tokenSymbol: "MEME",
            amountOut: "999",
            status: "FAILED",
            txHashes: [],
            errorMessage: "Receipt rejected",
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      });
      render(<Portfolio walletAddress={wallet} onSell={vi.fn()} />);
      await waitFor(() => expect(screen.getByText("成本未知")).toBeInTheDocument());
      fireEvent.click(screen.getByRole("tab", { name: "Orders" }));
      expect(screen.getByText("Receipt rejected")).toBeInTheDocument();
      expect(screen.queryByText("999 MEME")).toBeNull();
      expect(screen.getByText("失败")).toBeInTheDocument();
    })();
  });
});
