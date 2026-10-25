import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import PrivyTrading from "./PrivyTrading";
const state = vi.hoisted(() => ({
  ready: true,
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
  PrivyProvider: ({ children }: { children: React.ReactNode }) => children,
  usePrivy: () => ({ ...state, logout: vi.fn(), getAccessToken: vi.fn() }),
  useWallets: () => ({ ready: state.ready, wallets: state.authenticated ? [state.wallet] : [] }),
  useSendTransaction: () => ({ sendTransaction: vi.fn() }),
  useCreateWallet: () => ({ createWallet: vi.fn() }),
}));
vi.mock("./App", () => ({
  default: (props: { privyWallet?: string; onConnect?: () => void }) => (
    <main>
      <h1>行情终端</h1>
      <span>{props.privyWallet ?? "访客"}</span>
      <button onClick={props.onConnect}>连接钱包</button>
    </main>
  ),
}));
afterEach(() => {
  cleanup();
  state.ready = true;
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
