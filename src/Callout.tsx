import { useEffect, useState } from "react";
import { requestPublicMarket } from "./api";
import { percent } from "./display";

export interface CalloutItem {
  uid: string;
  tokenAddress: string;
  symbol: string | null;
  logo: string | null;
  platform: string;
  feeds: string[];
  launchpad: string | null;
  isSafe: string | null;
  author: {
    id: string | null;
    name: string | null;
    handle: string | null;
    avatar: string | null;
    wallet: string | null;
    followers: number | null;
  };
  content: { text: string | null; zhHans: string | null };
  holding: { usdValue: string | null; pnlPct: string | null };
  mcapAtCallout: string | null;
  priceAtCallout: string | null;
  isDeclaration: boolean;
  tweetId: string | null;
  createdAtMs: number;
  firstSeenAtMs: number;
}

interface CalloutResponse {
  items: CalloutItem[];
  available: boolean;
  stale: boolean;
  hasMore: boolean;
}

function compactMoney(value: string | null): string {
  if (value === null || !Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(Number(value));
}

export default function Views({
  tokenAddress,
  chainId,
}: {
  tokenAddress: string;
  chainId: number;
}) {
  const [holdersOnly, setHoldersOnly] = useState(false);
  const [page, setPage] = useState<CalloutResponse>();
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setPage(undefined);
    setError(undefined);
    void requestPublicMarket<CalloutResponse>(
      `/sapi/v1/meme/tokens/${tokenAddress}/callouts?chainId=${chainId}&holders=${holdersOnly ? 1 : 0}&limit=100`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted) setPage(result);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Views unavailable");
      });
    return () => controller.abort();
  }, [tokenAddress, chainId, holdersOnly, retry]);

  return (
    <div role="tabpanel" aria-label="Views" className="views-panel">
      <div className="views-filters" aria-label="View filters">
        <button aria-pressed={!holdersOnly} onClick={() => setHoldersOnly(false)}>
          All
        </button>
        <button aria-pressed={holdersOnly} onClick={() => setHoldersOnly(true)}>
          Holders only
        </button>
      </div>
      {error ? (
        <p role="alert" className="notice">
          {error} <button onClick={() => setRetry((n) => n + 1)}>Retry</button>
        </p>
      ) : !page ? (
        <p className="empty-state" role="status">
          Loading views…
        </p>
      ) : !page.available ? (
        <p className="empty-state" role="status">
          Views unavailable
        </p>
      ) : (
        <>
          {page.stale && (
            <p className="notice" role="status">
              Views may be outdated · collection freshness unconfirmed
            </p>
          )}
          {!page.items.length && (
            <p className="empty-state">No {holdersOnly ? "holder " : ""}views in the last 7 days</p>
          )}
          <div className="views-list">
            {page.items.map((item) => {
              const author = item.author.name || item.author.handle || "Unknown author";
              const holding = item.holding.usdValue === null ? null : Number(item.holding.usdValue);
              return (
                <article className="view-card" key={item.uid}>
                  <div className="view-author">
                    <span className="view-avatar" aria-hidden="true">
                      {author.slice(0, 1)}
                      {item.author.avatar && (
                        <img
                          src={item.author.avatar}
                          alt=""
                          width={40}
                          height={40}
                          onError={(event) => {
                            event.currentTarget.style.display = "none";
                          }}
                        />
                      )}
                    </span>
                    <strong>{author}</strong>
                  </div>
                  <p className="view-body">{item.content.zhHans || item.content.text || "—"}</p>
                  <div className="view-metadata">
                    <span>
                      MC when posted <strong>{compactMoney(item.mcapAtCallout)}</strong>
                    </span>
                    <span
                      className={`view-holding${holding !== null && holding > 0 ? " positive" : ""}`}
                    >
                      {holding === null || !Number.isFinite(holding) ? (
                        "Holding unknown"
                      ) : holding === 0 ? (
                        "Not holding"
                      ) : holding > 0 ? (
                        <>
                          Hold {compactMoney(item.holding.usdValue)}
                          {item.holding.pnlPct !== null && (
                            <>
                              {" "}
                              <span
                                className={
                                  Number(item.holding.pnlPct) >= 0 ? "positive" : "negative"
                                }
                              >
                                {percent(Number(item.holding.pnlPct) * 100)}
                              </span>
                            </>
                          )}
                        </>
                      ) : (
                        "Holding unknown"
                      )}
                    </span>
                  </div>
                </article>
              );
            })}
          </div>
          {page.hasMore && (
            <p className="muted views-limit">Showing the latest 100 views from the last 7 days</p>
          )}
        </>
      )}
    </div>
  );
}
