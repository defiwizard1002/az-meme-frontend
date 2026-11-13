import { useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";
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
  onTrade?: (token: string, side: "BUY" | "SELL") => void;
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
function ProfileContent({ address, onClose, onToken, onTrade }: WalletProfileProps) {
  const [profile, setProfile] = useState<WalletProfileData | null>(null);
  const [positions, setPositions] = useState<WalletPosition[]>([]);
  const [activities, setActivities] = useState<WalletActivity[]>([]);
  const [positionCursor, setPositionCursor] = useState<string | null>(null);
  const [activityCursor, setActivityCursor] = useState<ActivityCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [paging, setPaging] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
          <h3>{profile?.name || shortAddress(address)}</h3>
          <code className="full-address">{address}</code>
          {profile?.labels.map((label) => (
            <span className="badge" key={label}>
              {label === "SMART_MONEY" ? "Smart Money" : "KOL"}
            </span>
          ))}
          {xUrl && (
            <a href={xUrl} target="_blank" rel="noreferrer">
              X
            </a>
          )}
        </div>
      </div>
      <PrivateProfile address={address} onFollowChanged={() => setRevision((value) => value + 1)} />
      {loading && <p role="status">Loading wallet…</p>}
      {error && (
        <p role="alert">
          {error}{" "}
          <button type="button" onClick={() => setRevision((value) => value + 1)}>
            Retry
          </button>
        </p>
      )}
      {profile && (
        <>
          <div className="stat-grid">
            <div>
              <span>7d realized PnL</span>
              <strong aria-label="7d realized PnL">
                {stats?.realizedPnlUsd == null ? "—" : money(stats.realizedPnlUsd)}
              </strong>
            </div>
            <div>
              <span>Open PnL</span>
              <strong>
                {profile.unrealizedPnlUsd == null ? "—" : money(profile.unrealizedPnlUsd)}
              </strong>
            </div>
            <div>
              <span>7d win rate</span>
              <strong>{winRate}</strong>
            </div>
            <div>
              <span>7d buys / sells</span>
              <strong aria-label="7d buys / sells">
                {stats ? `${stats.buyCount} / ${stats.sellCount}` : "—"}
              </strong>
            </div>
          </div>
        </>
      )}
      <h3>Holding</h3>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Token</th>
              <th>Value</th>
              <th>PnL</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {positions
              .filter((position) => position.quantityAtomic !== "0")
              .map((position) => (
                <tr key={position.token}>
                  <td>
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
                      {position.symbol || position.name || shortAddress(position.token)}
                    </button>
                    <small
                      title={`atomic ${position.quantityAtomic ?? "—"}; updated ${position.updatedAt}`}
                    >
                      {position.quantityComplete && position.quantityAtomic !== null
                        ? amount(formatUnits(BigInt(position.quantityAtomic), position.decimals))
                        : "—"}
                    </small>
                  </td>
                  <td>{position.valueUsd == null ? "—" : money(position.valueUsd)}</td>
                  <td>
                    {position.unrealizedPnlUsd == null ? "—" : money(position.unrealizedPnlUsd)}
                  </td>
                  <td>
                    {onTrade && (
                      <button
                        type="button"
                        className="profile-token-buy"
                        aria-label={`Buy ${position.symbol || position.name || shortAddress(position.token)}`}
                        onClick={() => onTrade(position.token, "BUY")}
                      >
                        Buy
                      </button>
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {!loading && !positions.some((position) => position.quantityAtomic !== "0") && (
        <p className="empty-state">No positions</p>
      )}
      {positionCursor && (
        <button type="button" disabled={paging !== null} onClick={morePositions}>
          Load more positions
        </button>
      )}
      <h3>Trades</h3>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Side</th>
              <th>Token</th>
              <th>Amount</th>
              <th>Fill MC</th>
            </tr>
          </thead>
          <tbody>
            {activities.map((activity) => (
              <tr key={activity.eventId}>
                <td title={new Date(activity.timestampMs).toLocaleString()}>
                  {relativeTime(activity.timestampMs)}
                </td>
                <td>
                  {
                    {
                      BUY: "Buy",
                      SELL: "Sell",
                      TRANSFER_IN: "Transfer in",
                      TRANSFER_OUT: "Transfer out",
                    }[activity.kind]
                  }
                </td>
                <td>
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
                <td>{activity.amountUsd == null ? "—" : money(activity.amountUsd)}</td>
                <td>{activity.marketCapUsd == null ? "—" : money(activity.marketCapUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && !activities.length && <p className="empty-state">No activity</p>}
      {activityCursor && (
        <button type="button" disabled={paging !== null} onClick={moreActivities}>
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
  return (
    <section className="private-profile">
      {!state.authenticated ? null : (
        <>
          {(error || state.error) && <p role="alert">{error ?? state.error}</p>}
          <button
            type="button"
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
            {state.followed.has(address) ? "Unfollow" : "Follow wallet"}
          </button>
          {!state.loading && !state.error && (
            <PrivateNote
              key={`${address}:${state.notes[address] ?? ""}`}
              address={address}
              initialValue={state.notes[address] ?? ""}
            />
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
