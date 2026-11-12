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
function ProfileContent({ address, onClose, onToken }: WalletProfileProps) {
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
        setError(failed.reason instanceof Error ? failed.reason.message : "钱包资料暂不可用");
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
        if (!signal.aborted) setError(cause instanceof Error ? cause.message : "持仓读取失败");
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
        if (!signal.aborted) setError(cause instanceof Error ? cause.message : "交易读取失败");
      })
      .finally(() => {
        if (!signal.aborted) setPaging(null);
      });
  }
  const stats = profile?.stats;
  const winRate = stats?.winRate == null ? "未知" : `${(Number(stats.winRate) * 100).toFixed(1)}%`;
  const xUrl = safeUrl(profile?.xUrl);
  const avatar = safeUrl(profile?.avatarUrl);
  return (
    <aside
      className="profile-drawer panel"
      role="dialog"
      aria-modal="true"
      aria-label="钱包 Profile"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <header className="toolbar">
        <h2>钱包 Profile</h2>
        <button type="button" onClick={onClose} aria-label="关闭钱包资料">
          关闭
        </button>
      </header>
      <div className="profile-identity">
        {avatar && <img className="wallet-avatar" src={avatar} alt="" />}
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
      <PrivateProfile address={address} onFollowChanged={() => setRevision((value) => value + 1)} />
      {loading && <p role="status">正在读取钱包资料…</p>}
      {error && (
        <p role="alert">
          {error}{" "}
          <button type="button" onClick={() => setRevision((value) => value + 1)}>
            重试
          </button>
        </p>
      )}
      {profile && (
        <>
          <div className="stat-grid">
            <div>
              <span>7 日已实现盈亏</span>
              <strong aria-label="7 日已实现盈亏">
                {stats?.realizedPnlUsd == null ? "未知" : money(stats.realizedPnlUsd)}
              </strong>
            </div>
            <div>
              <span>当前持仓浮盈</span>
              <strong>
                {profile.unrealizedPnlUsd == null ? "未知" : money(profile.unrealizedPnlUsd)}
              </strong>
            </div>
            <div>
              <span>7 日胜率</span>
              <strong>{winRate}</strong>
            </div>
            <div>
              <span>7 日买入 / 卖出</span>
              <strong aria-label="7 日买入 / 卖出">
                {stats ? `${stats.buyCount} / ${stats.sellCount}` : "未知"}
              </strong>
            </div>
          </div>
        </>
      )}
      <h3>当前持仓</h3>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>代币</th>
              <th>数量</th>
              <th>成本 (U)</th>
              <th>价值 (U)</th>
              <th>浮盈 (U)</th>
              <th>更新时间</th>
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
                      className="text-button"
                      title={position.token}
                      onClick={() => onToken(position.token)}
                    >
                      {shortAddress(position.token)}
                    </button>
                  </td>
                  <td>
                    {position.quantityComplete && position.quantityAtomic !== null
                      ? amount(formatUnits(BigInt(position.quantityAtomic), position.decimals))
                      : "未知"}
                  </td>
                  <td>{position.costUsd == null ? "未知" : money(position.costUsd)}</td>
                  <td>{position.valueUsd == null ? "未知" : money(position.valueUsd)}</td>
                  <td>
                    {position.unrealizedPnlUsd == null ? "未知" : money(position.unrealizedPnlUsd)}
                  </td>
                  <td>{relativeTime(position.updatedAt)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {!loading && !positions.some((position) => position.quantityAtomic !== "0") && (
        <p className="empty-state">暂无持仓</p>
      )}
      {positionCursor && (
        <button type="button" disabled={paging !== null} onClick={morePositions}>
          更多持仓
        </button>
      )}
      <h3>最近交易与转账</h3>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>方向</th>
              <th>代币</th>
              <th>金额 (U)</th>
              <th>交易时市值 (U)</th>
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
                    { BUY: "买入", SELL: "卖出", TRANSFER_IN: "转入", TRANSFER_OUT: "转出" }[
                      activity.kind
                    ]
                  }
                </td>
                <td>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => onToken(activity.token)}
                  >
                    {shortAddress(activity.token)}
                  </button>
                </td>
                <td>{activity.amountUsd == null ? "未知" : money(activity.amountUsd)}</td>
                <td>{activity.marketCapUsd == null ? "未知" : money(activity.marketCapUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && !activities.length && <p className="empty-state">暂无动态</p>}
      {activityCursor && (
        <button type="button" disabled={paging !== null} onClick={moreActivities}>
          更多交易
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
                  setError(cause instanceof Error ? cause.message : "关注保存失败"),
                )
                .finally(() => setPending(false));
            }}
          >
            {state.followed.has(address) ? "取消关注" : "关注钱包"}
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
            setError(cause instanceof Error ? cause.message : "备注保存失败"),
          )
          .finally(() => setPending(false));
      }}
    >
      <label>
        私有备注
        <textarea
          value={note}
          maxLength={1000}
          onChange={(event) => setNote(event.target.value)}
          disabled={pending}
        />
      </label>
      <button type="submit" disabled={pending || note === initialValue}>
        保存备注
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
