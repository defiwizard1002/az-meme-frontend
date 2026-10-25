import { useEffect, useRef, useState } from "react";

export function WalletAssets({
  balances,
  error,
  onTransfer,
}: {
  balances: Array<{ asset: string; available: string }> | undefined;
  error: string | null;
  onTransfer?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div ref={root} className="wallet-assets">
      <button
        ref={trigger}
        type="button"
        className="icon-button wallet-trigger"
        aria-label="钱包资产"
        title="钱包资产"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="wallet-assets-panel"
        onClick={() => setOpen(!open)}
      >
        <svg
          viewBox="0 0 24 24"
          width="19"
          height="19"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <path d="M20 8V5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h15V8H5a1 1 0 0 1 0-2M20 12h-5v5h5M17 14.5h.01" />
        </svg>
      </button>
      {open && (
        <div
          ref={panel}
          id="wallet-assets-panel"
          className="wallet-panel"
          role="dialog"
          aria-label="钱包资产"
          tabIndex={-1}
        >
          <strong>钱包资产</strong>
          {error ? (
            <p role="status">{error}</p>
          ) : !balances ? (
            <p role="status">余额加载中</p>
          ) : (
            <dl>
              {balances.map((item) => (
                <div key={item.asset}>
                  <dt>{item.asset}</dt>
                  <dd title={item.available}>{item.available}</dd>
                </div>
              ))}
            </dl>
          )}
          {onTransfer && (
            <button
              type="button"
              disabled={!!error || !balances}
              onClick={() => {
                setOpen(false);
                onTransfer();
              }}
            >
              账户划转
            </button>
          )}
        </div>
      )}
    </div>
  );
}
