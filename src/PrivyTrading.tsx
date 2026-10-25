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
  const connected = ready && walletsReady && authenticated && wallet && active;
  return (
    <App
      key={connected ? user!.id + wallet.address : "guest"}
      privyWallet={connected ? wallet.address : undefined}
      walletRequired
      connectionPending={!ready || !walletsReady || (authenticated && Boolean(wallet) && !active)}
      connectionError={error}
      onConnect={() => {
        if (!authenticated) login();
        else
          void createWallet().catch((cause) =>
            setError(cause instanceof Error ? cause.message : String(cause)),
          );
      }}
      onLogout={authenticated ? () => void logout() : undefined}
    />
  );
}
