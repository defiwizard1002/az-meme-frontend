import { useEffect, useEffectEvent, useState, type ComponentProps } from "react";
import {
  PrivyProvider,
  usePrivy,
  useWallets,
  useAuthorizationSignature,
  useCreateWallet,
} from "@privy-io/react-auth";
import { arbitrumSepolia, robinhood } from "viem/chains";
import App from "./App";
import { configurePrivyTransport, type PrivyBatchRequest } from "./api";

export default function PrivyTrading({
  appId,
  clientId,
  chainId,
  onConnection,
}: {
  appId: string;
  clientId: string | null;
  chainId: number;
  onConnection?: (props: Partial<ComponentProps<typeof App>>) => void;
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
      <TradingSession chainId={chainId} onConnection={onConnection} />
    </PrivyProvider>
  );
}
function TradingSession({
  chainId,
  onConnection,
}: {
  chainId: number;
  onConnection?: (props: Partial<ComponentProps<typeof App>>) => void;
}) {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { generateAuthorizationSignature } = useAuthorizationSignature();
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
      accountId: address,
      getAccessToken,
      sign: async (request: PrivyBatchRequest) => {
        if (
          !linked?.id ||
          request.url !== `https://api.privy.io/v1/wallets/${linked.id}/rpc` ||
          request.body.caip2 !== `eip155:${chainId}` ||
          wallet.address.toLowerCase() !== address.toLowerCase()
        )
          throw new Error("批量请求与当前执行钱包不匹配");
        return (await generateAuthorizationSignature(request)).signature;
      },
    });
    setActive(true);
    return () => configurePrivyTransport(null);
  }, [
    authenticated,
    user,
    wallet,
    getAccessToken,
    generateAuthorizationSignature,
    chainId,
    linked,
  ]);
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
  const props: ComponentProps<typeof App> = {
    accountIdentity:
      authenticated && user ? user.id + (linked?.address.toLowerCase() ?? "") : "guest",
    privyWallet: connected ? wallet.address : undefined,
    walletRequired: true,
    connectionPending: pending,
    connectionStatus: status,
    connectionRetryable: slow || Boolean(error),
    connectionError: error,
    onConnect: () => {
      setError(null);
      if (!ready || !walletsReady) window.location.reload();
      else if (!authenticated) login();
      else if (linked) window.location.reload();
      else if (canonical?.length) setError("执行钱包绑定不唯一，请检查钱包账户");
      else
        void createWallet().catch((cause) =>
          setError(cause instanceof Error ? cause.message : String(cause)),
        );
    },
    onLogout: authenticated ? () => void logout() : undefined,
  };
  // SDK callback identities can change on every render; only publish connection changes.
  const publishConnection = useEffectEvent(() => onConnection?.(props));
  useEffect(() => {
    publishConnection();
  }, [
    onConnection,
    connected,
    pending,
    status,
    slow,
    error,
    authenticated,
    user?.id,
    linked?.address,
    ready,
    walletsReady,
  ]);
  return onConnection ? null : <App {...props} />;
}
