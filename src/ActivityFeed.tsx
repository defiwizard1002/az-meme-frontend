import { useEffect, useRef, useState } from "react";
import { ApiError } from "./api";
import { DesignIcon } from "./DesignIcon";
import { compactMoney, money, relativeTime, safeUrl, shortAddress } from "./display";
import { walletApi } from "./wallet-api";
import { useUserState } from "./user-state";
import type { ActivityPage, ActivityQuery, WalletActivity } from "./wallet-types";

interface ActivityLinks {
  onWallet: (address: string) => void;
  onToken: (address: string) => void;
}
export interface ActivityFeedProps extends ActivityLinks {
  onTrade: (token: string, side: "BUY" | "SELL", amountIn?: string) => void;
  onQuickAmountChange?: (amount: string) => void;
  heldTokens: ReadonlySet<string>;
  explorerBaseUrl?: string;
}
const dayMs = 86_400_000;
function feedError(cause: unknown): string {
  return cause instanceof ApiError && [404, 501].includes(cause.status)
    ? "Activity unavailable. Try again shortly."
    : cause instanceof Error
      ? cause.message
      : "Activity request failed";
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
  const [count, setCount] = useState<{ loaded: number; complete: boolean } | null>(null);
  const [quickAmount, setQuickAmount] = useState(state.quickBuyAmounts[0] ?? "");
  const onQuickAmountChange = props.onQuickAmountChange;
  useEffect(() => {
    if (!state.quickBuyAmounts.includes(quickAmount))
      setQuickAmount(state.quickBuyAmounts[0] ?? "");
  }, [quickAmount, state.quickBuyAmounts]);
  useEffect(() => {
    onQuickAmountChange?.(quickAmount);
  }, [onQuickAmountChange, quickAmount]);
  return (
    <section className="panel activity-panel">
      <div className="toolbar activity-filters">
        <div className="activity-toolbar-top">
          <div className="tabs activity-scope" aria-label="Wallet category">
            {(
              [
                ["ALL", "All"],
                ["FOLLOWING", "Following"],
                ["SMART_MONEY", "Smart Money"],
                ["KOL", "KOL"],
              ] as const
            ).map(([value, label]) => (
              <button key={value} aria-pressed={scope === value} onClick={() => setScope(value)}>
                {value === "FOLLOWING" && <DesignIcon name="star" />}
                {label}
              </button>
            ))}
          </div>
          <div className="activity-quick">
            <label className="quick-presets">
              <DesignIcon name="bolt" />
              Quick buy{" "}
              <select
                disabled={!state.quickBuyAmounts.length}
                aria-label="Activity quick buy amount"
                value={quickAmount}
                onChange={(event) => setQuickAmount(event.target.value)}
              >
                {state.quickBuyAmounts.map((value) => (
                  <option key={value} value={value}>
                    {value} USDG
                  </option>
                ))}
              </select>
            </label>
            <span className="live-label">● Live</span>
          </div>
        </div>
        <div className="activity-filter-row">
          <div className="tabs" aria-label="Trade side">
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
          <div className="tabs" aria-label="Trade amount">
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
          <span className="activity-count">
            {count
              ? `${count.loaded}${count.complete ? "" : "+"} ${count.loaded === 1 ? "trade" : "trades"}`
              : ""}
          </span>
        </div>
      </div>
      {scope === "FOLLOWING" && !state.authenticated ? (
        <p className="empty-state">Connect wallet to view following activity.</p>
      ) : (
        <FilteredFeed
          key={`${scope}:${side}:${minUsd}`}
          {...props}
          scope={scope}
          side={side}
          minUsd={minUsd}
          quickAmount={quickAmount}
          onCount={setCount}
        />
      )}
    </section>
  );
}
function FilteredFeed({
  scope,
  side,
  minUsd,
  quickAmount,
  onCount,
  onWallet,
  onToken,
  onTrade,
  heldTokens,
  explorerBaseUrl,
}: ActivityFeedProps &
  Pick<ActivityQuery, "scope" | "side" | "minUsd"> & {
    quickAmount: string;
    onCount: (count: { loaded: number; complete: boolean } | null) => void;
  }) {
  const state = useUserState();
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

  useEffect(() => {
    onCount({ loaded: items.length, complete: cursor === null });
  }, [cursor, items.length, onCount]);

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
  const explorer = safeUrl(explorerBaseUrl)?.replace(/\/+$/, "");
  return (
    <>
      {loading && <p role="status">Loading activity…</p>}
      {error && (
        <p role="alert">
          {error}{" "}
          <button type="button" onClick={() => setRevision((value) => value + 1)}>
            Retry
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
          {incoming ? `${incoming} new ${incoming === 1 ? "trade" : "trades"}` : "Activity updated"}
          . Return to top to view.
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
        <div className="activity-list" aria-label="Trade activity">
          {items.map((item) => (
            <article className="activity-card" key={item.eventId}>
              <div className="activity-wallet">
                <span className="activity-avatar" aria-hidden="true">
                  {safeUrl(item.walletAvatarUrl) ? (
                    <img
                      src={safeUrl(item.walletAvatarUrl)!}
                      alt=""
                      onError={(event) => {
                        event.currentTarget.style.display = "none";
                      }}
                    />
                  ) : (
                    (item.walletName || item.address.slice(2, 3)).slice(0, 1).toUpperCase()
                  )}
                </span>
                <button
                  type="button"
                  className="text-button"
                  title={item.address}
                  onClick={() => onWallet(item.address)}
                >
                  {item.walletName || shortAddress(item.address)}
                </button>
                {item.labels?.map((label) => (
                  <span className="badge" key={label}>
                    {label === "SMART_MONEY" ? "Smart" : "KOL"}
                  </span>
                ))}
                <button
                  type="button"
                  className="activity-follow-star"
                  aria-label={`${state.followed.has(item.address.toLowerCase()) ? "Unfollow" : "Follow"} ${item.walletName || shortAddress(item.address)}`}
                  aria-pressed={state.followed.has(item.address.toLowerCase())}
                  disabled={!state.authenticated}
                  title={
                    state.authenticated
                      ? state.followed.has(item.address.toLowerCase())
                        ? "Unfollow wallet"
                        : "Follow wallet"
                      : "Connect wallet to follow"
                  }
                  onClick={() =>
                    void state
                      .setFollow(item.address, !state.followed.has(item.address.toLowerCase()))
                      .catch((cause) =>
                        setError(cause instanceof Error ? cause.message : "Follow failed"),
                      )
                  }
                >
                  <DesignIcon name="star" filled={state.followed.has(item.address.toLowerCase())} />
                </button>
              </div>
              <div className="activity-event">
                <span className={item.kind === "BUY" ? "positive" : "negative"}>
                  {item.kind === "BUY" ? "Bought" : "Sold"}
                </span>
                <button
                  type="button"
                  className="activity-token"
                  title={item.tokenName || item.token}
                  onClick={() => onToken(item.token)}
                >
                  <span className="activity-token-logo" aria-hidden="true">
                    {safeUrl(item.tokenLogo) ? (
                      <img
                        src={safeUrl(item.tokenLogo)!}
                        alt=""
                        onError={(event) => {
                          event.currentTarget.style.display = "none";
                        }}
                      />
                    ) : (
                      (item.tokenSymbol || item.token.slice(2, 3)).slice(0, 1)
                    )}
                  </span>
                  <span>{item.tokenSymbol || shortAddress(item.token)}</span>
                </button>
                <span className="activity-value" title={item.amountUsd ?? undefined}>
                  {compactMoney(item.amountUsd)}
                </span>
                <span className="muted">@</span>
                <span className="activity-value" title={item.marketCapUsd ?? undefined}>
                  {compactMoney(item.marketCapUsd)} <span className="muted">MC</span>
                </span>
              </div>
              <time
                title={new Date(item.timestampMs).toLocaleString()}
                dateTime={new Date(item.timestampMs).toISOString()}
              >
                {relativeTime(item.timestampMs)}
              </time>
              <div
                className="activity-actions"
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
                {explorer && /^0x[0-9a-f]{64}$/i.test(item.txHash) ? (
                  <a
                    className="activity-view"
                    href={`${explorer}/tx/${item.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View
                  </a>
                ) : (
                  <span title="Transaction link unavailable">—</span>
                )}
                {(item.kind === "BUY" || heldTokens.has(item.token.toLowerCase())) && (
                  <button
                    type="button"
                    className={
                      item.kind === "SELL" ? "activity-follow-sell" : "activity-follow-buy"
                    }
                    onClick={() =>
                      item.kind === "SELL"
                        ? onTrade(item.token, "SELL")
                        : onTrade(item.token, "BUY", quickAmount)
                    }
                  >
                    {item.kind === "SELL" ? (
                      "Follow Sell"
                    ) : (
                      <>
                        <DesignIcon name="bolt" /> {quickAmount} USDG
                      </>
                    )}
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      </div>
      {!loading && !error && !items.length && (
        <p className="empty-state">No matching activity in the last 24 hours</p>
      )}
      {cursor && (
        <button type="button" disabled={paging} onClick={more}>
          {paging ? "Loading…" : "Load more activity"}
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
  return (
    <section
      className="activity-ribbon"
      aria-label="Latest 10 trades"
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
      <div className="ticker-window">
        {loading && <span className="muted">Loading…</span>}
        {error && <span className="muted">{error}</span>}
        {!loading && !error && !items.length && <span className="muted">No recent activity</span>}
        {!loading && !error && items.length > 0 && (
          <div className="ticker-track">
            {[0, 1].map((copy) => (
              <div
                className="ticker-group"
                key={copy}
                aria-hidden={copy === 1 ? true : undefined}
                inert={copy === 1}
              >
                {items.map((item) => (
                  <span className="activity-ribbon-item" key={item.eventId}>
                    <button
                      type="button"
                      className="text-button"
                      title={item.address}
                      onClick={() => onWallet(item.address)}
                    >
                      {item.walletName || shortAddress(item.address)}
                    </button>
                    <span className={item.kind === "BUY" ? "positive" : "negative"}>
                      {item.kind === "BUY" ? "bought" : "sold"}
                    </span>
                    <button
                      type="button"
                      className="text-button"
                      title={item.tokenName || item.token}
                      onClick={() => onToken(item.token)}
                    >
                      {item.tokenSymbol || shortAddress(item.token)}
                    </button>
                    <span>{item.amountUsd == null ? "Amount unknown" : money(item.amountUsd)}</span>
                  </span>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      <button type="button" className="text-button ticker-link" onClick={onSmartMoney}>
        Smart money ›
      </button>
    </section>
  );
}
