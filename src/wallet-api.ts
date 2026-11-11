import { request, requestPublicMarket } from "./api";
import type {
  ActivityCursor,
  ActivityPage,
  ActivityQuery,
  UserStateKind,
  UserStatePage,
  UserStateValue,
  WalletPosition,
  WalletProfileData,
} from "./wallet-types";

const root = "/sapi/v1/meme";
export const walletApi = {
  profile(address: string, signal?: AbortSignal): Promise<WalletProfileData> {
    return requestPublicMarket(`${root}/wallets/${encodeURIComponent(address)}`, { signal });
  },
  positions(
    address: string,
    after?: string,
    signal?: AbortSignal,
  ): Promise<{ items: WalletPosition[]; nextCursor: string | null }> {
    const query = new URLSearchParams({ limit: "50" });
    if (after) query.set("after", after);
    return requestPublicMarket(
      `${root}/wallets/${encodeURIComponent(address)}/positions?${query}`,
      { signal },
    );
  },
  activities(
    address: string,
    before?: ActivityCursor,
    signal?: AbortSignal,
  ): Promise<ActivityPage> {
    const query = new URLSearchParams({ limit: "25" });
    if (before) {
      query.set("beforeTime", String(before.timestampMs));
      query.set("beforeId", before.eventId);
    }
    return requestPublicMarket(
      `${root}/wallets/${encodeURIComponent(address)}/activities?${query}`,
      { signal },
    );
  },
  /** Phase B shared activity contract. A server without it must report unavailable, never a fake empty feed. */
  feed(filters: ActivityQuery, signal?: AbortSignal): Promise<ActivityPage> {
    const query = new URLSearchParams({
      scope: filters.scope,
      fromMs: String(filters.fromMs),
      limit: String(filters.limit ?? 25),
    });
    if (filters.side !== "ANY") query.set("side", filters.side);
    if (filters.minUsd !== "ANY") query.set("minUsd", filters.minUsd);
    if (filters.before) {
      query.set("beforeTime", String(filters.before.timestampMs));
      query.set("beforeId", filters.before.eventId);
    }
    return (filters.scope === "FOLLOWING" ? request : requestPublicMarket)(
      `${root}/activities?${query}`,
      { signal },
    );
  },
  state(kind: UserStateKind, after?: string, signal?: AbortSignal): Promise<UserStatePage> {
    const query = new URLSearchParams({ limit: "100" });
    if (after) query.set("after", after);
    return request(`${root}/user-state/${kind}?${query}`, { signal });
  },
  saveState(
    kind: UserStateKind,
    target: string,
    value: UserStateValue,
    signal?: AbortSignal,
  ): Promise<{ saved: true }> {
    return request(`${root}/user-state/${kind}/${encodeURIComponent(target)}`, {
      method: "PUT",
      body: JSON.stringify(value),
      signal,
    });
  },
  deleteState(
    kind: UserStateKind,
    target: string,
    signal?: AbortSignal,
  ): Promise<{ deleted: true }> {
    return request(`${root}/user-state/${kind}/${encodeURIComponent(target)}`, {
      method: "DELETE",
      signal,
    });
  },
};
