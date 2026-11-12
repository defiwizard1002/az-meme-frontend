import { mergeLiveToken } from "./discovery";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { request, requestPublicMarket, memeApi, wsBaseUrl } from "./api";
import { useUserState } from "./user-state";
import { age, amount, money, percent, shortAddress } from "./display";
import { lifecycleLabel, orderMarkets, reconcileMarkets, type MarketSort } from "./discovery";
import type { Token } from "./types";

export default function Discover({
  onToken,
  onQuickBuy,
  onConnect,
  pendingToken,
  compact = false,
}: {
  onToken: (token: Token) => void;
  onQuickBuy: (token: Token, amount: string) => void;
  onConnect: () => void;
  pendingToken?: string;
  compact?: boolean;
}) {
  const user = useUserState();
  const [tab, setTab] = useState<"hot" | "new" | "watchlist">("hot");
  const [period, setPeriod] = useState<"1h" | "24h">("1h");
  const [stage, setStage] = useState("ALL");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ field: MarketSort; direction: "asc" | "desc" }>({
    field: "volume1hUsd",
    direction: "desc",
  });
  const [items, setItems] = useState<Token[]>([]);
  const [visible, setVisible] = useState<Token[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const [retry, setRetry] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  const [hover, setHover] = useState(false);
  const [selectedAmount, setSelectedAmount] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const list = useRef<HTMLDivElement>(null);
  const frozen = scrolled || hover;
  const quickAmount =
    selectedAmount && user.quickBuyAmounts.includes(selectedAmount)
      ? selectedAmount
      : (user.quickBuyAmounts[0] ?? "");
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 120 || (list.current?.scrollTop ?? 0) > 0);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const watchKey = [...user.watchlist].sort().join(",");
  const feedKey = `${tab}:${period}:${search}:${watchKey}`;
  const previousFeed = useRef(feedKey);
  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    if (previousFeed.current !== feedKey) {
      setItems([]);
      setVisible([]);
      setScrolled(false);
      setHover(false);
      previousFeed.current = feedKey;
    }
    setError(undefined);
    setLoading(true);
    const refresh = async () => {
      if (running) return;
      if (tab === "watchlist" && (!user.authenticated || !watchKey)) {
        setLoading(false);
        return;
      }
      running = true;
      try {
        const params = new URLSearchParams({ tab, interval: period, limit: "100" });
        if (search) params.set("query", search);
        const page = await (tab === "watchlist" ? request : requestPublicMarket)<{
          items: Token[];
          stale: boolean;
          nextCursor: string | null;
        }>(`/sapi/v1/meme/markets?${params}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setItems(
          tab === "watchlist"
            ? page.items.filter((t) => user.watchlist.has(t.tokenAddress.toLowerCase()))
            : page.items,
        );
        setStale(page.stale);
        setError(undefined);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "列表暂时不可用");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
        running = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, 900_000);
    const resume = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    document.addEventListener("visibilitychange", resume);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", resume);
    };
    // A fresh set has the same semantics; only its stable contents change the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedKey, retry, user.authenticated]);

  useEffect(() => {
    if (typeof WebSocket === "undefined") return;
    let disposed = false,
      socket: WebSocket | null = null,
      timer: number | undefined;
    const connect = async () => {
      try {
        const ticket = await memeApi.getWsTicket(undefined, true);
        if (disposed) return;
        const url = new URL(wsBaseUrl);
        url.searchParams.set("ticket", ticket.ticket);
        socket = new WebSocket(url);
        socket.onopen = () =>
          socket?.send(JSON.stringify({ op: "subscribe", channels: ["markets:live"] }));
        socket.onmessage = (event) => {
          let message: { channel: string; data: { items?: Token[] } };
          try {
            message = JSON.parse(String(event.data));
          } catch {
            return;
          }
          if (message.channel !== "markets:live" || !Array.isArray(message.data?.items)) return;
          const incoming = new Map(
            message.data.items.map((t) => [t.tokenAddress.toLowerCase(), t]),
          );
          setItems((current) =>
            current.map((t) => {
              const updated = incoming.get(t.tokenAddress.toLowerCase());
              return updated ? mergeLiveToken(t, updated) : t;
            }),
          );
        };
        socket.onclose = () => {
          if (!disposed)
            timer = window.setTimeout(() => {
              setRetry((n) => n + 1);
              void connect();
            }, 3000);
        };
        socket.onerror = () => socket?.close();
      } catch {
        if (!disposed) timer = window.setTimeout(() => void connect(), 5000);
      }
    };
    void connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, []);
  const filtered = useMemo(
    () =>
      orderMarkets(
        items.filter((t) => stage === "ALL" || t.lifecycle?.state === stage),
        sort.field,
        sort.direction,
      ),
    [items, stage, sort],
  );
  useEffect(
    () => setVisible((current) => reconcileMarkets(current, filtered, frozen).items),
    [filtered, frozen],
  );
  const added = reconcileMarkets(visible, filtered, true).added;
  const column = (title: string, field: MarketSort) => (
    <button
      className="column-sort"
      onClick={() =>
        setSort((current) => ({
          field,
          direction: current.field === field && current.direction === "desc" ? "asc" : "desc",
        }))
      }
    >
      {title}
      {sort.field === field ? (sort.direction === "desc" ? " ↓" : " ↑") : ""}
    </button>
  );
  const changeTab = (value: typeof tab) => {
    setTab(value);
    setStage("ALL");
    setSort({
      field: value === "new" ? "ageSeconds" : period === "1h" ? "volume1hUsd" : "volume24hUsd",
      direction: value === "new" ? "asc" : "desc",
    });
  };
  const watch = useCallback(
    (token: Token) => {
      if (!user.authenticated) {
        onConnect();
        return;
      }
      setActionError(undefined);
      void user
        .setWatchlist(token.tokenAddress, !user.watchlist.has(token.tokenAddress.toLowerCase()))
        .catch((cause) => setActionError(cause instanceof Error ? cause.message : "自选保存失败"));
    },
    [user, onConnect],
  );
  if (compact)
    return (
      <aside className="market-rail" aria-label="交易页代币列表">
        <div className="tabs" aria-label="交易页发现列表">
          {(
            [
              ["hot", "Trending"],
              ["new", "New"],
              ["watchlist", "Watchlist"],
            ] as const
          ).map(([value, label]) => (
            <button key={value} aria-pressed={tab === value} onClick={() => changeTab(value)}>
              {label}
            </button>
          ))}
        </div>
        {loading && <p role="status">加载代币…</p>}
        {error && (
          <p role="alert">
            {error}
            <button onClick={() => setRetry((n) => n + 1)}>重试</button>
          </p>
        )}
        {!loading && !error && !visible.length && <p className="empty-state">暂无符合条件的代币</p>}
        {visible.map((token) => (
          <button
            className="market-rail-token"
            data-token-address={token.tokenAddress}
            key={token.tokenAddress}
            onClick={() => onToken(token)}
          >
            <span className="token-avatar">
              {token.symbol?.slice(0, 1) || "?"}
              {token.logo && (
                <img
                  src={token.logo}
                  alt=""
                  onError={(event) => {
                    event.currentTarget.style.display = "none";
                  }}
                />
              )}
            </span>
            <span>
              <strong>{token.symbol || shortAddress(token.tokenAddress)}</strong>
              <small>{money(token.priceUsd)}</small>
            </span>
            <span>
              <strong>{money(token.marketCapUsd)}</strong>
              <small className={Number(token.change24h) < 0 ? "negative" : "positive"}>
                {percent(token.change24h)}
              </small>
            </span>
          </button>
        ))}
      </aside>
    );
  return (
    <section className="panel discover">
      <div className="section-heading">
        <div>
          <span className="eyebrow">ROBINHOOD CHAIN</span>
          <h1>Discover</h1>
        </div>
        <label className="search">
          <span>搜索</span>
          <input
            aria-label="搜索代币名称或地址"
            placeholder="代币名称或合约地址"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      <div className="toolbar">
        <div className="tabs" aria-label="发现列表">
          {(
            [
              ["hot", "Trending"],
              ["new", "New"],
              ["watchlist", "Watchlist"],
            ] as const
          ).map(([value, label]) => (
            <button key={value} aria-pressed={tab === value} onClick={() => changeTab(value)}>
              {label}
            </button>
          ))}
        </div>
        <div className="tabs" aria-label="行情时间范围">
          {(["1h", "24h"] as const).map((value) => (
            <button
              key={value}
              aria-pressed={period === value}
              onClick={() => {
                setPeriod(value);
                if (tab !== "new")
                  setSort({
                    field: value === "1h" ? "volume1hUsd" : "volume24hUsd",
                    direction: "desc",
                  });
              }}
            >
              {value}
            </button>
          ))}
        </div>
        <label className="quick-presets">
          快捷买入{" "}
          <select
            disabled={!user.quickBuyAmounts.length}
            aria-label="快捷买入金额"
            value={quickAmount}
            onChange={(e) => setSelectedAmount(e.target.value)}
          >
            {user.quickBuyAmounts.map((value) => (
              <option key={value} value={value}>
                {value} U
              </option>
            ))}
          </select>
        </label>
      </div>
      {tab === "new" && (
        <div className="tabs lifecycle-filters">
          {[
            ["ALL", "全部"],
            ["CURVE", "内盘"],
            ["NEAR_GRADUATION", "即将毕业"],
            ["GRADUATED", "已毕业"],
          ].map(([value, label]) => (
            <button key={value} aria-pressed={stage === value} onClick={() => setStage(value)}>
              {label}
            </button>
          ))}
        </div>
      )}
      {(stale || frozen) && (
        <div className="notice">
          {stale && <span>显示上次更新的数据。 </span>}
          {frozen && (
            <button
              onClick={() => {
                window.scrollTo({ top: 0 });
                if (list.current) list.current.scrollTop = 0;
                setScrolled(false);
                setHover(false);
              }}
            >
              {added ? `${added} 个新代币 · ` : "列表排序已暂停 · "}回到顶部更新
            </button>
          )}
        </div>
      )}
      {(error || actionError) && (
        <p role="alert" className="error">
          {error || actionError} <button onClick={() => setRetry((n) => n + 1)}>重试</button>
        </p>
      )}
      {tab === "watchlist" && !user.authenticated ? (
        <div className="empty-state">
          <p>连接钱包查看你的自选</p>
          <button onClick={onConnect}>连接钱包</button>
        </div>
      ) : loading && visible.length === 0 ? (
        <p className="empty-state" role="status">
          加载行情…
        </p>
      ) : (
        <div
          className="table-scroll"
          ref={list}
          onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0 || window.scrollY > 120)}
        >
          <table className="data-table">
            <thead>
              <tr>
                <th>Token</th>
                <th>{column("Age", "ageSeconds")}</th>
                <th>{column("Price", "priceUsd")}</th>
                <th>{column(`${period} change`, period === "1h" ? "change1h" : "change24h")}</th>
                <th>{column("Market cap", "marketCapUsd")}</th>
                <th>
                  {column(`${period} volume`, period === "1h" ? "volume1hUsd" : "volume24hUsd")}
                </th>
                <th>{column("Liquidity", "liquidityUsd")}</th>
                <th>{column("Holders", "holders")}</th>
                <th>
                  {column("Smart", "smartMoneyCount")} / {column("KOL", "kolCount")}
                </th>
                <th>Quick buy</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((token) => (
                <tr key={`${token.chainId}:${token.tokenAddress}`}>
                  <td className="market-token-cell">
                    <button
                      className="watch-button"
                      aria-label={`自选 ${token.symbol || token.tokenAddress}`}
                      aria-pressed={user.watchlist.has(token.tokenAddress.toLowerCase())}
                      onClick={() => watch(token)}
                    >
                      {user.watchlist.has(token.tokenAddress.toLowerCase()) ? "★" : "☆"}
                    </button>
                    <button className="token-link" onClick={() => onToken(token)}>
                      <span className="token-avatar">
                        {token.symbol?.slice(0, 1) || "?"}
                        {token.logo && (
                          <img
                            src={token.logo}
                            alt=""
                            onError={(event) => {
                              event.currentTarget.style.display = "none";
                            }}
                          />
                        )}
                      </span>
                      <strong>{token.symbol || shortAddress(token.tokenAddress)}</strong>
                      <span>{token.name || "名称未知"}</span>
                    </button>
                    <span title={token.tokenAddress} className="muted address">
                      {shortAddress(token.tokenAddress)}
                    </span>
                    <span className="lifecycle">{lifecycleLabel(token)}</span>
                  </td>
                  <td>{age(token.ageSeconds)}</td>
                  <td>{money(token.priceUsd)}</td>
                  <td
                    className={
                      Number(period === "1h" ? token.change1h : token.change24h) < 0
                        ? "negative"
                        : "positive"
                    }
                  >
                    {percent(period === "1h" ? token.change1h : token.change24h)}
                  </td>
                  <td>{money(token.marketCapUsd)}</td>
                  <td>{money(period === "1h" ? token.volume1hUsd : token.volume24hUsd)}</td>
                  <td>{money(token.liquidityUsd)}</td>
                  <td>{amount(token.holders)}</td>
                  <td>
                    {amount(token.smartMoneyCount)} / {amount(token.kolCount)}
                  </td>
                  <td className="quick-buy-cell">
                    <select
                      aria-label={`USDG amount ${token.symbol || token.tokenAddress}`}
                      value={quickAmount}
                      disabled={!user.quickBuyAmounts.length}
                      onChange={(event) => setSelectedAmount(event.target.value)}
                    >
                      {user.quickBuyAmounts.map((value) => (
                        <option key={value} value={value}>
                          {value} USDG
                        </option>
                      ))}
                    </select>
                    <button
                      className="quick-buy-button"
                      disabled={
                        !quickAmount ||
                        token.security?.isHoneypot === true ||
                        pendingToken === token.tokenAddress
                      }
                      title={token.security?.isHoneypot === true ? "貔貅风险，禁止买入" : undefined}
                      onMouseEnter={() => setHover(true)}
                      onMouseLeave={() => setHover(false)}
                      onFocus={() => setHover(true)}
                      onBlur={() => setHover(false)}
                      onClick={() => onQuickBuy(token, quickAmount)}
                    >
                      {pendingToken === token.tokenAddress
                        ? "处理中…"
                        : quickAmount
                          ? "Buy"
                          : "请设置快捷金额"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {visible.length === 0 && !error && (
            <p className="empty-state">
              {tab === "watchlist" ? "暂无自选代币" : "暂无符合条件的代币"}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
