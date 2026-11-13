import { useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";
import { memeApi } from "./api";
import { amount, price, compactMoney, money, safeUrl, shortAddress } from "./display";
import { forgetExecution, pendingExecutionId } from "./transaction-tracker";
import { walletApi } from "./wallet-api";
import type { WalletPosition } from "./wallet-types";
import type { AccountTransaction } from "./types";

export interface PortfolioProps {
  walletAddress?: string;
  explorerBaseUrl?: string;
  onSell: (tokenAddress: string) => void;
  onToken?: (tokenAddress: string) => void;
  refreshKey?: number;
  tokenFilter?: string;
}

export function Portfolio(props: PortfolioProps) {
  if (!props.walletAddress)
    return (
      <section className="panel empty">
        <h2>Positions & Orders</h2>
        <p>Connect wallet to view your positions and orders.</p>
      </section>
    );
  return (
    <PortfolioAccount
      key={props.walletAddress.toLowerCase()}
      {...props}
      walletAddress={props.walletAddress}
    />
  );
}

function PortfolioAccount({
  walletAddress,
  explorerBaseUrl,
  onSell,
  onToken,
  refreshKey,
  tokenFilter,
}: PortfolioProps & { walletAddress: string }) {
  const [tab, setTab] = useState<"positions" | "orders">("positions");
  const [positions, setPositions] = useState<WalletPosition[] | null>(null);
  const [orderFilter, setOrderFilter] = useState<"ALL" | "CONFIRMED" | "FAILED">("ALL");
  const [orders, setOrders] = useState<AccountTransaction[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [positionError, setPositionError] = useState<string | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [paging, setPaging] = useState(false);
  const [shareText, setShareText] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    setPositionError(null);
    setOrderError(null);
    void walletApi
      .positions(walletAddress, undefined, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) {
          setPositions(page.items);
          setCursor(page.nextCursor);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setPositionError(cause instanceof Error ? cause.message : "Positions unavailable");
      });
    let timer: ReturnType<typeof setTimeout>;
    const loadOrders = () => {
      void memeApi
        .getAccountTransactions(controller.signal)
        .then((page) => {
          if (controller.signal.aborted) return;
          setOrders(page.items);
          setOrderError(null);
          const saved = pendingExecutionId(walletAddress);
          const resolved = page.items.find(
            (row) => row.executionId === saved && ["CONFIRMED", "FAILED"].includes(row.status),
          );
          if (resolved) forgetExecution(walletAddress, resolved.executionId);
          if (
            page.items.some(
              (row) => row.status === "PENDING" || row.status === "SUBMISSION_UNKNOWN",
            )
          )
            timer = setTimeout(loadOrders, 3000);
        })
        .catch((cause) => {
          if (controller.signal.aborted) return;
          setOrderError(cause instanceof Error ? cause.message : "Orders unavailable");
          timer = setTimeout(loadOrders, 5000);
        });
    };
    if (!tokenFilter) loadOrders();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [walletAddress, refreshKey, tokenFilter]);

  function loadMore() {
    if (!cursor || paging) return;
    const signal = controllerRef.current!.signal;
    setPaging(true);
    void walletApi
      .positions(walletAddress, cursor, signal)
      .then((page) => {
        if (signal.aborted) return;
        setPositions((previous) => [...(previous ?? []), ...page.items]);
        setCursor(page.nextCursor);
      })
      .catch((cause) => {
        if (!signal.aborted)
          setPositionError(cause instanceof Error ? cause.message : "Positions unavailable");
      })
      .finally(() => {
        if (!signal.aborted) setPaging(false);
      });
  }
  const visiblePositions = positions?.filter(
    (position) => !tokenFilter || position.token.toLowerCase() === tokenFilter.toLowerCase(),
  );
  const visibleOrders = orders?.filter(
    (order) => orderFilter === "ALL" || order.status === orderFilter,
  );
  const explorer = safeUrl(explorerBaseUrl)?.replace(/\/$/, "");
  return (
    <section className="panel portfolio">
      {!tokenFilter && (
        <div className="tabs" role="tablist" aria-label="Positions and orders">
          <button
            role="tab"
            aria-selected={tab === "positions"}
            onClick={() => setTab("positions")}
          >
            Positions
          </button>
          <button role="tab" aria-selected={tab === "orders"} onClick={() => setTab("orders")}>
            Order history
          </button>
        </div>
      )}
      {tab === "positions" ? (
        <>
          {positionError && <p role="alert">{positionError}</p>}
          {!positions && !positionError && <p role="status">Loading positions…</p>}
          {visiblePositions?.length === 0 && <p className="empty">No positions</p>}
          {visiblePositions && visiblePositions.length > 0 && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Token</th>
                    <th>Amount</th>
                    <th>Avg entry MC</th>
                    <th>Now MC</th>
                    <th>Value</th>
                    <th>PnL</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {visiblePositions.map((position) => {
                    const quantity =
                      position.quantityAtomic === null
                        ? null
                        : formatUnits(BigInt(position.quantityAtomic), position.decimals);
                    const owned =
                      position.quantityComplete &&
                      position.quantityAtomic !== null &&
                      BigInt(position.quantityAtomic) > 0n;
                    return (
                      <tr key={position.token}>
                        <td>
                          <button
                            className="portfolio-token"
                            title={position.token}
                            onClick={() => onToken?.(position.token)}
                          >
                            {safeUrl(position.logo) && (
                              <img
                                src={safeUrl(position.logo)}
                                alt=""
                                onError={(event) => {
                                  event.currentTarget.style.display = "none";
                                }}
                              />
                            )}
                            <span>
                              {position.symbol || position.name || shortAddress(position.token)}
                            </span>
                          </button>
                        </td>
                        <td title={quantity ?? "Amount unknown"}>
                          {amount(quantity)}
                          {!position.quantityComplete && <small>Partial amount</small>}
                        </td>
                        <td>{compactMoney(position.averageEntryMarketCapUsd)}</td>
                        <td>{compactMoney(position.currentMarketCapUsd)}</td>
                        <td>{money(position.valueUsd)}</td>
                        <td>
                          {money(position.unrealizedPnlUsd)}
                          {position.costUsd === null && <small>Cost unknown</small>}
                          {position.realizedPnlUsd !== null && (
                            <small>Realized {money(position.realizedPnlUsd)}</small>
                          )}
                        </td>
                        <td>
                          <button
                            disabled={!owned}
                            onClick={() => onSell(position.token)}
                            className="portfolio-sell"
                          >
                            Sell
                          </button>
                          <button
                            className="portfolio-share"
                            onClick={() => {
                              setShareText(
                                `Token ${position.token}\nAmount: ${quantity ?? "unknown"}${position.quantityComplete ? "" : " (partial)"}\nValue: ${money(position.valueUsd)}\nUnrealized PnL: ${money(position.unrealizedPnlUsd)}\nUpdated: ${new Date(position.updatedAt).toLocaleString()}\n${window.location.origin}${window.location.pathname}#token/${position.token}`,
                              );
                            }}
                          >
                            Share
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {cursor && (
            <button onClick={loadMore} disabled={paging}>
              {paging ? "Loading…" : "Load more positions"}
            </button>
          )}
        </>
      ) : (
        <>
          <div className="tabs" aria-label="Order status">
            {(
              [
                ["ALL", "All"],
                ["CONFIRMED", "Filled"],
                ["FAILED", "Failed"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                aria-pressed={orderFilter === value}
                onClick={() => setOrderFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          {orderError && <p role="alert">{orderError}</p>}
          {!orders && !orderError && <p role="status">Loading orders…</p>}
          {visibleOrders?.length === 0 && <p className="empty">No orders</p>}
          {visibleOrders && visibleOrders.length > 0 && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Token</th>
                    <th>Side</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Fill MC</th>
                    <th>Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleOrders.map((order) => {
                    const status =
                      order.status === "CONFIRMED"
                        ? "Filled"
                        : order.status === "FAILED"
                          ? "Failed"
                          : "Processing";
                    return (
                      <tr key={order.executionId}>
                        <td>
                          <time>{new Date(order.createdAt).toLocaleString()}</time>
                        </td>
                        <td>
                          <button
                            className="text-button"
                            title={order.tokenAddress}
                            onClick={() => onToken?.(order.tokenAddress)}
                          >
                            {order.tokenSymbol || shortAddress(order.tokenAddress)}
                          </button>
                        </td>
                        <td>{order.side === "BUY" ? "Buy" : "Sell"}</td>
                        <td>
                          {price(order.settlement?.amountIn ?? order.amountIn)}{" "}
                          {order.side === "BUY" ? order.settlementAsset : order.tokenSymbol}
                          {order.status === "CONFIRMED" && order.settlement && (
                            <small>
                              Received {price(order.settlement.amountOut)}{" "}
                              {order.side === "BUY" ? order.tokenSymbol : order.settlementAsset}
                            </small>
                          )}
                          {order.settlement && (
                            <small>
                              Fee {price(order.settlement.fee.amount)} {order.settlement.fee.asset}
                            </small>
                          )}
                        </td>
                        <td>
                          <span
                            className={`badge ${status === "Failed" ? "danger" : status === "Filled" ? "positive" : "warning"}`}
                          >
                            {status}
                          </span>
                          {order.errorMessage && <small>{order.errorMessage}</small>}
                          {order.status === "SUBMISSION_UNKNOWN" && (
                            <small>Submission unconfirmed. Checking the same order.</small>
                          )}
                        </td>
                        <td>{money(order.settlement?.marketCapUsd)}</td>
                        <td>
                          {order.txHashes.map((hash) =>
                            explorer && /^0x[0-9a-f]{64}$/i.test(hash) ? (
                              <a
                                key={hash}
                                href={`${explorer}/tx/${hash}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {shortAddress(hash)}
                              </a>
                            ) : (
                              <code key={hash}>{hash}</code>
                            ),
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {shareText !== null && (
        <section className="share-card" aria-label="Position share">
          <h3>Share position</h3>
          <textarea aria-label="Position share text" readOnly value={shareText} rows={7} />
          <button
            onClick={() => {
              void navigator.clipboard
                ?.writeText(shareText)
                .then(() => setShareText(null))
                .catch(() => {});
            }}
          >
            Copy
          </button>
          <button onClick={() => setShareText(null)}>Close</button>
        </section>
      )}
    </section>
  );
}
export default Portfolio;
