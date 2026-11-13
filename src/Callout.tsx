import { useCallback, useEffect, useState } from "react";
import { requestPublicMarket } from "./api";
import { money, percent } from "./display";

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
  nextCursor: number | null;
  stale: boolean;
  heartbeat: { lastItemAtMs: number | null; total: number | null } | null;
}

type Feed = "all" | "new" | "leaderboard" | "conviction";

const FEED_LABEL: Record<Feed, string> = {
  all: "全部",
  new: "最新",
  leaderboard: "KOL 榜",
  conviction: "高信念",
};

const PLATFORM_LABEL: Record<string, string> = {
  gmgn: "GMGN",
  fomo: "Fomo",
  pump: "Pump",
  twitter: "X",
};

function timeAgo(ms: number): string {
  if (!ms) return "—";
  const diff = Math.max(0, Date.now() - ms);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

const isEvmAddress = (address: string) => /^0x[0-9a-f]{40}$/i.test(address);

/**
 * 喊单（GMGN Callout Radar）列表。数据来自采集器写入的 meme_callout 表，
 * 页面每 15 秒刷新一次；接口返回 stale 时如实提示掉线，不假装实时。
 */
export default function Callout({ onToken }: { onToken: (address: string) => void }) {
  const [feed, setFeed] = useState<Feed>("all");
  const [items, setItems] = useState<CalloutItem[]>([]);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);

  const load = useCallback(
    async (signal: { cancelled: boolean }) => {
      try {
        const query = feed === "all" ? "" : `&feed=${feed}`;
        const page = await requestPublicMarket<CalloutResponse>(
          `/sapi/v1/meme/callouts?limit=60${query}`,
        );
        if (signal.cancelled) return;
        setItems(page.items);
        setStale(page.stale);
        setError(undefined);
      } catch (cause) {
        if (signal.cancelled) return;
        setError(cause instanceof Error ? cause.message : "喊单数据暂时不可用");
      } finally {
        if (!signal.cancelled) setLoading(false);
      }
    },
    [feed],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    setLoading(true);
    void load(signal);
    const timer = setInterval(() => void load(signal), 15_000);
    return () => {
      signal.cancelled = true;
      clearInterval(timer);
    };
  }, [load, revision]);

  return (
    <section className="panel callout-panel">
      <header className="toolbar">
        <div>
          <strong>Callout 喊单</strong>
          <span className="muted">
            来自 GMGN Callout Radar · 保留 7 天{stale ? " · 采集可能已掉线" : ""}
          </span>
        </div>
        <div className="tabs" role="tablist" aria-label="喊单榜单">
          {(Object.keys(FEED_LABEL) as Feed[]).map((key) => (
            <button
              key={key}
              role="tab"
              aria-pressed={feed === key}
              className={feed === key ? "active" : undefined}
              onClick={() => setFeed(key)}
            >
              {FEED_LABEL[key]}
            </button>
          ))}
          <button className="text-button" onClick={() => setRevision((n) => n + 1)}>
            刷新
          </button>
        </div>
      </header>
      {error && <p className="notice">{error}</p>}
      {loading && !items.length && <p className="empty-state">正在读取喊单…</p>}
      {!loading && !error && !items.length && <p className="empty-state">最近 7 天没有喊单</p>}
      {items.length > 0 && (
        <div className="table-scroll">
          <table className="data-table callout-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>作者</th>
                <th>代币</th>
                <th>喊单内容</th>
                <th>喊单时市值</th>
                <th>KOL 持仓</th>
                <th>来源</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const text = item.content.zhHans || item.content.text || "—";
                const author = item.author.name || item.author.handle || "未知作者";
                return (
                  <tr key={item.uid}>
                    <td title={new Date(item.createdAtMs).toLocaleString()}>
                      {timeAgo(item.createdAtMs)}
                    </td>
                    <td>
                      <div className="callout-author">
                        {item.author.avatar ? (
                          <img src={item.author.avatar} alt="" width={22} height={22} />
                        ) : (
                          <span className="avatar-fallback">{author.slice(0, 1)}</span>
                        )}
                        <div>
                          <strong>{author}</strong>
                          {item.author.handle && (
                            <a
                              className="muted"
                              href={`https://x.com/${item.author.handle}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              @{item.author.handle}
                            </a>
                          )}
                          {item.author.followers ? (
                            <span className="muted">
                              {item.author.followers >= 1000
                                ? `${(item.author.followers / 1000).toFixed(1)}k`
                                : item.author.followers}{" "}
                              关注
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="callout-token">
                        {item.logo && <img src={item.logo} alt="" width={20} height={20} />}
                        {isEvmAddress(item.tokenAddress) ? (
                          <button
                            className="token-link"
                            onClick={() => onToken(item.tokenAddress.toLowerCase())}
                          >
                            <strong>{item.symbol || "未知"}</strong>
                          </button>
                        ) : (
                          <strong>{item.symbol || "未知"}</strong>
                        )}
                      </div>
                      {item.isSafe === "risk" && <span className="badge">风险</span>}
                    </td>
                    <td className="callout-text">{text}</td>
                    <td>{money(item.mcapAtCallout)}</td>
                    <td>
                      {item.holding.usdValue ? (
                        <>
                          {money(item.holding.usdValue)}{" "}
                          {item.holding.pnlPct && (
                            <span
                              className={Number(item.holding.pnlPct) >= 0 ? "positive" : "negative"}
                            >
                              {percent(Number(item.holding.pnlPct) * 100)}
                            </span>
                          )}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      <span className="badge">
                        {PLATFORM_LABEL[item.platform] ?? item.platform}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
