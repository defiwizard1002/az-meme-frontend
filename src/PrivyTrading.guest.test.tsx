import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import PrivyTrading from "./PrivyTrading";
const state = vi.hoisted(() => ({
  ready: true,
  walletReady: true,
  walletLoaded: true,
  create: vi.fn(),
  reload: vi.fn(),
  provider: vi.fn(),
  authenticated: false,
  login: vi.fn(),
  wallet: { address: "0x123", walletClientType: "privy" },
  user: {
    id: "one",
    linkedAccounts: [
      { type: "wallet", walletClientType: "privy", chainType: "ethereum", address: "0x123" },
    ],
  },
}));
vi.mock("@privy-io/react-auth", () => ({
  PrivyProvider: ({ children, config }: { children: React.ReactNode; config: unknown }) => {
    state.provider(config);
    return children;
  },
  usePrivy: () => ({ ...state, logout: vi.fn(), getAccessToken: vi.fn() }),
  useWallets: () => ({
    ready: state.walletReady,
    wallets: state.authenticated && state.walletLoaded ? [state.wallet] : [],
  }),
  useSendTransaction: () => ({ sendTransaction: vi.fn() }),
  useCreateWallet: () => ({ createWallet: state.create }),
}));
vi.mock("./App", () => ({
  default: (props: {
    privyWallet?: string;
    onConnect?: () => void;
    connectionPending?: boolean;
    connectionStatus?: string;
    connectionRetryable?: boolean;
  }) => (
    <main>
      <h1>行情终端</h1>
      <span>{props.privyWallet ?? "访客"}</span>
      <span>{props.connectionPending ? props.connectionStatus : "ready"}</span>
      <span>{props.connectionRetryable ? "retryable" : "waiting"}</span>
      <button onClick={props.onConnect}>连接钱包</button>
    </main>
  ),
}));
afterEach(() => {
  cleanup();
  state.ready = true;
  state.walletReady = true;
  state.walletLoaded = true;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  state.authenticated = false;
  vi.clearAllMocks();
});
it("keeps the terminal visible before login and opens normal login", () => {
  render(<PrivyTrading appId="test" clientId={null} chainId={4663} />);
  expect(screen.getByText("行情终端")).toBeTruthy();
  fireEvent.click(screen.getByText("连接钱包"));
  expect(state.login).toHaveBeenCalledOnce();
});
it("keeps the terminal visible while the SDK is loading", () => {
  state.ready = false;
  render(<PrivyTrading appId="test" clientId={null} chainId={4663} />);
  expect(screen.getByText("行情终端")).toBeTruthy();
});
it("removes the account identity after logout without hiding market UI", () => {
  state.authenticated = true;
  const view = render(<PrivyTrading appId="test" clientId={null} chainId={4663} />);
  expect(screen.getByText("0x123")).toBeTruthy();
  state.authenticated = false;
  view.rerender(<PrivyTrading appId="test" clientId={null} chainId={4663} />);
  expect(screen.queryByText("0x123")).toBeNull();
  expect(screen.getByText("行情终端")).toBeTruthy();
});

it("restores the canonical linked wallet late without creating another and enables retry on timeout", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("location", { reload: state.reload });
  state.authenticated = true;
  state.walletLoaded = false;
  const view = render(<PrivyTrading appId="test" clientId={null} chainId={4663} />);
  expect(screen.getByText("正在恢复执行钱包")).toBeTruthy();
  await act(() => vi.advanceTimersByTimeAsync(15000));
  expect(screen.getByText("retryable")).toBeTruthy();
  fireEvent.click(screen.getByText("连接钱包"));
  expect(state.create).not.toHaveBeenCalled();
  expect(state.reload).toHaveBeenCalledOnce();
  state.walletLoaded = true;
  view.rerender(<PrivyTrading appId="test" clientId={null} chainId={4663} />);
  expect(screen.getByText("0x123")).toBeTruthy();
  expect(state.provider).toHaveBeenLastCalledWith(
    expect.objectContaining({
      embeddedWallets: { showWalletUIs: false, ethereum: { createOnLogin: "all-users" } },
    }),
  );
});
