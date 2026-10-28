import { useEffect, useState } from "react";
import WalletTrading from "./WalletTrading";
import { memeApi } from "./api";

export default function Entry() {
  const [config, setConfig] = useState<Awaited<ReturnType<typeof memeApi.getConfig>> | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    void memeApi
      .getConfig()
      .then((value) => {
        setConfig(value);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);
  if (error)
    return <WalletTrading />;
  return (
    <WalletTrading
      serverSignedTransactions={Boolean(config?.serverSignedTransactions)}
    />
  );
}
