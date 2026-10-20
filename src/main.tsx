import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { lazy, Suspense, useEffect, useState } from "react";
import { memeApi } from "./api";
const PrivyTrading = lazy(() => import("./PrivyTrading"));
function Entry() {
  const [config, setConfig] = useState<Awaited<ReturnType<typeof memeApi.getConfig>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void memeApi
      .getConfig()
      .then(setConfig)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);
  if (error)
    return (
      <main className="notice">
        {error}
        <button onClick={() => location.reload()}>重试</button>
      </main>
    );
  if (!config) return <main className="notice">正在连接…</main>;
  return config.privy ? (
    <Suspense fallback={<main className="notice">正在加载登录…</main>}>
      <PrivyTrading {...config.privy} />
    </Suspense>
  ) : (
    <App />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Entry />
  </StrictMode>,
);
