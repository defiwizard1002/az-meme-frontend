import { useEffect, useState } from "react";
import {
  PrivyProvider,
  usePrivy,
  useWallets,
  useSendTransaction,
  useCreateWallet,
} from "@privy-io/react-auth";
import { arbitrumSepolia, robinhood } from "viem/chains";
import App from "./App";
import { sendSponsoredTransaction } from "./privy-wallet";
import { configurePrivyTransport, type SponsoredTransaction } from "./api";

export default function PrivyTrading({
  appId,
  clientId,
  chainId,
}: {
  appId: string;
  clientId: string | null;
  chainId: number;
}) {
  const chain = [robinhood, arbitrumSepolia].find((c) => c.id === chainId);
  if (!chain) return <main className="notice">不支持的交易网络：{chainId}</main>;
  return (
    <PrivyProvider
      appId={appId}
      {...(clientId ? { clientId } : {})}
      config={{
        loginMethods: ["wallet"],
        supportedChains: [chain],
        defaultChain: chain,
        embeddedWallets: { showWalletUIs: false, ethereum: { createOnLogin: "all-users" } },
      }}
    >
      <TradingSession chainId={chainId} />
    </PrivyProvider>
  );
}
function TradingSession({ chainId }: { chainId: number }) {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { sendTransaction } = useSendTransaction();
  const { createWallet } = useCreateWallet();
  const [error, setError] = useState<string | null>(null);
  const embedded = wallets.filter((w) => w.walletClientType === "privy");
  const canonical = user?.linkedAccounts.filter(
    (a) => a.type === "wallet" && a.walletClientType === "privy" && a.chainType === "ethereum",
  );
  const linked = canonical?.length === 1 && canonical[0]?.type === "wallet" ? canonical[0] : null;
  const wallet = linked
    ? embedded.find((w) => w.address.toLowerCase() === linked.address.toLowerCase())
    : undefined;
  const [active, setActive] = useState(false);
  useEffect(() => {
    setActive(false);
    if (!authenticated || !wallet || !user) {
      configurePrivyTransport(null);
      return;
    }
    const address = wallet.address;
    configurePrivyTransport({
      getAccessToken,
      send: async (tx: SponsoredTransaction) => {
        return sendSponsoredTransaction(tx, address, chainId, sendTransaction);
      },
    });
    setActive(true);
    return () => configurePrivyTransport(null);
  }, [authenticated, user, wallet, getAccessToken, sendTransaction, chainId]);
  const connected = ready && walletsReady && authenticated && wallet && active;
  const pending = !ready || !walletsReady || (authenticated && !connected);
  const status = !ready
    ? "正在恢复登录会话"
    : !walletsReady || (authenticated && !wallet)
      ? "正在恢复执行钱包"
      : pending
        ? "正在连接钱包"
        : undefined;
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!pending) return;
    const timer = window.setTimeout(() => setSlow(true), 15_000);
    return () => window.clearTimeout(timer);
  }, [pending]);
  useEffect(() => {
    performance.mark(`wallet:${status ?? (connected ? "ready" : "guest")}`);
  }, [status, connected]);
  return (
    <App
      key={authenticated && user ? user.id + (linked?.address.toLowerCase() ?? "") : "guest"}
      privyWallet={connected ? wallet.address : undefined}
      walletRequired
      connectionPending={pending}
      connectionStatus={status}
      connectionRetryable={slow || Boolean(error)}
      connectionError={error}
      onConnect={() => {
        setError(null);
        if (!ready || !walletsReady) window.location.reload();
        else if (!authenticated) login();
        else if (linked) window.location.reload();
        else if (canonical?.length) setError("执行钱包绑定不唯一，请检查钱包账户");
        else
          void createWallet().catch((cause) =>
            setError(cause instanceof Error ? cause.message : String(cause)),
          );
      }}
      onLogout={authenticated ? () => void logout() : undefined}
    />
  );
}
