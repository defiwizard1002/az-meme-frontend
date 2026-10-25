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
        embeddedWallets: { ethereum: { createOnLogin: "all-users" } },
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
  if (!ready || !walletsReady) return <main className="notice">正在连接 Privy…</main>;
  if (!authenticated)
    return (
      <main className="notice">
        <h1>内部共享资金交易</h1>
        <p>
          连接外部钱包登录后，Privy 会生成独立交易钱包。共享 USDG 用于买入，买到的代币归你的 Privy
          钱包；卖出所得回到共享资金池。交易手续费由应用赞助。
        </p>
        <button onClick={login}>连接登录钱包</button>
      </main>
    );
  if (!wallet || !active)
    return (
      <main className="notice">
        <p>{error ?? "正在创建并连接 Privy 交易钱包…"}</p>
        <button
          onClick={() =>
            void createWallet().catch((cause) =>
              setError(cause instanceof Error ? cause.message : String(cause)),
            )
          }
        >
          创建交易钱包
        </button>
        <button onClick={() => void logout()}>退出</button>
      </main>
    );
  return (
    <App
      key={user!.id + wallet.address}
      privyWallet={wallet.address}
      onLogout={() => void logout()}
    />
  );
}
