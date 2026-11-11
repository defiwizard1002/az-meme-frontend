import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import App from "./App";
import {
  authenticateWallet,
  clearSessionToken,
  configureServerSignedTransactions,
  restoreWalletSession,
  type WalletSession,
  type WalletProvider,
} from "./api";

declare global {
  interface Window {
    ethereum?: WalletProvider;
  }
}

export default function WalletTrading({
  serverSignedTransactions = false,
  onConnection,
}: {
  serverSignedTransactions?: boolean;
  onConnection?: (props: Partial<ComponentProps<typeof App>>) => void;
}) {
  const provider = typeof window === "undefined" ? undefined : window.ethereum;
  const [session, setSession] = useState<WalletSession | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string>();
  const connectingRef = useRef(false);
  const identityVersion = useRef(0);
  const detectedAddressRef = useRef<string | undefined>(undefined);

  const connect = useCallback(async (): Promise<boolean> => {
    if (connectingRef.current) return false;
    if (!provider) {
      setPending(false);
      setError("未检测到浏览器钱包，请先安装并解锁钱包扩展");
      return false;
    }
    connectingRef.current = true;
    setPending(true);
    setError(undefined);
    try {
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const next = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : null;
      if (!next) throw new Error("钱包没有返回账户地址");
      if (detectedAddressRef.current?.toLowerCase() !== next.toLowerCase()) {
        clearSessionToken();
        detectedAddressRef.current = next;
      }
      const version = ++identityVersion.current;
      await authenticateWallet(next, provider);
      const authenticated = await restoreWalletSession(next);
      if (version !== identityVersion.current || !authenticated) {
        clearSessionToken();
        return false;
      }
      setSession(authenticated);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      connectingRef.current = false;
      setPending(false);
    }
  }, [provider]);

  useEffect(() => {
    configureServerSignedTransactions(serverSignedTransactions);
    if (!provider) {
      setPending(false);
      setError("未检测到浏览器钱包，请先安装并解锁钱包扩展");
      return;
    }
    let active = true;
    const syncAddress = async (accounts: unknown) => {
      const version = ++identityVersion.current;
      const next =
        Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : undefined;
      if (
        !next ||
        (detectedAddressRef.current &&
          detectedAddressRef.current.toLowerCase() !== next.toLowerCase())
      ) {
        clearSessionToken();
        setSession(null);
      }
      detectedAddressRef.current = next;
      setError(undefined);
      if (next) {
        const restored = await restoreWalletSession(next);
        if (!active || version !== identityVersion.current) return;
        setSession(restored);
      }
      setPending(false);
    };
    const sync = (accounts: unknown) => {
      void syncAddress(accounts).catch((cause) => {
        if (!active) return;
        setPending(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    };
    provider.on?.("accountsChanged", sync);
    void provider
      .request({ method: "eth_accounts" })
      .then(sync)
      .catch((cause) => {
        if (!active) return;
        setPending(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
      provider.removeListener?.("accountsChanged", sync);
    };
  }, [provider, serverSignedTransactions]);

  const props = useMemo<ComponentProps<typeof App>>(
    () => ({
      walletRequired: true,
      walletAddress: session?.accountId,
      accountIdentity: session?.userId,
      connectionPending: pending,
      connectionStatus: pending ? "正在连接浏览器钱包" : undefined,
      connectionRetryable: Boolean(error),
      connectionError: error,
      onConnect: connect,
      onLogout: () => {
        clearSessionToken();
        ++identityVersion.current;
        setSession(null);
      },
    }),
    [session, pending, error, connect],
  );
  useEffect(() => onConnection?.(props), [onConnection, props]);
  return onConnection ? null : <App {...props} />;
}
