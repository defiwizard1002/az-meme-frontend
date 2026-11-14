import { useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";
import { DesignIcon } from "./DesignIcon";
import { amount, money, relativeTime, safeUrl, shortAddress } from "./display";
import { walletApi } from "./wallet-api";
import { useUserState } from "./user-state";
import type {
  ActivityCursor,
  WalletActivity,
  WalletPosition,
  WalletProfileData,
} from "./wallet-types";

export interface WalletProfileProps {
  address: string;
  onClose: () => void;
  onToken: (address: string) => void;
  onTrade?: (token: string, side: "BUY" | "SELL", amountIn?: string) => void;
  quickBuyAmount?: string;
}
function displayedQuantity(position: WalletPosition): string | null | undefined {
  return !position.quantityComplete || position.quantityAtomic === null
    ? position.observedNetAtomic
    : position.quantityAtomic;
}
export function WalletProfile(props: WalletProfileProps) {
  return (
    <ProfileContent
      key={props.address.toLowerCase()}
      {...props}
      address={props.address.toLowerCase()}
    />
  );
}
function ProfileContent({
  address,
  onClose,
  onToken,
  onTrade,
  quickBuyAmount = "",
}: WalletProfileProps) {
  const [profile, setProfile] = useState<WalletProfileData | null>(null);
  const [positions, setPositions] = useState<WalletPosition[]>([]);
  const [activities, setActivities] = useState<WalletActivity[]>([]);
  const [positionCursor, setPositionCursor] = useState<string | null>(null);
  const [activityCursor, setActivityCursor] = useState<ActivityCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [paging, setPaging] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addressCopied, setAddressCopied] = useState(false);
  const [revision, setRevision] = useState(0);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(null);
    void Promise.allSettled([
      walletApi.profile(address, controller.signal),
      walletApi.positions(address, undefined, controller.signal),
      walletApi.activities(address, undefined, controller.signal),
    ]).then(([profileResult, positionsResult, activitiesResult]) => {
      if (controller.signal.aborted) return;
      if (profileResult.status === "fulfilled") setProfile(profileResult.value);
      if (positionsResult.status === "fulfilled") {
        setPositions(positionsResult.value.items);
        setPositionCursor(positionsResult.value.nextCursor);
      }
      if (activitiesResult.status === "fulfilled") {
        setActivities(activitiesResult.value.items);
        setActivityCursor(activitiesResult.value.nextCursor);
      }
      const failed = [profileResult, positionsResult, activitiesResult].find(
        (result) => result.status === "rejected",
      );
      if (failed?.status === "rejected")
        setError(failed.reason instanceof Error ? failed.reason.message : "Wallet unavailable");
      setLoading(false);
    });
    return () => controller.abort();
  }, [address, revision]);
  function morePositions() {
    if (!positionCursor || paging) return;
    const signal = request.current!.signal;
    setPaging("positions");
    void walletApi
      .positions(address, positionCursor, signal)
      .then((page) => {
        if (signal.aborted) return;
        setPositions((previous) => [...previous, ...page.items]);
        setPositionCursor(page.nextCursor);
      })
      .catch((cause: unknown) => {
        if (!signal.aborted) setError(cause instanceof Error ? cause.message : "Positions failed");
      })
      .finally(() => {
        if (!signal.aborted) setPaging(null);
      });
  }
  function moreActivities() {
    if (!activityCursor || paging) return;
    const signal = request.current!.signal;
    setPaging("activities");
    void walletApi
      .activities(address, activityCursor, signal)
      .then((page) => {
        if (signal.aborted) return;
        setActivities((previous) => [...previous, ...page.items]);
        setActivityCursor(page.nextCursor);
      })
      .catch((cause: unknown) => {
        if (!signal.aborted) setError(cause instanceof Error ? cause.message : "Trades failed");
      })
      .finally(() => {
        if (!signal.aborted) setPaging(null);
      });
  }
  const stats = profile?.stats;
  const winRate = stats?.winRate == null ? "—" : `${(Number(stats.winRate) * 100).toFixed(1)}%`;
  const xUrl = safeUrl(profile?.xUrl);
  const avatar = safeUrl(profile?.avatarUrl);
  const holdings = positions.filter(
    (position) => !(position.quantityComplete && position.quantityAtomic === "0"),
  );
  return (
    <aside
      className="profile-drawer panel"
      role="dialog"
      aria-modal="true"
      aria-label="Wallet profile"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <header className="toolbar">
        <h2>Wallet profile</h2>
        <button type="button" onClick={onClose} aria-label="Close wallet profile">
          ×
        </button>
      </header>
      <div className="profile-identity">
        {avatar ? (
          <img className="wallet-avatar" src={avatar} alt="" />
        ) : (
          <span className="wallet-avatar wallet-avatar-placeholder" aria-hidden="true">
            {address.slice(2, 3).toUpperCase()}
          </span>
        )}
        <div className="profile-copy">
          <div className="profile-name-row">
            <h3>{profile?.name || shortAddress(address)}</h3>
            {profile?.labels.map((label) => (
              <span className="badge" key={label}>
                {label === "SMART_MONEY" ? "Smart money" : "KOL"}
              </span>
            ))}
          </div>
          <button
            type="button"
            className="wallet-address-button"
            title={address}
            aria-label={`Copy wallet address ${address}`}
            onClick={() => {
              void navigator.clipboard.writeText(address).then(
                () => setAddressCopied(true),
                () => setAddressCopied(false),
              );
            }}
          >
            <code>{shortAddress(address)}</code>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="5.5" y="5.5" width="7" height="7" rx="1.5" />
              <path d="M10.5 5.5v-2a1.5 1.5 0 0 0-1.5-1.5H4.5A1.5 1.5 0 0 0 3 3.5v4.5A1.5 1.5 0 0 0 4.5 9.5h1" />
            </svg>
            {addressCopied && <span className="visually-hidden">Address copied</span>}
          </button>
          {xUrl && (
            <div className="profile-meta">
              <a href={xUrl} target="_blank" rel="noreferrer">
                𝕏 Profile
              </a>
            </div>
          )}
        </div>
        <PrivateProfile
          address={address}
          onFollowChanged={() => setRevision((value) => value + 1)}
        />
      </div>
      {loading && (
        <p className="profile-loading" role="status">
          Loading wallet…
        </p>
      )}
      {error && (
        <p className="profile-error" role="alert">
          {error}{" "}
          <button type="button" onClick={() => setRevision((value) => value + 1)}>
            Retry
          </button>
        </p>
      )}
      <div className="stat-grid" aria-busy={loading}>
        <div className={Number(stats?.realizedPnlUsd) < 0 ? "negative" : undefined}>
          <span title="7d realized PnL" aria-label="7d realized PnL">
            7d PnL
          </span>
          <strong>
            {loading ? (
              <span className="stat-value-loading" aria-hidden="true" />
            ) : stats?.realizedPnlUsd == null ? (
              "—"
            ) : (
              money(stats.realizedPnlUsd)
            )}
          </strong>
        </div>
        <div>
          <span>7d win rate</span>
          <strong>
            {loading ? <span className="stat-value-loading" aria-hidden="true" /> : winRate}
          </strong>
        </div>
        <div>
          <span>7d buys / sells</span>
          <strong aria-label="7d buys / sells">
            {loading ? (
              <span className="stat-value-loading" aria-hidden="true" />
            ) : stats ? (
              `${stats.buyCount} / ${stats.sellCount}`
            ) : (
              "—"
            )}
          </strong>
        </div>
        <div className={Number(profile?.unrealizedPnlUsd) < 0 ? "negative" : undefined}>
          <span>Unrealized PnL</span>
          <strong aria-label="Unrealized PnL">
            {loading ? (
              <span className="stat-value-loading" aria-hidden="true" />
            ) : profile?.unrealizedPnlUsd == null ? (
              "—"
            ) : (
              money(profile.unrealizedPnlUsd)
            )}
          </strong>
        </div>
      </div>
      <h3 className="profile-section-title">Holding</h3>
      <div className="table-scroll wallet-holdings-scroll">
        <table className="wallet-holdings-table">
          <tbody>
            {holdings.map((position) => {
              const incomplete = !position.quantityComplete || position.quantityAtomic === null;
              const quantity = displayedQuantity(position);
              const exactQuantity =
                quantity == null ? null : formatUnits(BigInt(quantity), position.decimals);
              const tokenName = position.symbol || position.name || shortAddress(position.token);
              return (
                <tr key={position.token} className={incomplete ? "holding-incomplete" : undefined}>
                  <td className="holding-token">
                    <div className="holding-token-main">
                      <button
                        type="button"
                        className="text-button wallet-token-identity"
                        title={position.token}
                        onClick={() => onToken(position.token)}
                      >
                        {safeUrl(position.logo) && (
                          <img
                            src={safeUrl(position.logo)}
                            alt=""
                            width={24}
                            height={24}
                            onError={(event) => {
                              event.currentTarget.style.display = "none";
                            }}
                          />
                        )}
                        {tokenName}
                      </button>
                      {!incomplete && exactQuantity !== null && (
                        <details className="wallet-quantity">
                          <summary
                            title={`Exact quantity: ${exactQuantity} ${tokenName}`}
                            aria-label={`Exact holding quantity for ${tokenName}: ${exactQuantity} ${tokenName}`}
                          >
                            Qty
                          </summary>
                          <div className="wallet-quantity-panel" role="note">
                            <span>Exact quantity</span>
                            <code>
                              {exactQuantity} {tokenName}
                            </code>
                          </div>
                        </details>
                      )}
                    </div>
                    {incomplete && (
                      <small title="On-chain net movement; position attribution is incomplete">
                        {quantity != null
                          ? amount(formatUnits(BigInt(quantity), position.decimals))
                          : "—"}
                        {quantity != null && " observed net · incomplete"}
                      </small>
                    )}
                  </td>
                  <td
                    className="holding-value"
                    title={
                      position.valueUsd == null
                        ? "Value unavailable: price or complete quantity is missing"
                        : undefined
                    }
                  >
                    {position.valueUsd == null ? "—" : money(position.valueUsd)}
                  </td>
                  <td
                    className={`holding-pnl ${
                      position.unrealizedPnlUsd == null
                        ? ""
                        : Number(position.unrealizedPnlUsd) >= 0
                          ? "positive"
                          : "negative"
                    }`}
                    title={
                      position.unrealizedPnlUsd == null
                        ? "PnL unavailable: cost basis or value is missing"
                        : undefined
                    }
                  >
                    {position.unrealizedPnlUsd == null ? "—" : money(position.unrealizedPnlUsd)}
                  </td>
                  <td className="holding-action">
                    {onTrade && (
                      <button
                        type="button"
                        className="profile-token-buy"
                        aria-label={
                          quickBuyAmount
                            ? `Buy ${tokenName} with ${quickBuyAmount} USDG`
                            : "Set a quick-buy amount"
                        }
                        disabled={!quickBuyAmount}
                        onClick={() => onTrade(position.token, "BUY", quickBuyAmount)}
                      >
                        <DesignIcon name="bolt" />
                        {quickBuyAmount ? `${quickBuyAmount} USDG` : "Set amount"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!loading && !holdings.length && <p className="empty-state">No positions</p>}
      {positionCursor && (
        <button
          type="button"
          className="profile-load-more"
          disabled={paging !== null}
          onClick={morePositions}
        >
          Load more positions
        </button>
      )}
      <h3 className="profile-section-title">Trades</h3>
      <div className="table-scroll">
        <table className="wallet-trades-table">
          <tbody>
            {activities.map((activity) => (
              <tr key={activity.eventId}>
                <td
                  className="wallet-trade-time"
                  title={new Date(activity.timestampMs).toLocaleString()}
                >
                  {relativeTime(activity.timestampMs)}
                </td>
                <td className={`wallet-trade-side trade-side-${activity.kind}`}>
                  {
                    {
                      BUY: "Buy",
                      SELL: "Sell",
                      TRANSFER_IN: "Transfer in",
                      TRANSFER_OUT: "Transfer out",
                    }[activity.kind]
                  }
                </td>
                <td className="wallet-trade-token">
                  <button
                    type="button"
                    className="text-button wallet-token-identity"
                    title={activity.tokenName || activity.token}
                    onClick={() => onToken(activity.token)}
                  >
                    {safeUrl(activity.tokenLogo) && (
                      <img
                        src={safeUrl(activity.tokenLogo)}
                        alt=""
                        width={20}
                        height={20}
                        onError={(event) => {
                          event.currentTarget.style.display = "none";
                        }}
                      />
                    )}
                    {activity.tokenSymbol || activity.tokenName || shortAddress(activity.token)}
                  </button>
                </td>
                <td
                  className="wallet-trade-amount"
                  title={
                    activity.marketCapUsd == null
                      ? undefined
                      : `Fill MC ${money(activity.marketCapUsd)}`
                  }
                >
                  {activity.amountUsd == null ? "—" : money(activity.amountUsd)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && !activities.length && <p className="empty-state">No activity</p>}
      {activityCursor && (
        <button
          type="button"
          className="profile-load-more"
          disabled={paging !== null}
          onClick={moreActivities}
        >
          Load more trades
        </button>
      )}
    </aside>
  );
}
function PrivateProfile({
  address,
  onFollowChanged,
}: {
  address: string;
  onFollowChanged: () => void;
}) {
  const state = useUserState();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  return (
    <section className="private-profile">
      {!state.authenticated ? null : (
        <>
          <div className="private-profile-actions">
            <button
              type="button"
              className="private-follow-button"
              title={state.followed.has(address) ? "Unfollow wallet" : "Follow wallet"}
              aria-label={state.followed.has(address) ? "Unfollow wallet" : "Follow wallet"}
              aria-pressed={state.followed.has(address)}
              disabled={pending || state.loading || Boolean(state.error)}
              onClick={() => {
                setPending(true);
                setError(null);
                void state
                  .setFollow(address, !state.followed.has(address))
                  .then(onFollowChanged)
                  .catch((cause: unknown) =>
                    setError(cause instanceof Error ? cause.message : "Follow failed"),
                  )
                  .finally(() => setPending(false));
              }}
            >
              <DesignIcon name="star" filled={state.followed.has(address)} />
            </button>
            <button
              type="button"
              className="private-note-toggle"
              title="Private note"
              aria-label="Private note"
              aria-expanded={noteOpen}
              disabled={state.loading || Boolean(state.error)}
              onClick={() => setNoteOpen((value) => !value)}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="m3 11.8-.5 2.2 2.2-.5 7.9-7.9-1.7-1.7Z" />
                <path d="m10.2 4.6 1.7 1.7" />
              </svg>
            </button>
          </div>
          {noteOpen && !state.loading && !state.error && (
            <div className="private-note-popover">
              <PrivateNote
                key={`${address}:${state.notes[address] ?? ""}`}
                address={address}
                initialValue={state.notes[address] ?? ""}
              />
            </div>
          )}
          {(error || state.error) && (
            <p className="private-profile-error" role="alert">
              {error ?? state.error}
            </p>
          )}
        </>
      )}
    </section>
  );
}
function PrivateNote({ address, initialValue }: { address: string; initialValue: string }) {
  const state = useUserState();
  const [note, setNote] = useState(initialValue);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        void state
          .saveNote(address, note)
          .catch((cause: unknown) =>
            setError(cause instanceof Error ? cause.message : "Note failed to save"),
          )
          .finally(() => setPending(false));
      }}
    >
      <label>
        Private note
        <textarea
          value={note}
          maxLength={1000}
          onChange={(event) => setNote(event.target.value)}
          disabled={pending}
        />
      </label>
      <button type="submit" disabled={pending || note === initialValue}>
        Save note
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
