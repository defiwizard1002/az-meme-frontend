import { useEffect, useRef, useState } from "react";
import { ApiError } from "./api";
import { compactMoney, money, relativeTime, shortAddress } from "./display";
import { walletApi } from "./wallet-api";
import { useUserState } from "./user-state";
import type { ActivityPage, ActivityQuery, WalletActivity } from "./wallet-types";

interface ActivityLinks {
  onWallet: (address: string) => void;
  onToken: (address: string) => void;
}
export interface ActivityFeedProps extends ActivityLinks {
  onTrade: (token: string, side: "BUY" | "SELL") => void;
  heldTokens: ReadonlySet<string>;
}
const dayMs = 86_400_000;
function feedError(cause: unknown): string {
  return cause instanceof ApiError && [404, 501].includes(cause.status)
    ? "动态服务暂不可用，请稍后重试。"
    : cause instanceof Error
      ? cause.message
      : "动态读取失败";
}
function mergeActivities(current: WalletActivity[], latest: WalletActivity[], fromMs: number) {
  return [...new Map([...current, ...latest].map((item) => [item.eventId, item])).values()]
    .filter((item) => item.timestampMs >= fromMs && (item.kind === "BUY" || item.kind === "SELL"))
    .sort((a, b) => b.timestampMs - a.timestampMs || b.eventId.localeCompare(a.eventId));
}

export function ActivityFeed(props: ActivityFeedProps) {
  const state = useUserState();
  const [scope, setScope] = useState<ActivityQuery["scope"]>("ALL");
  const [side, setSide] = useState<ActivityQuery["side"]>("ANY");
  const [minUsd, setMinUsd] = useState<ActivityQuery["minUsd"]>("ANY");
  return (
    <section className="panel activity-panel">
      <header className="toolbar">
        <h2>Smart Money 动态</h2>
        <span className="muted">最近 24 小时</span>
      </header>
      <div className="toolbar activity-filters">
        <div className="tabs activity-scope" aria-label="钱包分类">
          {(
            [
              ["ALL", "All"],
              ["FOLLOWING", "Following"],
              ["SMART_MONEY", "Smart Money"],
              ["KOL", "KOL"],
            ] as const
          ).map(([value, label]) => (
            <button key={value} aria-pressed={scope === value} onClick={() => setScope(value)}>
              {label}
            </button>
          ))}
        </div>
        <div className="activity-filter-row">
          <div className="tabs" aria-label="买卖方向">
            <span>Side</span>
            {(
              [
                ["ANY", "All"],
                ["BUY", "Buys"],
                ["SELL", "Sells"],
              ] as const
            ).map(([value, label]) => (
              <button key={value} aria-pressed={side === value} onClick={() => setSide(value)}>
                {label}
              </button>
            ))}
          </div>
          <div className="tabs" aria-label="成交金额">
            <span>Amount</span>
            {(
              [
                ["ANY", "All"],
                ["500", "≥ $500"],
                ["2000", "≥ $2K"],
              ] as const
            ).map(([value, label]) => (
              <button key={value} aria-pressed={minUsd === value} onClick={() => setMinUsd(value)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {scope === "FOLLOWING" && !state.authenticated ? (
        <p className="empty-state">连接钱包后查看关注动态。</p>
      ) : (
        <FilteredFeed
          key={`${scope}:${side}:${minUsd}`}
          {...props}
          scope={scope}
          side={side}
          minUsd={minUsd}
        />
      )}
    </section>
  );
}
function FilteredFeed({
  scope,
  side,
  minUsd,
  onWallet,
  onToken,
  onTrade,
  heldTokens,
}: ActivityFeedProps & Pick<ActivityQuery, "scope" | "side" | "minUsd">) {
  const [items, setItems] = useState<WalletActivity[]>([]);
  const [cursor, setCursor] = useState<ActivityPage["nextCursor"]>(null);
  const [pending, setPending] = useState<ActivityPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [paging, setPaging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const request = useRef<AbortController | null>(null);
  const frozen = useRef({ hovered: false, pageScrolled: false, tableScrolled: false });
  const currentItems = useRef<WalletActivity[]>([]);
  const hasPaged = useRef(false);
  const fromMs = useRef(Date.now() - dayMs);
  const pendingPage = useRef<ActivityPage | null>(null);
  const table = useRef<HTMLDivElement>(null);

  function applyPending() {
    if (
      !pendingPage.current ||
      frozen.current.hovered ||
      frozen.current.pageScrolled ||
      frozen.current.tableScrolled
    )
      return;
    const page = pendingPage.current;
    currentItems.current = mergeActivities(currentItems.current, page.items, fromMs.current);
    setItems(currentItems.current);
    if (!hasPaged.current) setCursor(page.nextCursor);
    pendingPage.current = null;
    setPending(null);
  }
  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    let inFlight = false;
    async function refresh() {
      if (inFlight) return;
      inFlight = true;
      const since = Date.now() - dayMs;
      await walletApi
        .feed({ scope, side, minUsd, fromMs: since }, controller.signal)
        .then((page) => {
          if (controller.signal.aborted) return;
          fromMs.current = since;
          setError(null);
          if (
            currentItems.current.length &&
            (frozen.current.hovered || frozen.current.pageScrolled || frozen.current.tableScrolled)
          ) {
            pendingPage.current = page;
            setPending(page);
          } else {
            currentItems.current = mergeActivities(currentItems.current, page.items, since);
            setItems(currentItems.current);
            if (!hasPaged.current) setCursor(page.nextCursor);
          }
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) setError(feedError(cause));
        })
        .finally(() => {
          inFlight = false;
          if (!controller.signal.aborted) setLoading(false);
        });
    }
    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, 30_000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [scope, side, minUsd, revision]);
  useEffect(() => {
    function scroll() {
      frozen.current.pageScrolled = window.scrollY > 80;
      applyPending();
    }
    window.addEventListener("scroll", scroll, { passive: true });
    return () => window.removeEventListener("scroll", scroll);
  }, []);
  function more() {
    if (!cursor || paging) return;
    const signal = request.current!.signal;
    setPaging(true);
    setError(null);
    void walletApi
      .feed({ scope, side, minUsd, fromMs: fromMs.current, before: cursor }, signal)
      .then((page) => {
        if (signal.aborted) return;
        hasPaged.current = true;
        currentItems.current = mergeActivities(currentItems.current, page.items, fromMs.current);
        setItems(currentItems.current);
        setCursor(page.nextCursor);
      })
      .catch((cause: unknown) => {
        if (!signal.aborted) setError(feedError(cause));
      })
      .finally(() => {
        if (!signal.aborted) setPaging(false);
      });
  }
  const incoming =
    pending?.items.filter((item) => !items.some((old) => old.eventId === item.eventId)).length ?? 0;
  return (
    <>
      {loading && <p role="status">正在读取动态…</p>}
      {error && (
        <p role="alert">
          {error}{" "}
          <button type="button" onClick={() => setRevision((value) => value + 1)}>
            重试动态
          </button>
        </p>
      )}
      {pending && (
        <button
          type="button"
          className="updates-banner"
          onClick={() => {
            table.current?.scrollTo?.({ top: 0 });
            window.scrollTo?.({ top: 0 });
            frozen.current = { hovered: false, pageScrolled: false, tableScrolled: false };
            applyPending();
          }}
        >
          {incoming ? `${incoming} 条新动态` : "动态已更新"}，返回顶部查看
        </button>
      )}
      <div
        className="table-scroll activity-scroll"
        ref={table}
        onScroll={(event) => {
          frozen.current.tableScrolled = event.currentTarget.scrollTop > 8;
          applyPending();
        }}
      >
        <table className="data-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>钱包</th>
              <th>方向</th>
              <th>代币</th>
              <th>金额 (U)</th>
              <th>交易时市值 (U)</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.eventId}>
                <td title={new Date(item.timestampMs).toLocaleString()}>
                  {relativeTime(item.timestampMs)}
                </td>
                <td>
                  <button
                    type="button"
                    className="text-button"
                    title={item.address}
                    onClick={() => onWallet(item.address)}
                  >
                    {shortAddress(item.address)}
                  </button>
                  {item.labels?.map((label) => (
                    <span className="badge" key={label}>
                      {label === "SMART_MONEY" ? "Smart" : "KOL"}
                    </span>
                  ))}
                </td>
                <td className={item.kind === "BUY" ? "positive" : "negative"}>
                  {item.kind === "BUY" ? "买入" : "卖出"}
                </td>
                <td>
                  <button
                    type="button"
                    className="text-button"
                    title={item.token}
                    onClick={() => onToken(item.token)}
                  >
                    {shortAddress(item.token)}
                  </button>
                </td>
                <td>{compactMoney(item.amountUsd)}</td>
                <td>{compactMoney(item.marketCapUsd)}</td>
                <td
                  onMouseEnter={() => {
                    frozen.current.hovered = true;
                  }}
                  onMouseLeave={() => {
                    frozen.current.hovered = false;
                    applyPending();
                  }}
                  onFocus={() => {
                    frozen.current.hovered = true;
                  }}
                  onBlur={() => {
                    frozen.current.hovered = false;
                    applyPending();
                  }}
                >
                  <button
                    type="button"
                    disabled={item.kind === "SELL" && !heldTokens.has(item.token.toLowerCase())}
                    title={
                      item.kind === "SELL" && !heldTokens.has(item.token.toLowerCase())
                        ? "仅可卖出已确认持有的代币"
                        : undefined
                    }
                    onClick={() => onTrade(item.token, item.kind === "SELL" ? "SELL" : "BUY")}
                  >
                    {item.kind === "SELL" ? "卖出" : "买入"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && !error && !items.length && (
        <p className="empty-state">最近 24 小时没有符合这些条件的活动</p>
      )}
      {cursor && (
        <button type="button" disabled={paging} onClick={more}>
          {paging ? "读取中…" : "加载更多动态"}
        </button>
      )}
    </>
  );
}

export function ActivityRibbon({
  onWallet,
  onToken,
  onSmartMoney,
}: ActivityLinks & { onSmartMoney?: () => void }) {
  const [items, setItems] = useState<WalletActivity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const hover = useRef(false);
  const queued = useRef<WalletActivity[] | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    function refresh() {
      if (inFlight) return;
      inFlight = true;
      void walletApi
        .feed(
          { scope: "ALL", side: "ANY", minUsd: "ANY", fromMs: Date.now() - dayMs, limit: 10 },
          controller.signal,
        )
        .then((page) => {
          if (controller.signal.aborted) return;
          const latest = mergeActivities([], page.items, Date.now() - dayMs).slice(0, 10);
          if (hover.current) queued.current = latest;
          else setItems(latest);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) setError(feedError(cause));
        })
        .finally(() => {
          inFlight = false;
          if (!controller.signal.aborted) setLoading(false);
        });
    }
    refresh();
    const interval = window.setInterval(refresh, 30_000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, []);
  useEffect(() => {
    const rotation = window.setInterval(() => {
      if (!hover.current)
        setItems((current) => (current.length > 1 ? [...current.slice(1), current[0]] : current));
    }, 6000);
    return () => window.clearInterval(rotation);
  }, []);
  return (
    <section
      className="activity-ribbon"
      aria-label="最新 10 条动态"
      onMouseEnter={() => {
        hover.current = true;
      }}
      onMouseLeave={() => {
        hover.current = false;
        if (queued.current) {
          setItems(queued.current);
          queued.current = null;
        }
      }}
    >
      <strong className="live-label">● Live</strong>
      <div className="ticker-track">
        {loading && <span className="muted">正在读取…</span>}
        {error && <span className="muted">{error}</span>}
        {!loading && !error && !items.length && <span className="muted">暂无最近动态</span>}
        {items.map((item) => (
          <span className="activity-ribbon-item" key={item.eventId}>
            <button
              type="button"
              className="text-button"
              title={item.address}
              onClick={() => onWallet(item.address)}
            >
              {shortAddress(item.address)}
            </button>
            <span className={item.kind === "BUY" ? "positive" : "negative"}>
              {item.kind === "BUY" ? "bought" : "sold"}
            </span>
            <button
              type="button"
              className="text-button"
              title={item.token}
              onClick={() => onToken(item.token)}
            >
              {shortAddress(item.token)}
            </button>
            <span>{item.amountUsd == null ? "金额未知" : money(item.amountUsd)}</span>
          </span>
        ))}
      </div>
      <button type="button" className="text-button ticker-link" onClick={onSmartMoney}>
        Smart money ›
      </button>
    </section>
  );
}
