import { useState } from "react";
import { shortAddress } from "./display";
import { useUserState } from "./user-state";

export function parseQuickBuyAmounts(text: string): string[] {
  const values = text.trim() ? text.split(/[,，\s]+/).filter(Boolean) : [];
  if (values.length > 8) throw new Error("Save at most 8 quick-buy amounts");
  for (const value of values) {
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value))
      throw new Error("Use at most two decimal places");
    const [whole, fraction = ""] = value.split(".");
    const cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
    if (cents < 100n || cents > 100_000_000n)
      throw new Error("Each amount must be between 1 and 1,000,000 U");
  }
  return values;
}

export function UserSettings({
  onWallet,
  onToken,
}: {
  onWallet: (address: string) => void;
  onToken: (address: string) => void;
}) {
  const state = useUserState();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  function remove(kind: "FOLLOW" | "WATCHLIST", address: string) {
    setPending(`${kind}:${address}`);
    setError(null);
    void (kind === "FOLLOW" ? state.setFollow(address, false) : state.setWatchlist(address, false))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Save failed"))
      .finally(() => setPending(null));
  }
  return (
    <section className="panel user-settings">
      <h2>Settings</h2>
      {!state.authenticated ? (
        <p className="empty-state">Connect wallet to save settings.</p>
      ) : (
        <>
          {state.loading && <p role="status">Loading settings…</p>}
          {(state.error || error) && <p role="alert">{error ?? state.error}</p>}
          {state.error && (
            <button type="button" onClick={state.reload}>
              Reload settings
            </button>
          )}
          {!state.loading && !state.error && (
            <>
              <QuickAmounts />
              <h3>Followed wallets ({state.followed.size})</h3>
              {!state.followed.size && <p className="empty-state">No followed wallets</p>}
              <ul className="settings-list">
                {[...state.followed].map((address) => (
                  <li key={address}>
                    <button
                      type="button"
                      className="text-button"
                      title={address}
                      onClick={() => onWallet(address)}
                    >
                      {shortAddress(address)}
                    </button>
                    <span className="muted">{state.notes[address] || "No private note"}</span>
                    <button
                      type="button"
                      disabled={pending !== null}
                      onClick={() => remove("FOLLOW", address)}
                    >
                      Unfollow
                    </button>
                  </li>
                ))}
              </ul>
              <h3>Watchlist ({state.watchlist.size})</h3>
              {!state.watchlist.size && <p className="empty-state">No watchlist tokens</p>}
              <ul className="settings-list">
                {[...state.watchlist].map((address) => (
                  <li key={address}>
                    <button
                      type="button"
                      className="text-button"
                      title={address}
                      onClick={() => onToken(address)}
                    >
                      {shortAddress(address)}
                    </button>
                    <button
                      type="button"
                      disabled={pending !== null}
                      onClick={() => remove("WATCHLIST", address)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
function QuickAmounts() {
  const state = useUserState();
  const [text, setText] = useState(state.quickBuyAmounts.join(", "));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    let amounts: string[];
    try {
      amounts = parseQuickBuyAmounts(text);
    } catch (cause) {
      setError((cause as Error).message);
      return;
    }
    setSaving(true);
    void state
      .saveQuickBuyAmounts(amounts)
      .then(() => setMessage("Quick-buy amounts saved"))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Save failed"))
      .finally(() => setSaving(false));
  }
  return (
    <form onSubmit={submit} className="settings-form">
      <h3>Quick-buy amounts</h3>
      <label>
        Buy presets (U)
        <input
          aria-label="Buy presets"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setMessage(null);
          }}
          placeholder="10, 50, 100"
          disabled={saving}
        />
      </label>
      <p className="muted">
        Comma-separated, up to 8 values. Each value must be 1–1,000,000 U with at most two decimals.
        Leave empty to clear.
      </p>
      <button type="submit" disabled={saving}>
        {saving ? "Saving…" : "Save quick-buy amounts"}
      </button>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
    </form>
  );
}
