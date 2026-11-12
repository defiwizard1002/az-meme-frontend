import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";
import { approvalDetails, memeApi, type ApprovalRequired } from "./api";
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
  onQuickRequestConsumed,
  onExecutionChange,
}: TradingPanelProps) {
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [amount, setAmount] = useState("10");
  const [quote, setQuote] = useState<ValidQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
            `交易结果尚未确认，将继续查询：${cause instanceof Error ? cause.message : String(cause)}`,
          );
      },
    });
    return () => controller.abort();
  }, [pendingId, walletAddress]);

  const invalidReason = useCallback(
    (tradeSide: "BUY" | "SELL", input: string): string | null => {
      if (!/^\d+(?:\.\d+)?$/.test(input) || compareAmounts(input, "0") <= 0)
        return "请输入大于 0 的金额";
      if (tradeSide === "BUY") {
        if (honeypot) return "已识别为 Honeypot，禁止买入";
        if (compareAmounts(input, "1") < 0 || compareAmounts(input, "9999999") > 0)
          return "买入金额须为 1–9,999,999 U";
        if (treasury === null) return "共享资金余额尚未加载，暂时无法买入";
        if (compareAmounts(input, treasury) > 0) return "共享资金余额不足";
      } else {
        if (ownBalance === null) return "当前钱包的代币余额未知，暂时无法卖出";
        if (compareAmounts(input, ownBalance) > 0) return "当前钱包代币余额不足";
      }
      if (token.tradeStatus === "UNSUPPORTED_POOL_TYPE") return "当前代币暂不支持交易";
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
          if (!controller.signal.aborted)
            setError(cause instanceof Error ? cause.message : String(cause));
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
      setError("授权已完成，请按当前金额重新交易");
    } catch (cause) {
      if (!active.current.signal.aborted)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busyRef.current = false;
      if (!active.current.signal.aborted) setBusy(false);
    }
  }

  const invalid = invalidReason(side, amount);
  const expired = quote !== null && quote.expiresAt <= now;
  const transactionState =
    transaction?.status === "CONFIRMED"
      ? "已成交"
      : transaction?.status === "FAILED"
        ? "失败"
        : "处理中";
  return (
    <section className="panel trading-panel" aria-label="交易">
      <div className="tabs" role="tablist" aria-label="交易方向">
        <button
          role="tab"
          aria-selected={side === "BUY"}
          onClick={() => {
            setSide("BUY");
            setApproval(null);
            setAmount("10");
            setError(null);
          }}
          disabled={busy}
        >
          买入
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
          卖出
        </button>
      </div>
      <p className="muted">
        平台共享资金：{treasury ?? "未知"} USDG。买入代币进入你的钱包，卖出所得返回平台。
      </p>
      {side === "SELL" && (
        <p>
          当前钱包余额：{ownBalance ?? "未知"} {symbol}
        </p>
      )}
      <label>
        金额（{side === "BUY" ? "USDG" : symbol}）
        <input
          aria-label="交易金额"
          inputMode="decimal"
          value={amount}
          disabled={busy || Boolean(pendingId)}
          onChange={(e) => {
            setAmount(e.target.value);
            setApproval(null);
            setError(null);
          }}
        />
      </label>
      {side === "SELL" && (
        <div className="presets">
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
      <p className="muted">平台额度无限制 · 自动滑点使用最新有效 K 线价格</p>
      {quote && (
        <dl className="quote-details">
          <dt>预计到账</dt>
          <dd>
            {quote.targetOut} {side === "BUY" ? symbol : "USDG"}
          </dd>
          <dt>最低到账</dt>
          <dd>
            {quote.minOut} {side === "BUY" ? symbol : "USDG"}
          </dd>
          <dt>滑点</dt>
          <dd>{(quote.slippageBps / 100).toFixed(2)}%</dd>
          <dt>平台费用</dt>
          <dd>
            {quote.fees.find((fee) => fee.type === "SERVICE")?.amount} USDG（
            {Number(quote.effectiveFeeBps) / 100}%）
          </dd>
          <dt>最佳路径</dt>
          <dd>
            {quote.routeHops?.map((hop) => hop.venue).join(" → ") ||
              quote.routePools?.map((pool) => pool.poolType).join(" → ") ||
              "准备时确认"}
          </dd>
          <dt>报价有效期</dt>
          <dd>
            {expired
              ? "已过期，提交时重新报价"
              : `${Math.max(0, Math.ceil((quote.expiresAt - now) / 1000))} 秒`}
          </dd>
        </dl>
      )}
      {quoting && <p role="status">获取报价中…</p>}
      {walletAddress && !busy && !pendingId && !invalid && (
        <button
          onClick={() => {
            setApproval(null);
            setQuoteRetry((value) => value + 1);
          }}
          disabled={quoting}
        >
          刷新报价
        </button>
      )}
      {(error || invalid) && <p role={error ? "alert" : "status"}>{error ?? invalid}</p>}
      {pendingId && (
        <p role="status">交易 {pendingId} 处理中，正在查询同一笔交易，请勿重复提交。</p>
      )}
      {transaction && (
        <p role="status">
          {transactionState}
          {transaction.settlement && transaction.status === "CONFIRMED"
            ? ` · 实际到账 ${transaction.settlement.amountOut}`
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
          连接钱包
        </button>
      ) : approval ? (
        <button
          className="primary"
          disabled={busy || approval.expiresAt <= Date.now()}
          onClick={() => {
            void approve();
          }}
        >
          授权 {symbol}
        </button>
      ) : (
        <button
          className="primary"
          disabled={busy || Boolean(pendingId) || Boolean(invalid) || !quote}
          onClick={() => {
            void submit(side, amount);
          }}
        >
          {busy ? "处理中…" : side === "BUY" ? `买入 ${symbol}` : `卖出 ${symbol}`}
        </button>
      )}
    </section>
  );
}
