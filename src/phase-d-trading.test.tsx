import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import TradingPanel from "./TradingPanel";
import Portfolio from "./Portfolio";
import { ApiError, configureServerSignedTransactions, memeApi, setSessionToken } from "./api";
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
  fundingModel: "SHARED_TREASURY",
  treasury: {
    address: `0x${"9".repeat(40)}`,
    balances: [{ asset: "USDG", available: "1000", frozen: "0" }],
  },
  quoteBalances: [{ asset: "USDG", available: "0", frozen: "0" }],
  walletAssets: {
    address: wallet,
    balances: [{ asset: "USDG", available: "0", frozen: "0" }],
  },
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
  it("bounds quote display without changing exact estimate terms", async () => {
    const exact = {
      ...terms,
      amountIn: "10",
      targetOut: "6727.535235270868079007",
      expectedAmountOut: "6727.535235270868079007",
      minOut: "6054.196429241525011357",
      minAmountOut: "6054.196429241525011357",
    };
    const create = vi.spyOn(memeApi, "createQuote").mockResolvedValue(exact);
    const execute = vi.spyOn(memeApi, "executeMainAccountTrade");
    render(
      <TradingPanel
        token={token}
        quickBuyAmounts={["10", "20"]}
        account={account}
        walletAddress={wallet}
        onAccountRefresh={vi.fn()}
      />,
    );
    expect(await screen.findByText("6,727.54 MEME")).toHaveAttribute(
      "title",
      `${exact.targetOut} MEME`,
    );
    expect(screen.getByText("6,054.2 MEME")).toHaveAttribute("title", `${exact.minOut} MEME`);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "ESTIMATE", amountIn: "10" }),
      expect.any(AbortSignal),
    );
    create.mockResolvedValue({ ...exact, amountIn: "20" });
    fireEvent.click(screen.getByRole("button", { name: "20" }));
    expect(screen.getByLabelText("Trade amount")).toHaveValue("20");
    await waitFor(() =>
      expect(create).toHaveBeenLastCalledWith(
        expect.objectContaining({ purpose: "ESTIMATE", amountIn: "20" }),
        expect.any(AbortSignal),
      ),
    );
    expect(exact.minOut).toBe("6054.196429241525011357");
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses the embedded amount control and amount-based CTA without preparing", async () => {
    const create = vi
      .spyOn(memeApi, "createQuote")
      .mockResolvedValue({ ...terms, amountIn: "1000" });
    const execute = vi.spyOn(memeApi, "executeMainAccountTrade");
    render(
      <TradingPanel
        token={token}
        quickBuyAmounts={["10"]}
        account={account}
        walletAddress={wallet}
        onAccountRefresh={vi.fn()}
      />,
    );
    const input = screen.getByLabelText("Trade amount");
    expect(input).toHaveValue("10");
    expect(screen.getByRole("button", { name: "Max" })).toBeVisible();
    expect(screen.getByText("USDG", { selector: ".trade-amount-unit" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Max" }));
    expect(input).toHaveValue("1000");
    expect(await screen.findByRole("button", { name: "Buy 1000 USDG" })).toBeInTheDocument();
    await waitFor(() =>
      expect(create).toHaveBeenLastCalledWith(
        expect.objectContaining({ purpose: "ESTIMATE", amountIn: "1000" }),
        expect.any(AbortSignal),
      ),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("quotes unknown public support using treasury funds, blocks explicit unsupported pools, and keeps missing funds unknown", async () => {
    const createQuote = vi
      .spyOn(memeApi, "createQuote")
      .mockResolvedValue({ ...terms, amountIn: "1" });
    const props = {
      token: { ...token, tradeStatus: undefined },
      walletAddress: wallet,
      onAccountRefresh: vi.fn(),
    };
    const funded = {
      ...account,
      treasury: {
        ...account.treasury!,
        balances: [{ asset: "USDG" as const, available: "2.661567", frozen: "0" }],
      },
    };
    const { rerender } = render(<TradingPanel {...props} account={funded} />);
    fireEvent.change(screen.getByLabelText("Trade amount"), { target: { value: "1" } });
    expect(screen.getByText("2.661567 USDG", { selector: ".trade-balance-value" })).toBeVisible();
    await waitFor(() => expect(createQuote).toHaveBeenCalledTimes(1));
    expect(createQuote).toHaveBeenCalledWith(
      expect.objectContaining({ amountIn: "1", purpose: "ESTIMATE" }),
      expect.any(AbortSignal),
    );
    rerender(
      <TradingPanel
        {...props}
        token={{ ...token, tradeStatus: "UNSUPPORTED_POOL_TYPE" }}
        account={funded}
      />,
    );
    expect(screen.getByText("Trading is unavailable for this token")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh quote" })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(createQuote).toHaveBeenCalledTimes(1);
    const userFunded: AccountSummary = {
      ...account,
      quoteBalances: [{ asset: "USDG", available: "1000", frozen: "0" }],
      walletAssets: {
        address: wallet,
        balances: [{ asset: "USDG", available: "1000", frozen: "0" }],
      },
      treasury: {
        ...account.treasury!,
        balances: [{ asset: "USDG", available: "0.5", frozen: "0" }],
      },
    };
    rerender(<TradingPanel {...props} account={userFunded} />);
    expect(screen.getByText("Insufficient Balance")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh quote" })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(createQuote).toHaveBeenCalledTimes(1);
    rerender(<TradingPanel {...props} account={{ ...userFunded, treasury: undefined }} />);
    expect(screen.getByText("— USDG", { selector: ".trade-balance-value" })).toBeVisible();
    expect(screen.getByText("Loading balance")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh quote" })).toBeNull();
  });

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
      ).toThrow("Quote is missing");
      expect(() => requireQuoteTerms({ ...terms, expiresAt: 1 }, draft)).toThrow("expired");
      expect(() => requirePreparedQuote({ ...terms, feeConfigVersion: "2" }, prepared)).toThrow(
        "Fee configuration",
      );
      expect(() =>
        requirePreparedQuote({ ...terms, minOut: "79", minAmountOut: "79" }, prepared),
      ).toThrow("minimum received");
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
    // quick buy only fills the amount and requests an unsigned estimate
    await (async () => {
      const createQuote = vi.spyOn(memeApi, "createQuote").mockResolvedValue(terms);
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
      await waitFor(() => expect(createQuote).toHaveBeenCalled());
      expect(screen.getByLabelText("Trade amount")).toHaveValue("100");
      expect(createQuote.mock.calls.every(([input]) => input.purpose === "ESTIMATE")).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByText("Available", { selector: ".trade-balance-label" })).toBeVisible();
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
      await waitFor(() => expect(screen.getByText(/Buying is disabled/)).toBeInTheDocument());
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
      await waitFor(() =>
        expect(screen.getByText(/Wallet balance: 1.23 MEME/)).toBeInTheDocument(),
      );
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
      await waitFor(() => expect(screen.getByLabelText("Trade amount")).toHaveValue(""));
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
      await waitFor(() => expect(screen.getByText("Cost unknown")).toBeInTheDocument());
      fireEvent.click(screen.getByRole("tab", { name: "Order history" }));
      expect(screen.getByText("Receipt rejected")).toBeInTheDocument();
      expect(screen.queryByText("999 MEME")).toBeNull();
      expect(screen.getAllByText("Failed").length).toBeGreaterThan(0);
      fireEvent.click(screen.getByRole("button", { name: "Filled" }));
      expect(screen.queryByText("Receipt rejected")).toBeNull();
      expect(screen.getByText("No orders")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Failed" }));
      expect(screen.getByText("Receipt rejected")).toBeVisible();
      cleanup();
      vi.mocked(memeApi.getAccountTransactions).mockClear();
      render(
        <Portfolio walletAddress={wallet} tokenFilter={`0x${"3".repeat(40)}`} onSell={vi.fn()} />,
      );
      expect(await screen.findByText("No positions")).toBeVisible();
      expect(screen.queryByRole("tab", { name: "Order history" })).toBeNull();
      expect(memeApi.getAccountTransactions).not.toHaveBeenCalled();
    })();
  });
});

it("quote errors show short states, preserve codes in title and keep buying disabled", async () => {
  for (const [code, message, text] of [
    [
      "MEME_REFERENCE_UNAVAILABLE",
      "Live candle reference is unavailable",
      "Not enough liquidity to quote",
    ],
    [
      "MEME_LOCAL_STATE_UNAVAILABLE",
      "Local state unavailable",
      "Market data is syncing. Try again shortly",
    ],
    ["MEME_UNAUTHORIZED", "Unauthorized", "Connect wallet to continue"],
    ["OTHER_LOGIN", "Privy login required", "Connect wallet to continue"],
    ["UNKNOWN_ERROR", "Unexpected service failure", "Unexpected service failure"],
  ]) {
    vi.spyOn(memeApi, "createQuote").mockRejectedValue(new ApiError(code, message, 409));
    render(
      <TradingPanel
        token={token}
        walletAddress={wallet}
        account={account}
        onAccountRefresh={vi.fn()}
        quickBuyAmounts={["10"]}
      />,
    );
    const line = await screen.findByText(text);
    if (code !== "UNKNOWN_ERROR") {
      expect(line).toHaveClass("muted");
      expect(line).toHaveAttribute("title", code);
      expect(line).toHaveAttribute("role", "status");
    }
    expect(screen.queryByText(code)).toBeNull();
    expect(screen.getByRole("button", { name: "Buy 10 USDG" })).toBeDisabled();
    cleanup();
    vi.restoreAllMocks();
  }
});
