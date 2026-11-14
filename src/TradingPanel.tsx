import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";
import { price, percent } from "./display";
import { ApiError, approvalDetails, memeApi, type ApprovalRequired } from "./api";
import {
  compareAmounts,
  preparationInput,
  requirePreparedQuote,
  type QuoteRequest,
  type ValidQuote,
} from "./quote-flow";
import {
  forgetExecution,
  pendingExecutionId,
  pollTransactionUntilTerminal,
} from "./transaction-tracker";
import { walletApi } from "./wallet-api";
import type { AccountSummary, AccountTransaction, Token } from "./types";

export interface QuickTradeRequest {
  id: string;
  side: "BUY" | "SELL";
  amountIn?: string;
}
export interface TradingPanelProps {
  token: Token;
  account: AccountSummary | null;
  walletAddress?: string;
  onConnect?: () => Promise<boolean>;
  onAccountRefresh: () => void;
  quickRequest?: QuickTradeRequest | null;
  quickBuyAmounts?: readonly string[];
  onQuickRequestConsumed?: (id: string) => void;
  onExecutionChange?: () => void;
}

export function TradingPanel(props: TradingPanelProps) {
  return (
    <TradingForm key={`${props.walletAddress ?? "guest"}:${props.token.tokenAddress}`} {...props} />
  );
}

export default TradingPanel;

function TradingForm({
  token,
  account,
  walletAddress,
  onConnect,
  onAccountRefresh,
  quickRequest,
  quickBuyAmounts = [],
  onQuickRequestConsumed,
  onExecutionChange,
}: TradingPanelProps) {
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [amount, setAmount] = useState(() => quickBuyAmounts[0] ?? "");
  const [quote, setQuote] = useState<ValidQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<string | Error | null>(null);
  const [approval, setApproval] = useState<ApprovalRequired | null>(null);
  const [ownBalance, setOwnBalance] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState(() =>
    walletAddress ? pendingExecutionId(walletAddress) : null,
  );
  const [transaction, setTransaction] = useState<AccountTransaction | null>(null);
  const [now, setNow] = useState(Date.now());
  const [quoteRetry, setQuoteRetry] = useState(0);
  const busyRef = useRef(false);
  const active = useRef(new AbortController());
  const lastQuick = useRef<string | null>(null);
  const callbacks = useRef({ onAccountRefresh, onExecutionChange });
  callbacks.current = { onAccountRefresh, onExecutionChange };
  const treasury =
    account?.fundingModel === "SHARED_TREASURY"
      ? (account.treasury?.balances.find((balance) => balance.asset === "USDG")?.available ?? null)
      : null;
  const honeypot = token.security?.isHoneypot === true;
  const symbol = token.symbol ?? token.tokenAddress.slice(0, 8);

  useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!walletAddress) return;
    const controller = new AbortController();
    void (async () => {
      let after: string | undefined;
      do {
        const page = await walletApi.positions(walletAddress, after, controller.signal);
        if (controller.signal.aborted) return;
        const position = page.items.find(
          (p) => p.token.toLowerCase() === token.tokenAddress.toLowerCase(),
        );
        if (position) {
          setOwnBalance(
            position.quantityComplete && position.quantityAtomic !== null
              ? formatUnits(BigInt(position.quantityAtomic), position.decimals)
              : null,
          );
          return;
        }
        after = page.nextCursor ?? undefined;
      } while (after);
      setOwnBalance(null);
    })().catch(() => {
      if (!controller.signal.aborted) setOwnBalance(null);
    });
    return () => controller.abort();
  }, [walletAddress, token.tokenAddress, account]);

  useEffect(() => {
    if (!pendingId || !walletAddress) return;
    const controller = new AbortController();
    void pollTransactionUntilTerminal(pendingId, {
      signal: controller.signal,
      loadTransaction: memeApi.getAccountTransaction,
      pollIntervalMs: 2000,
      onUpdate: (row) => {
        if (controller.signal.aborted) return;
        setTransaction(row);
        if (row.status === "CONFIRMED" || row.status === "FAILED") {
          forgetExecution(walletAddress, pendingId);
          setPendingId(null);
          callbacks.current.onAccountRefresh();
          callbacks.current.onExecutionChange?.();
        }
      },
      onTemporaryError: (cause) => {
        if (!controller.signal.aborted)
          setError(
            `Trade unconfirmed. Continuing to check: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
      },
    });
    return () => controller.abort();
  }, [pendingId, walletAddress]);

  const invalidReason = useCallback(
    (tradeSide: "BUY" | "SELL", input: string): string | null => {
      if (!/^\d+(?:\.\d+)?$/.test(input) || compareAmounts(input, "0") <= 0)
        return "Enter an amount greater than 0";
      if (tradeSide === "BUY") {
        if (honeypot) return "Honeypot detected. Buying is disabled";
        if (compareAmounts(input, "1") < 0 || compareAmounts(input, "9999999") > 0)
          return "Buy amount must be between 1 and 9,999,999 U";
        if (treasury === null) return "Loading balance";
        if (compareAmounts(input, treasury) > 0) return "Insufficient Balance";
      } else {
        if (ownBalance === null) return "Balance unknown";
        if (compareAmounts(input, ownBalance) > 0) return "Insufficient token balance";
      }
      if (token.tradeStatus === "UNSUPPORTED_POOL_TYPE")
        return "Trading is unavailable for this token";
      return null;
    },
    [honeypot, ownBalance, token.tradeStatus, treasury],
  );

  useEffect(() => {
    if (busy || approval) return;
    setQuote(null);
    if (!walletAddress || pendingId || invalidReason(side, amount)) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setQuoting(true);
      const draft: QuoteRequest = {
        side,
        tokenAddress: token.tokenAddress,
        settlementAsset: "USDG",
        amountIn: amount,
        purpose: "ESTIMATE",
      };
      void memeApi
        .createQuote(draft, controller.signal)
        .then((value) => {
          if (controller.signal.aborted) return;
          setQuote(value);
          setError(null);
        })
        .catch((cause) => {
          if (!controller.signal.aborted) setError(cause instanceof Error ? cause : String(cause));
        })
        .finally(() => {
          if (!controller.signal.aborted) setQuoting(false);
        });
    }, 350);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      setQuoting(false);
    };
  }, [
    side,
    amount,
    walletAddress,
    busy,
    approval,
    pendingId,
    token.tokenAddress,
    invalidReason,
    quoteRetry,
  ]);

  useEffect(() => {
    if (!quote) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [quote]);

  const submit = useCallback(
    async (tradeSide: "BUY" | "SELL", input: string) => {
      if (busyRef.current || !walletAddress || pendingExecutionId(walletAddress)) return;
      const invalid = invalidReason(tradeSide, input);
      if (invalid) {
        setError(invalid);
        return;
      }
      busyRef.current = true;
      setBusy(true);
      setError(null);
      setApproval(null);
      const signal = active.current.signal;
      const draft: QuoteRequest = {
        side: tradeSide,
        tokenAddress: token.tokenAddress,
        settlementAsset: "USDG",
        amountIn: input,
        purpose: "ESTIMATE",
      };
      try {
        const estimate =
          quote &&
          quote.side === tradeSide &&
          quote.amountIn === input &&
          quote.expiresAt > Date.now()
            ? quote
            : await memeApi.createQuote(draft, signal);
        signal.throwIfAborted();
        setQuote(estimate);
        const preparation = preparationInput(draft, estimate);
        const prepared = requirePreparedQuote(
          await memeApi.createQuote(preparation, signal),
          preparation,
        );
        signal.throwIfAborted();
        setQuote(prepared);
        const row = await memeApi.executeMainAccountTrade({
          walletAddress,
          clientExecutionId: crypto.randomUUID(),
          side: tradeSide,
          tokenAddress: token.tokenAddress,
          settlementAsset: "USDG",
          amountIn: input,
          quoteId: prepared.quoteId,
          routeFingerprint: prepared.routeFingerprint,
          minAmountOut: prepared.minOut,
          slippageBps: prepared.slippageBps,
          feeConfigVersion: prepared.feeConfigVersion,
        });
        if (signal.aborted) return;
        setTransaction(row);
        setPendingId(pendingExecutionId(walletAddress));
        callbacks.current.onAccountRefresh();
        callbacks.current.onExecutionChange?.();
      } catch (cause) {
        if (signal.aborted) return;
        setApproval(approvalDetails(cause));
        setError(cause instanceof Error ? cause.message : String(cause));
        setPendingId(pendingExecutionId(walletAddress));
      } finally {
        busyRef.current = false;
        if (!signal.aborted) setBusy(false);
      }
    },
    [invalidReason, quote, token.tokenAddress, walletAddress],
  );

  useEffect(() => {
    if (!quickRequest || lastQuick.current === quickRequest.id) return;
    lastQuick.current = quickRequest.id;
    setSide(quickRequest.side);
    setApproval(null);
    setAmount(quickRequest.amountIn ?? "");
    onQuickRequestConsumed?.(quickRequest.id);
  }, [quickRequest, onQuickRequestConsumed]);

  async function approve() {
    if (!approval || busyRef.current || approval.expiresAt <= Date.now()) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await memeApi.approveTrade(approval.prerequisiteId);
      if (active.current.signal.aborted) return;
      setApproval(null);
      setQuote(null);
      setError("Approval complete. Review the amount and trade again");
    } catch (cause) {
      if (!active.current.signal.aborted)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busyRef.current = false;
      if (!active.current.signal.aborted) setBusy(false);
    }
  }

  const errorMessage = error instanceof Error ? error.message : error;
  const errorCode = error instanceof ApiError ? error.code : undefined;
  const quoteStatus =
    (
      {
        MEME_REFERENCE_UNAVAILABLE: "Not enough liquidity to quote",
        MEME_LOCAL_STATE_UNAVAILABLE: "Market data is syncing. Try again shortly",
        MEME_UNAUTHORIZED: "Connect wallet to continue",
      } as Record<string, string>
    )[errorCode ?? ""] ??
    (/Privy login required/i.test(errorMessage ?? "") ? "Connect wallet to continue" : undefined);
  const invalid = invalidReason(side, amount);
  const expired = quote !== null && quote.expiresAt <= now;
  const amountUnit = side === "BUY" ? "USDG" : symbol;
  const maxAmount = side === "BUY" ? treasury : ownBalance;
  const canUseMax =
    maxAmount !== null && /^\d+(?:\.\d+)?$/.test(maxAmount) && compareAmounts(maxAmount, "0") > 0;
  const actionLabel =
    side === "BUY" ? `Buy ${amount.trim() || "—"} USDG` : `Sell ${amount.trim() || "—"} ${symbol}`;
  const transactionState =
    transaction?.status === "CONFIRMED"
      ? "Filled"
      : transaction?.status === "FAILED"
        ? "Failed"
        : "Processing";
  return (
    <section className="panel trading-panel" aria-label="Trade">
      <div className="tabs" role="tablist" aria-label="Trade side">
        <button
          role="tab"
          aria-selected={side === "BUY"}
          onClick={() => {
            setSide("BUY");
            setApproval(null);
            setAmount(quickBuyAmounts[0] ?? "");
            setError(null);
          }}
          disabled={busy}
        >
          Buy
        </button>
        <button
          role="tab"
          aria-selected={side === "SELL"}
          onClick={() => {
            setSide("SELL");
            setApproval(null);
            setAmount("");
            setError(null);
          }}
          disabled={busy}
        >
          Sell
        </button>
      </div>
      <p className="trade-balance-row">
        <span className="trade-balance-label">Available</span>
        <span className="trade-balance-value">{treasury ?? "—"} USDG</span>
      </p>
      {side === "SELL" && (
        <p className="trade-wallet-balance">
          Wallet balance: {ownBalance ?? "—"} {symbol}
        </p>
      )}
      <div className="trade-amount-control">
        <input
          aria-label="Trade amount"
          inputMode="decimal"
          value={amount}
          disabled={busy || Boolean(pendingId)}
          onChange={(e) => {
            setAmount(e.target.value);
            setApproval(null);
            setError(null);
          }}
        />
        <button
          type="button"
          className="trade-max-button"
          disabled={!canUseMax || busy || Boolean(pendingId)}
          onClick={() => {
            if (maxAmount) {
              setAmount(maxAmount);
              setApproval(null);
              setError(null);
            }
          }}
        >
          Max
        </button>
        <span className="trade-amount-unit">{amountUnit}</span>
      </div>
      {side === "BUY" && quickBuyAmounts.length > 0 && (
        <div className="presets trade-presets" aria-label="Buy presets">
          {quickBuyAmounts.map((value) => (
            <button
              key={value}
              aria-pressed={value === amount}
              disabled={busy || Boolean(pendingId)}
              onClick={() => {
                setAmount(value);
                setApproval(null);
                setError(null);
              }}
            >
              {value}
            </button>
          ))}
        </div>
      )}
      {side === "SELL" && (
        <div className="presets trade-presets">
          {[25, 50, 100].map((pct) => (
            <button
              key={pct}
              disabled={!ownBalance || busy || Boolean(pendingId)}
              onClick={() => {
                const [whole, fraction = ""] = ownBalance!.split(".");
                const digits = (BigInt(whole + fraction) * BigInt(pct)) / 100n;
                setApproval(null);
                setAmount(formatUnits(digits, fraction.length));
              }}
            >
              {pct}%
            </button>
          ))}
        </div>
      )}
      {quote && (
        <dl className="quote-details">
          <div>
            <dt>Expected received</dt>
            <dd
              className="quote-amount"
              title={`${quote.targetOut} ${side === "BUY" ? symbol : "USDG"}`}
            >
              {price(quote.targetOut)} {side === "BUY" ? symbol : "USDG"}
            </dd>
          </div>
          <div>
            <dt>Minimum received</dt>
            <dd
              className="quote-amount"
              title={`${quote.minOut} ${side === "BUY" ? symbol : "USDG"}`}
            >
              {price(quote.minOut)} {side === "BUY" ? symbol : "USDG"}
            </dd>
          </div>
          <div>
            <dt>Slippage limit</dt>
            <dd>{(quote.slippageBps / 100).toFixed(2)}%</dd>
          </div>
          <div>
            <dt>Fee</dt>
            <dd>
              {price(quote.fees.find((fee) => fee.type === "SERVICE")?.amount)} USDG（
              {percent(Number(quote.effectiveFeeBps) / 100)}）
            </dd>
          </div>
          <div>
            <dt>Route</dt>
            <dd>
              {quote.routeHops?.map((hop) => hop.venue).join(" → ") ||
                quote.routePools?.map((pool) => pool.poolType).join(" → ") ||
                "Confirmed at prepare"}
            </dd>
          </div>
          <div>
            <dt>Quote expires</dt>
            <dd>
              {expired
                ? "Expired. Refreshes on submit"
                : `${Math.max(0, Math.ceil((quote.expiresAt - now) / 1000))}s`}
            </dd>
          </div>
        </dl>
      )}
      {quoting && (
        <p className="trade-status-line" role="status">
          Getting quote…
        </p>
      )}
      {walletAddress && !busy && !pendingId && !invalid && (
        <button
          type="button"
          className="trade-refresh-button"
          onClick={() => {
            setApproval(null);
            setQuoteRetry((value) => value + 1);
          }}
          disabled={quoting}
        >
          Refresh quote
        </button>
      )}
      {(error || (walletAddress && invalid)) && (
        <p
          role={quoteStatus ? "status" : error ? "alert" : "status"}
          className={quoteStatus ? "muted trade-status-line" : "trade-error"}
          title={quoteStatus ? (errorCode ?? errorMessage ?? undefined) : undefined}
        >
          {quoteStatus ?? errorMessage ?? invalid}
        </p>
      )}
      {pendingId && (
        <p className="trade-status-line" role="status">
          Trade {pendingId} is processing. Checking the same order; do not resubmit.
        </p>
      )}
      {transaction && (
        <p className="trade-status-line" role="status">
          {transactionState}
          {transaction.settlement && transaction.status === "CONFIRMED"
            ? ` · Received ${transaction.settlement.amountOut}`
            : ""}
          {transaction.errorMessage ? ` · ${transaction.errorMessage}` : ""}
        </p>
      )}
      {!walletAddress ? (
        <button
          className="primary"
          onClick={() => {
            void onConnect?.();
          }}
        >
          Connect wallet
        </button>
      ) : approval ? (
        <button
          className="primary"
          disabled={busy || approval.expiresAt <= Date.now()}
          onClick={() => {
            void approve();
          }}
        >
          Approve {symbol}
        </button>
      ) : (
        <button
          className="primary"
          disabled={busy || Boolean(pendingId) || Boolean(invalid) || !quote}
          onClick={() => {
            void submit(side, amount);
          }}
        >
          {busy ? "Processing…" : actionLabel}
        </button>
      )}
    </section>
  );
}
