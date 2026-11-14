import { useCallback, useEffect, useRef, useState } from "react";
import Discover from "./Discover";
import { memeApi } from "./api";
import { walletApi } from "./wallet-api";
import { UserStateProvider, useUserState } from "./user-state";
import { ActivityFeed, ActivityRibbon } from "./ActivityFeed";
import { WalletProfile } from "./WalletProfile";
import { UserSettings } from "./UserSettings";
import { TokenDetails } from "./TokenDetails";
import { TradingPanel } from "./TradingPanel";
import { Portfolio } from "./Portfolio";
import { DesignIcon } from "./DesignIcon";
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
type Page = "discover" | "activity" | "portfolio" | "settings" | "token" | "wallet";
function route(): { page: Page; address?: string } {
  const [page, address] = window.location.hash.slice(1).split("/");
  if ((page === "token" || page === "wallet") && /^0x[0-9a-f]{40}$/i.test(address ?? ""))
    return { page, address: address.toLowerCase() };
  return {
    page: (["activity", "portfolio", "settings"].includes(page) ? page : "discover") as Page,
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
  const profileAddress = location.page === "wallet" ? location.address : profile;
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [accountError, setAccountError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [held, setHeld] = useState<ReadonlySet<string>>(new Set());
  const [explorer, setExplorer] = useState(
    (import.meta.env.VITE_EXPLORER_BASE_URL as string | undefined) ||
      "https://robinhoodchain.blockscout.com",
  );
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
        if (active && config.explorerBaseUrl) setExplorer(config.explorerBaseUrl);
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
            setAccountError(cause instanceof Error ? cause.message : "Account unavailable");
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
        if (active) setTokenError(cause instanceof Error ? cause.message : "Token unavailable");
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
  const availableUsdg = summary?.quoteBalances.find(
    (balance) => balance.asset === "USDG",
  )?.available;
  const totalAccountValue =
    availableUsdg != null && positionValue != null
      ? String(Number(availableUsdg) + positionValue)
      : null;
  const accountNav = (
    <div className="account-nav">
      <div
        className="account-overview"
        aria-label={walletAddress ? "Account overview" : "Connect wallet to view account overview"}
      >
        <span>
          Available
          <strong>
            {amount(summary?.quoteBalances.find((balance) => balance.asset === "USDG")?.available)}{" "}
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
          <button onClick={() => setProfile(walletAddress)}>{shortAddress(walletAddress)}</button>
          <button onClick={onLogout}>Log out</button>
        </>
      ) : (
        <button className="primary" disabled={connectionPending} onClick={() => void connect()}>
          {connectionPending ? "Connecting…" : "Connect wallet"}
        </button>
      )}
    </div>
  );
  return (
    <div className={`app-shell page-${location.page}`}>
      <header className="platform-header">
        <button
          className="platform-brand"
          onClick={() => navigate("discover")}
          aria-label="AZX home"
        >
          <img className="azx-mark" src="/icons/azx-mark.png" alt="" />
          <span>AZX</span>
        </button>
        <nav className="platform-nav" aria-label="Platform navigation">
          {["Trade", "Markets", "Strategies", "Vault", "Portfolio", "Referral"].map(
            (label, index) => (
              <span className="platform-nav-item" aria-disabled="true" key={label}>
                {label}
                {index === 0 && <span className="platform-chevron">⌄</span>}
              </span>
            ),
          )}
        </nav>
      </header>
      {location.page === "token" ? (
        <header className="detail-context-bar">
          <div className="detail-context-left">
            <button className="detail-back" onClick={() => navigate("discover")}>
              ← Back
            </button>
            <span className="chain-chip">
              <span aria-hidden="true">●</span>
              Robinhood Chain
              <span className="chip-chevron" aria-hidden="true">
                ⌄
              </span>
            </span>
          </div>
          {accountNav}
        </header>
      ) : (
        <>
          <header className="product-header">
            <div className="product-identity">
              <div className="product-title-row">
                <button
                  className="product-title"
                  onClick={() => navigate("discover")}
                  aria-label="Memebot home"
                >
                  Meme
                </button>
                <span className="chain-chip">
                  <span aria-hidden="true">●</span>
                  Robinhood Chain
                  <span className="chip-chevron" aria-hidden="true">
                    ⌄
                  </span>
                </span>
              </div>
              <p className="product-tagline">Get in early. Dodge the rugs.</p>
            </div>
            {accountNav}
          </header>
          <nav className="product-tabs" aria-label="Memebot navigation">
            {(
              [
                ["discover", "Discover"],
                ["activity", "Smart money"],
                ["portfolio", "Positions & orders"],
                ["settings", "Settings"],
              ] as const
            ).map(([page, label]) => (
              <button
                key={page}
                aria-current={
                  location.page === page ||
                  (location.page === "token" && page === "discover") ||
                  (location.page === "wallet" && page === "activity")
                    ? "page"
                    : undefined
                }
                onClick={() => navigate(page)}
              >
                {page === "activity" && <DesignIcon name="smart-money" />}
                {label}
                {page === "portfolio" && held.size > 0 && (
                  <span className="product-tab-count">{held.size}</span>
                )}
              </button>
            ))}
          </nav>
        </>
      )}
      {location.page !== "token" && (
        <ActivityRibbon
          onWallet={setProfile}
          onToken={openToken}
          onSmartMoney={() => navigate("activity")}
        />
      )}
      <main>
        {connectionError && <p className="notice">{connectionError}</p>}
        {accountError && (
          <p className="notice">
            Account unavailable: {accountError} <button onClick={refreshAccount}>Retry</button>
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
        {(location.page === "activity" || location.page === "wallet") && (
          <ActivityFeed
            onWallet={setProfile}
            onToken={openToken}
            explorerBaseUrl={explorer}
            onTrade={(address, side, amountIn) =>
              trade(
                address,
                side,
                side === "BUY" ? (amountIn ?? user.quickBuyAmounts[0]) : undefined,
              )
            }
            heldTokens={held}
          />
        )}
        {location.page === "settings" && <UserSettings onWallet={setProfile} onToken={openToken} />}
        {location.page === "portfolio" &&
          (walletAddress ? (
            <>
              <dl className="portfolio-summary" aria-label="Account overview">
                <div>
                  <dt>Meme Bot account</dt>
                  <dd>{amount(availableUsdg)} USDG</dd>
                </div>
                <div>
                  <dt>Position value</dt>
                  <dd>{money(positionValue)}</dd>
                </div>
                <div>
                  <dt>Unrealized PnL</dt>
                  <dd
                    className={unrealizedPnl != null && unrealizedPnl < 0 ? "negative" : "positive"}
                  >
                    {money(unrealizedPnl)}
                  </dd>
                </div>
                <div>
                  <dt>Total</dt>
                  <dd>{money(totalAccountValue)}</dd>
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
              <p>Connect wallet to view positions and orders</p>
              <button className="primary" onClick={() => void connect()}>
                Connect wallet
              </button>
            </section>
          ))}
        {location.page === "token" && (
          <>
            {tokenError && (
              <p role="alert" className="error">
                {tokenError} <button onClick={() => setTokenRetry((n) => n + 1)}>Retry</button>
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
                        setTokenError(cause instanceof Error ? cause.message : "Watchlist failed"),
                      );
                  }}
                  onTokenUpdate={onTokenUpdate}
                  explorerBaseUrl={explorer}
                  onSell={(address) => trade(address, "SELL")}
                >
                  <TradingPanel
                    key={`${walletAddress ?? "guest"}:${token.tokenAddress}`}
                    token={token}
                    account={summary}
                    walletAddress={walletAddress}
                    onConnect={connect}
                    quickBuyAmounts={user.quickBuyAmounts}
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
                  Loading token…
                </p>
              )
            )}
          </>
        )}
      </main>
      <footer className="app-footer">
        <span>Robinhood Chain · Memebot</span>
      </footer>
      {profileAddress && (
        <WalletProfile
          key={`${profileAddress}:${walletAddress ?? "guest"}`}
          address={profileAddress}
          onClose={() => {
            setProfile(undefined);
            if (location.page === "wallet") navigate("activity");
          }}
          onToken={openToken}
          onTrade={trade}
        />
      )}
    </div>
  );
}
