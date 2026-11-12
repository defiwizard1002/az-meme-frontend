import { useState } from "react";
import { shortAddress } from "./display";
import { useUserState } from "./user-state";

export function parseQuickBuyAmounts(text: string): string[] {
  const values = text.trim() ? text.split(/[,，\s]+/).filter(Boolean) : [];
  if (values.length > 8) throw new Error("最多保存 8 个快捷买入金额");
  for (const value of values) {
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) throw new Error("金额最多两位小数");
    const [whole, fraction = ""] = value.split(".");
    const cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
    if (cents < 100n || cents > 100_000_000n) throw new Error("每个金额须为 1–1,000,000 U");
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
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "保存失败"))
      .finally(() => setPending(null));
  }
  return (
    <section className="panel user-settings">
      <h2>用户设置</h2>
      {!state.authenticated ? (
        <p className="empty-state">连接钱包后可保存设置。</p>
      ) : (
        <>
          {state.loading && <p role="status">正在读取设置…</p>}
          {(state.error || error) && <p role="alert">{error ?? state.error}</p>}
          {state.error && (
            <button type="button" onClick={state.reload}>
              重新读取设置
            </button>
          )}
          {!state.loading && !state.error && (
            <>
              <QuickAmounts />
              <h3>关注钱包 ({state.followed.size})</h3>
              {!state.followed.size && <p className="empty-state">尚未关注钱包</p>}
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
                    <span className="muted">{state.notes[address] || "无私有备注"}</span>
                    <button
                      type="button"
                      disabled={pending !== null}
                      onClick={() => remove("FOLLOW", address)}
                    >
                      取消关注
                    </button>
                  </li>
                ))}
              </ul>
              <h3>自选代币 ({state.watchlist.size})</h3>
              {!state.watchlist.size && <p className="empty-state">尚未添加自选</p>}
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
                      移除自选
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
      .then(() => setMessage("快捷金额已保存"))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "保存失败"))
      .finally(() => setSaving(false));
  }
  return (
    <form onSubmit={submit} className="settings-form">
      <h3>快捷买入金额</h3>
      <label>
        买入预设 (U)
        <input
          aria-label="买入预设"
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
        用逗号分隔，最多 8 个；每个 1–1,000,000 U，最多两位小数。留空可清除预设。
      </p>
      <button type="submit" disabled={saving}>
        {saving ? "保存中…" : "保存快捷金额"}
      </button>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
    </form>
  );
}
