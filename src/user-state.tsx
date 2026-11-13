import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { walletApi } from "./wallet-api";
import type { UserStateKind, UserStateRow, UserStateValue } from "./wallet-types";

interface PrivateState {
  authenticated: boolean;
  loading: boolean;
  error: string | null;
  followed: ReadonlySet<string>;
  watchlist: ReadonlySet<string>;
  notes: Readonly<Record<string, string>>;
  quickBuyAmounts: string[];
  setFollow(address: string, enabled: boolean): Promise<void>;
  setWatchlist(address: string, enabled: boolean): Promise<void>;
  saveNote(address: string, note: string): Promise<void>;
  saveQuickBuyAmounts(amounts: string[]): Promise<void>;
  reload(): void;
}
const UserStateContext = createContext<PrivateState | null>(null);
const kinds: UserStateKind[] = ["FOLLOW", "NOTE", "WATCHLIST", "SETTINGS"];
type Rows = Record<UserStateKind, UserStateRow[]>;
const emptyRows: Rows = { FOLLOW: [], NOTE: [], WATCHLIST: [], SETTINGS: [] };

export function UserStateProvider({
  userId,
  children,
}: {
  userId: string | null;
  children: ReactNode;
}) {
  // Remounting clears private data before rendering the next account, including late requests.
  return (
    <AccountState key={userId ?? "guest"} authenticated={userId !== null}>
      {children}
    </AccountState>
  );
}
function AccountState({
  authenticated,
  children,
}: {
  authenticated: boolean;
  children: ReactNode;
}) {
  const [rows, setRows] = useState<Rows>(emptyRows);
  const [loading, setLoading] = useState(authenticated);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!authenticated) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void Promise.all(
      kinds.map(async (kind) => {
        const items: UserStateRow[] = [];
        let after: string | undefined;
        do {
          const page = await walletApi.state(kind, after, controller.signal);
          items.push(...page.items);
          after = page.nextCursor ?? undefined;
        } while (after && !controller.signal.aborted);
        return [kind, items] as const;
      }),
    )
      .then((entries) => {
        if (!controller.signal.aborted) setRows(Object.fromEntries(entries) as Rows);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Private settings failed to load");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [authenticated, revision]);
  async function save(kind: UserStateKind, target: string, value: UserStateValue | null) {
    if (!authenticated) throw new Error("Connect wallet to continue");
    const signal = lifetime.current!.signal;
    const normalizedTarget = target.toLowerCase();
    if (value === null) await walletApi.deleteState(kind, normalizedTarget, signal);
    else await walletApi.saveState(kind, normalizedTarget, value, signal);
    if (signal.aborted) return;
    setRows((previous) => ({
      ...previous,
      [kind]: [
        ...previous[kind].filter((row) => row.target !== normalizedTarget),
        ...(value === null ? [] : [{ target: normalizedTarget, value, updatedAt: Date.now() }]),
      ],
    }));
  }
  const preferences = rows.SETTINGS.find((row) => row.target === "preferences");
  const value: PrivateState = {
    authenticated,
    loading,
    error,
    followed: new Set(rows.FOLLOW.map((row) => row.target)),
    watchlist: new Set(rows.WATCHLIST.map((row) => row.target)),
    notes: Object.fromEntries(rows.NOTE.map((row) => [row.target, row.value.note ?? ""])),
    quickBuyAmounts: preferences?.value.quickBuyAmounts ?? ["10", "50", "100"],
    setFollow: (address, enabled) => save("FOLLOW", address, enabled ? {} : null),
    setWatchlist: (address, enabled) => save("WATCHLIST", address, enabled ? {} : null),
    saveNote: (address, note) => save("NOTE", address, note.trim() ? { note } : null),
    saveQuickBuyAmounts: (amounts) => save("SETTINGS", "preferences", { quickBuyAmounts: amounts }),
    reload: () => setRevision((current) => current + 1),
  };
  return <UserStateContext.Provider value={value}>{children}</UserStateContext.Provider>;
}
export function useUserState(): PrivateState {
  const state = useContext(UserStateContext);
  if (!state) throw new Error("UserStateProvider is required");
  return state;
}
