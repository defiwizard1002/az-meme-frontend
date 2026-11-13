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
        <p>连接钱包后查看自己的持仓与订单。</p>
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
  const [revision, setRevision] = useState(0);
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
          setPositionError(cause instanceof Error ? cause.message : "持仓暂时不可用");
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
          setOrderError(cause instanceof Error ? cause.message : "订单暂时不可用");
          timer = setTimeout(loadOrders, 5000);
        });
    };
    if (!tokenFilter) loadOrders();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [walletAddress, refreshKey, revision, tokenFilter]);

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
          setPositionError(cause instanceof Error ? cause.message : "持仓暂时不可用");
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
      <header className="toolbar">
        <h2>我的资产与订单</h2>
        <button onClick={() => setRevision((value) => value + 1)}>刷新</button>
      </header>
      {!tokenFilter && (
        <div className="tabs" role="tablist" aria-label="资产与订单">
          <button
            role="tab"
            aria-selected={tab === "positions"}
            onClick={() => setTab("positions")}
          >
            Positions
          </button>
          <button role="tab" aria-selected={tab === "orders"} onClick={() => setTab("orders")}>
            Orders
          </button>
        </div>
      )}
      {tab === "positions" ? (
        <>
          {positionError && <p role="alert">{positionError}</p>}
          {!positions && !positionError && <p role="status">正在读取持仓…</p>}
          {visiblePositions?.length === 0 && <p className="empty">暂无持仓</p>}
          {visiblePositions && visiblePositions.length > 0 && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>代币</th>
                    <th>数量</th>
                    <th>平均入场市值</th>
                    <th>当前市值</th>
                    <th>价值</th>
                    <th>浮动盈亏</th>
                    <th>已实现盈亏</th>
                    <th>操作</th>
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
                            className="text-button"
                            title={position.token}
                            onClick={() => onToken?.(position.token)}
                          >
                            {shortAddress(position.token)}
                          </button>
                          <small>{new Date(position.updatedAt).toLocaleString()}</small>
                        </td>
                        <td title={quantity ?? "数量未知"}>
                          {amount(quantity)}
                          {!position.quantityComplete && <small>数量不完整</small>}
                        </td>
                        <td>{compactMoney(position.averageEntryMarketCapUsd)}</td>
                        <td>{compactMoney(position.currentMarketCapUsd)}</td>
                        <td>{money(position.valueUsd)}</td>
                        <td>
                          {money(position.unrealizedPnlUsd)}
                          {position.costUsd === null && <small>成本未知</small>}
                        </td>
                        <td>{money(position.realizedPnlUsd)}</td>
                        <td>
                          <button disabled={!owned} onClick={() => onSell(position.token)}>
                            卖出
                          </button>
                          <button
                            onClick={() => {
                              setShareText(
                                `代币 ${position.token}\n数量：${quantity ?? "未知"}${position.quantityComplete ? "" : "（不完整）"}\n当前价值：${money(position.valueUsd)}\n浮动盈亏：${money(position.unrealizedPnlUsd)}\n更新时间：${new Date(position.updatedAt).toLocaleString()}\n${window.location.origin}${window.location.pathname}#token/${position.token}`,
                              );
                            }}
                          >
                            分享
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
              {paging ? "正在读取…" : "更多持仓"}
            </button>
          )}
        </>
      ) : (
        <>
          <div className="tabs" aria-label="订单状态">
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
          {!orders && !orderError && <p role="status">正在读取订单…</p>}
          {visibleOrders?.length === 0 && <p className="empty">暂无订单</p>}
          {visibleOrders && visibleOrders.length > 0 && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>时间 / 代币</th>
                    <th>方向 / 状态</th>
                    <th>输入</th>
                    <th>实际到账</th>
                    <th>成交时市值</th>
                    <th>实际费用</th>
                    <th>结果 / 链上交易</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleOrders.map((order) => {
                    const status =
                      order.status === "CONFIRMED"
                        ? "已成交"
                        : order.status === "FAILED"
                          ? "失败"
                          : "处理中";
                    return (
                      <tr key={order.executionId}>
                        <td>
                          <time>{new Date(order.createdAt).toLocaleString()}</time>
                          <button
                            className="text-button"
                            title={order.tokenAddress}
                            onClick={() => onToken?.(order.tokenAddress)}
                          >
                            {order.tokenSymbol || shortAddress(order.tokenAddress)}
                          </button>
                        </td>
                        <td>
                          {order.side === "BUY" ? "买入" : "卖出"}
                          <span
                            className={`badge ${status === "失败" ? "danger" : status === "已成交" ? "positive" : "warning"}`}
                          >
                            {status}
                          </span>
                        </td>
                        <td>
                          {price(order.settlement?.amountIn ?? order.amountIn)}{" "}
                          {order.side === "BUY" ? order.settlementAsset : order.tokenSymbol}
                        </td>
                        <td>
                          {order.status === "CONFIRMED" && order.settlement
                            ? `${price(order.settlement.amountOut)} ${order.side === "BUY" ? order.tokenSymbol : order.settlementAsset}`
                            : "—"}
                        </td>
                        <td>{money(order.settlement?.marketCapUsd)}</td>
                        <td>
                          {order.settlement
                            ? `${price(order.settlement.fee.amount)} ${order.settlement.fee.asset}`
                            : "—"}
                        </td>
                        <td>
                          {order.errorMessage && <p>{order.errorMessage}</p>}
                          {order.status === "SUBMISSION_UNKNOWN" && (
                            <p>提交结果待确认，继续查询同一笔订单。</p>
                          )}
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
        <section className="share-card" aria-label="持仓分享">
          <h3>持仓分享</h3>
          <textarea aria-label="持仓分享内容" readOnly value={shareText} rows={7} />
          <button
            onClick={() => {
              void navigator.clipboard
                ?.writeText(shareText)
                .then(() => setShareText(null))
                .catch(() => {});
            }}
          >
            复制分享内容
          </button>
          <button onClick={() => setShareText(null)}>关闭</button>
        </section>
      )}
    </section>
  );
}
export default Portfolio;
