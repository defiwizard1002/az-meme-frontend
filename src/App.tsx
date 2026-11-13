import { useCallback, useEffect, useRef, useState } from "react";
import Discover from "./Discover";
import Callout from "./Callout";
import { memeApi } from "./api";
import { walletApi } from "./wallet-api";
import { UserStateProvider, useUserState } from "./user-state";
import { ActivityFeed, ActivityRibbon } from "./ActivityFeed";
import { WalletProfile } from "./WalletProfile";
import { UserSettings } from "./UserSettings";
import { TokenDetails } from "./TokenDetails";
import { TradingPanel } from "./TradingPanel";
import { Portfolio } from "./Portfolio";
import { amount, money, shortAddress } from "./display";
import type { AccountSummary, Token } from "./types";
import "./styles.css";

interface AppProps {
  walletRequired?: boolean;
  walletAddress?: string;
  accountIdentity?: string;
  connectionPending?: boolean;
  connectionStatus?: string;
  connectionRetryable?: boolean;
  connectionError?: string;
  onConnect?: () => Promise<boolean>;
  onLogout?: () => void;
}
type Page = "discover" | "callout" | "activity" | "portfolio" | "settings" | "token";
function route(): { page: Page; address?: string } {
  const [page, address] = window.location.hash.slice(1).split("/");
  if (page === "token" && /^0x[0-9a-f]{40}$/i.test(address ?? ""))
    return { page, address: address.toLowerCase() };
  return {
    page: (["callout", "activity", "portfolio", "settings"].includes(page)
      ? page
      : "discover") as Page,
  };
}
export default function App(props: AppProps) {
  const identity = props.accountIdentity ?? props.walletAddress?.toLowerCase() ?? null;
  return (
    <UserStateProvider key={identity ?? "guest"} userId={identity}>
      <Workspace {...props} />
    </UserStateProvider>
  );
}
function Workspace({
  walletAddress,
  connectionPending,
  connectionError,
  onConnect,
  onLogout,
}: AppProps) {
  const user = useUserState();
  const [location, setLocation] = useState(route);
  const [token, setToken] = useState<Token | null>(null);
  const [tokenError, setTokenError] = useState<string>();
  const [tokenRetry, setTokenRetry] = useState(0);
  const [profile, setProfile] = useState<string>();
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [accountError, setAccountError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [held, setHeld] = useState<ReadonlySet<string>>(new Set());
  const [explorer, setExplorer] = useState("");
  const [quick, setQuick] = useState<{
    id: string;
    side: "BUY" | "SELL";
    amountIn?: string;
    tokenAddress: string;
  } | null>(null);
  const identity = useRef(walletAddress);
  identity.current = walletAddress;
  useEffect(() => {
    const change = () => setLocation(route());
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    let active = true;
    void memeApi
      .getConfig()
      .then((config) => {
        if (active) setExplorer(config.explorerBaseUrl);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setSummary(null);
    setAccountError(undefined);
    if (walletAddress)
      void memeApi
        .getAccount(controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) setSummary(value);
        })
        .catch((cause) => {
          if (!controller.signal.aborted)
            setAccountError(cause instanceof Error ? cause.message : "账户暂时不可用");
        });
    return () => controller.abort();
  }, [walletAddress, revision]);
  useEffect(() => {
    if (location.page !== "token" || !location.address) return;
    let active = true;
    setToken((current) =>
      current?.tokenAddress.toLowerCase() === location.address ? current : null,
    );
    setTokenError(undefined);
    void memeApi
      .getToken(location.address)
      .then((value) => {
        if (active) setToken(value);
      })
      .catch((cause) => {
        if (active) setTokenError(cause instanceof Error ? cause.message : "代币详情暂时不可用");
      });
    return () => {
      active = false;
    };
  }, [location.address, location.page, tokenRetry]);
  const navigate = useCallback((page: Page, address?: string) => {
    window.location.hash = page === "token" ? `token/${address}` : page;
    setLocation({ page, address });
    window.scrollTo({ top: 0 });
  }, []);
  const openToken = useCallback(
    (value: Token | string) => {
      const address =
        typeof value === "string" ? value.toLowerCase() : value.tokenAddress.toLowerCase();
      if (typeof value !== "string") setToken(value);
      navigate("token", address);
    },
    [navigate],
  );
  const connect = useCallback(() => onConnect?.() ?? Promise.resolve(false), [onConnect]);
  const refreshAccount = useCallback(() => setRevision((n) => n + 1), []);
  const onTokenUpdate = useCallback(
    (value: Token) =>
      setToken((current) =>
        current?.tokenAddress.toLowerCase() === value.tokenAddress.toLowerCase() ? value : current,
      ),
    [],
  );
  const consumeQuick = useCallback(
    (id: string) => setQuick((current) => (current?.id === id ? null : current)),
    [],
  );
  const trade = useCallback(
    (address: string, side: "BUY" | "SELL", amountIn?: string) => {
      openToken(address);
      setQuick({ id: crypto.randomUUID(), side, amountIn, tokenAddress: address.toLowerCase() });
      if (!identity.current) void connect();
    },
    [openToken, connect],
  );
  useEffect(() => {
    const controller = new AbortController();
    setHeld(new Set());
    if (walletAddress)
      void (async () => {
        const tokens = new Set<string>();
        let after: string | undefined;
        do {
          const page = await walletApi.positions(walletAddress, after, controller.signal);
          for (const position of page.items)
            if (
              position.quantityComplete &&
              position.quantityAtomic !== null &&
              BigInt(position.quantityAtomic) > 0n
            )
              tokens.add(position.token.toLowerCase());
          after = page.nextCursor ?? undefined;
        } while (after && !controller.signal.aborted);
        if (!controller.signal.aborted) setHeld(tokens);
      })().catch(() => {});
    return () => controller.abort();
  }, [walletAddress, revision]);
  const positionValue =
    summary && summary.positions.every((position) => position.valueUsd != null)
      ? summary.positions.reduce((total, position) => total + Number(position.valueUsd), 0)
      : null;
  const unrealizedPnl =
    positionValue != null && summary?.positions.every((position) => position.costUsd != null)
      ? positionValue -
        summary.positions.reduce((total, position) => total + Number(position.costUsd), 0)
      : null;
  return (
    <div className={`app-shell page-${location.page}`}>
      <header className="app-header">
        <button className="brand" onClick={() => navigate("discover")} aria-label="Memebot 首页">
          <span>Meme</span>
          <span className="chain-label">● Robinhood Chain</span>
          <small>Get in early. Dodge the rugs.</small>
        </button>
        <nav aria-label="主导航">
          {(
            [
              ["discover", "Discover"],
              ["callout", "Callout"],
              ["activity", "Smart Money"],
              ["portfolio", "Positions / Orders"],
              ["settings", "设置"],
            ] as const
          ).map(([page, label]) => (
            <button
              key={page}
              aria-current={location.page === page ? "page" : undefined}
              onClick={() => navigate(page)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="account-nav">
          <div
            className="account-overview"
            aria-label={walletAddress ? "账户概览" : "连接钱包后查看账户概览"}
          >
            <span>
              Available
              <strong>
                {amount(
                  summary?.quoteBalances.find((balance) => balance.asset === "USDG")?.available,
                )}{" "}
                <small>USDG</small>
              </strong>
            </span>
            <span>
              Positions<strong>{money(positionValue)}</strong>
            </span>
            <span>
              Unrealized Pnl<strong>{money(unrealizedPnl)}</strong>
            </span>
          </div>
          {walletAddress ? (
            <>
              <button onClick={() => setProfile(walletAddress)}>
                {shortAddress(walletAddress)}
              </button>
              <button onClick={onLogout}>退出</button>
            </>
          ) : (
            <button className="primary" disabled={connectionPending} onClick={() => void connect()}>
              {connectionPending ? "连接中…" : "连接钱包"}
            </button>
          )}
        </div>
      </header>
      <ActivityRibbon
        onWallet={setProfile}
        onToken={openToken}
        onSmartMoney={() => navigate("activity")}
      />
      <main>
        {connectionError && <p className="notice">{connectionError}</p>}
        {accountError && (
          <p className="notice">
            账户读取失败：{accountError} <button onClick={refreshAccount}>重试</button>
          </p>
        )}
        {location.page === "discover" && (
          <Discover
            onToken={openToken}
            onQuickBuy={(value, amountIn) => {
              setToken(value);
              trade(value.tokenAddress, "BUY", amountIn);
            }}
            onConnect={() => void connect()}
          />
        )}
        {location.page === "callout" && (
          <Callout onToken={(address) => navigate("token", address)} />
        )}
        {location.page === "activity" && (
          <ActivityFeed
            onWallet={setProfile}
            onToken={openToken}
            onTrade={(address, side) =>
              trade(address, side, side === "BUY" ? user.quickBuyAmounts[0] : undefined)
            }
            heldTokens={held}
          />
        )}
        {location.page === "settings" && <UserSettings onWallet={setProfile} onToken={openToken} />}
        {location.page === "portfolio" &&
          (walletAddress ? (
            <>
              <dl className="portfolio-summary" aria-label="账户概览">
                <div>
                  <dt>Meme Bot account · USDG</dt>
                  <dd>
                    {amount(
                      summary?.quoteBalances.find((balance) => balance.asset === "USDG")?.available,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>已记录持仓</dt>
                  <dd>{summary ? summary.positions.length : "—"}</dd>
                </div>
                <div>
                  <dt>持仓价值 · USD</dt>
                  <dd>
                    {summary?.positions.length &&
                    summary.positions.every((position) => position.valueUsd !== null)
                      ? amount(
                          summary.positions.reduce(
                            (total, position) => total + Number(position.valueUsd),
                            0,
                          ),
                        )
                      : "—"}
                  </dd>
                </div>
              </dl>
              <Portfolio
                walletAddress={walletAddress}
                explorerBaseUrl={explorer}
                onSell={(address) => trade(address, "SELL")}
                onToken={openToken}
                refreshKey={revision}
              />
            </>
          ) : (
            <section className="panel empty-state">
              <h1>Positions / Orders</h1>
              <p>连接钱包查看你的持仓和订单</p>
              <button className="primary" onClick={() => void connect()}>
                连接钱包
              </button>
            </section>
          ))}
        {location.page === "token" && (
          <>
            <button className="back-link" onClick={() => navigate("discover")}>
              ← Discover
            </button>
            {tokenError && (
              <p role="alert" className="error">
                {tokenError} <button onClick={() => setTokenRetry((n) => n + 1)}>重试</button>
              </p>
            )}
            {token && token.tokenAddress.toLowerCase() === location.address ? (
              <div className="trading-screen">
                <Discover
                  compact
                  onToken={openToken}
                  onQuickBuy={(value, amountIn) => trade(value.tokenAddress, "BUY", amountIn)}
                  onConnect={() => void connect()}
                />
                <TokenDetails
                  key={token.tokenAddress.toLowerCase()}
                  token={token}
                  walletAddress={walletAddress}
                  follows={[...user.followed]}
                  onProfile={setProfile}
                  watched={user.watchlist.has(token.tokenAddress.toLowerCase())}
                  onWatch={() => {
                    if (!user.authenticated) {
                      void connect();
                      return;
                    }
                    void user
                      .setWatchlist(
                        token.tokenAddress,
                        !user.watchlist.has(token.tokenAddress.toLowerCase()),
                      )
                      .catch((cause) =>
                        setTokenError(cause instanceof Error ? cause.message : "自选保存失败"),
                      );
                  }}
                  onTokenUpdate={onTokenUpdate}
                >
                  <TradingPanel
                    key={`${walletAddress ?? "guest"}:${token.tokenAddress}`}
                    token={token}
                    account={summary}
                    walletAddress={walletAddress}
                    onConnect={connect}
                    onAccountRefresh={refreshAccount}
                    quickRequest={
                      quick?.tokenAddress === token.tokenAddress.toLowerCase() ? quick : null
                    }
                    onQuickRequestConsumed={consumeQuick}
                    onExecutionChange={refreshAccount}
                  />
                </TokenDetails>
              </div>
            ) : (
              !tokenError && (
                <p role="status" className="empty-state">
                  加载代币…
                </p>
              )
            )}
          </>
        )}
      </main>
      <footer className="app-footer">
        <span>Robinhood Chain · Memebot</span>
      </footer>
      {profile && (
        <WalletProfile
          key={`${profile}:${walletAddress ?? "guest"}`}
          address={profile}
          onClose={() => setProfile(undefined)}
          onToken={openToken}
          onTrade={trade}
        />
      )}
    </div>
  );
}
