import { lazy, Suspense, useEffect, useState, type ComponentProps } from "react";
import App from "./App";
import { memeApi } from "./api";
const PrivyTrading = lazy(() => import("./PrivyTrading"));
export default function Entry() {
  const [config, setConfig] = useState<Awaited<ReturnType<typeof memeApi.getConfig>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void memeApi
      .getConfig()
      .then(setConfig)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);
  const [connection, setConnection] = useState<Partial<ComponentProps<typeof App>>>({});
  return (
    <>
      <App
        walletRequired={!config || Boolean(config.privy)}
        connectionPending={!config || Boolean(config.privy)}
        connectionStatus="正在加载钱包组件"
        {...connection}
        {...(error ? { connectionError: error, connectionRetryable: true } : {})}
      />
      {config?.privy && (
        <Suspense fallback={null}>
          <PrivyTrading {...config.privy} chainId={config.chainId} onConnection={setConnection} />
        </Suspense>
      )}
    </>
  );
}
