import { useCallback, useEffect, useMemo, useState, type ComponentProps } from "react";
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

  const connect = useCallback(async (): Promise<boolean> => {
    if (!provider) {
      setPending(false);
      setError("未检测到浏览器钱包，请先安装并解锁钱包扩展");
      return false;
    }
    setPending(true);
    setError(undefined);
    try {
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const next = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : null;
      if (!next) throw new Error("钱包没有返回账户地址");
      await authenticateWallet(next, provider);
      setAddress(next);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
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
    const onAccountsChanged = (accounts: unknown) => {
      const next =
        Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : undefined;
      if (!next) {
        clearSessionToken();
        setAddress(undefined);
        setPending(false);
        return;
      }
      setAddress(undefined);
      void connectFor(next);
    };
    const connectFor = async (next: string) => {
      setPending(true);
      try {
        await authenticateWallet(next, provider);
        setAddress(next);
        setError(undefined);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setPending(false);
      }
    };
    provider.on?.("accountsChanged", onAccountsChanged);
    void provider
      .request({ method: "eth_accounts" })
      .then((accounts) => {
        const next =
          Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : undefined;
        if (next) return connectFor(next);
        setPending(false);
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
