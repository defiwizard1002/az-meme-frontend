import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import App from "./App";
import {
  authenticateWallet,
  clearSessionToken,
  configureServerSignedTransactions,
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
  const [address, setAddress] = useState<string>();
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string>();
  const connectingRef = useRef(false);
  const addressRef = useRef<string | undefined>(undefined);

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
      if (addressRef.current?.toLowerCase() !== next.toLowerCase()) {
        clearSessionToken();
        addressRef.current = next;
        setAddress(next);
      }
      await authenticateWallet(next, provider);
      if (addressRef.current?.toLowerCase() !== next.toLowerCase()) {
        clearSessionToken();
        return false;
      }
      setAddress(next);
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
    const syncAddress = (accounts: unknown) => {
      const next =
        Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : undefined;
      if (!next) {
        clearSessionToken();
        addressRef.current = undefined;
        setAddress(undefined);
        setPending(false);
        setError(undefined);
        return;
      }
      if (addressRef.current && addressRef.current.toLowerCase() !== next.toLowerCase()) {
        clearSessionToken();
      }
      addressRef.current = next;
      setAddress(next);
      setPending(false);
      setError(undefined);
    };
    const onAccountsChanged = (accounts: unknown) => syncAddress(accounts);
    provider.on?.("accountsChanged", onAccountsChanged);
    void provider
      .request({ method: "eth_accounts" })
      .then((accounts) => {
        syncAddress(accounts);
      })
      .catch((cause) => {
        setPending(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => provider.removeListener?.("accountsChanged", onAccountsChanged);
  }, [provider, serverSignedTransactions]);

  const props = useMemo<ComponentProps<typeof App>>(
    () => ({
      walletRequired: true,
      walletAddress: address,
      accountIdentity: address,
      connectionPending: pending,
      connectionStatus: pending ? "正在连接浏览器钱包" : undefined,
      connectionRetryable: Boolean(error),
      connectionError: error,
      onConnect: connect,
      onLogout: () => {
        clearSessionToken();
        setAddress(undefined);
      },
    }),
    [address, pending, error, connect],
  );
  useEffect(() => onConnection?.(props), [onConnection, props]);
  return onConnection ? null : <App {...props} />;
}
