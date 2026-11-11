import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WalletTrading from "./WalletTrading";
import { authenticateWallet, clearSessionToken, restoreWalletSession } from "./api";

vi.mock("./api", () => ({
  authenticateWallet: vi.fn(),
  clearSessionToken: vi.fn(),
  restoreWalletSession: vi.fn(),
  configureServerSignedTransactions: vi.fn(),
}));

vi.mock("./App", () => ({
  default: (props: {
    walletAddress?: string;
    accountIdentity?: string;
    onLogout?: () => void;
    connectionError?: string;
    onConnect?: () => Promise<boolean> | void;
  }) => (
    <div>
      <button type="button" onClick={() => void props.onConnect?.()}>
        连接钱包
      </button>
      <button onClick={props.onLogout}>退出</button>
      <span data-testid="user-id">{props.accountIdentity ?? ""}</span>
      <span data-testid="wallet-address">{props.walletAddress ?? ""}</span>
      <span data-testid="wallet-error">{props.connectionError ?? ""}</span>
    </div>
  ),
}));

const tradingAddress = "0x2222222222222222222222222222222222222222";
const address = "0x1111111111111111111111111111111111111111";

function providerFixture() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const provider = {
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [address];
      throw new Error(`Unexpected provider method ${method}`);
    }),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
    }),
    removeListener: vi.fn((event: string) => {
      listeners.delete(event);
    }),
    emit(event: string, value: unknown) {
      listeners.get(event)?.(value);
    },
  };
  return provider;
}

let provider: ReturnType<typeof providerFixture>;

const prepareScenario1 = () => {
  provider = providerFixture();
  Object.defineProperty(window, "ethereum", { configurable: true, value: provider });
  vi.mocked(authenticateWallet).mockReset();
  vi.mocked(authenticateWallet).mockResolvedValue(undefined);
  vi.mocked(clearSessionToken).mockClear();
  vi.mocked(restoreWalletSession).mockReset();
  vi.mocked(restoreWalletSession).mockResolvedValue(null);
};
beforeEach(prepareScenario1);

const cleanScenario2 = () => {
  cleanup();
  delete (window as Window & { ethereum?: unknown }).ethereum;
  vi.restoreAllMocks();
};
afterEach(cleanScenario2);

describe("WalletTrading wallet authentication", () => {
  it("WalletTrading explicit login, session restoration and account isolation", async () => {
    // only syncs the initial and changed account without signing
    await (async () => {
      render(<WalletTrading />);

      await waitFor(() =>
        expect(provider.request).toHaveBeenCalledWith({ method: "eth_accounts" }),
      );
      expect(screen.getByTestId("wallet-address")).toHaveTextContent("");
      expect(vi.mocked(authenticateWallet)).not.toHaveBeenCalled();

      provider.emit("accountsChanged", [address]);
      expect(screen.getByTestId("wallet-address")).toHaveTextContent("");
      expect(vi.mocked(authenticateWallet)).not.toHaveBeenCalled();
    })();
    await cleanScenario2();
    await prepareScenario1();
    // authenticates once when the user clicks connect twice while busy
    await (async () => {
      let resolveAuthentication!: () => void;
      vi.mocked(authenticateWallet).mockImplementation(
        () => new Promise<void>((resolve) => (resolveAuthentication = resolve)),
      );
      render(<WalletTrading />);
      await waitFor(() =>
        expect(provider.request).toHaveBeenCalledWith({ method: "eth_accounts" }),
      );

      const connect = screen.getByRole("button", { name: "连接钱包" });
      fireEvent.click(connect);
      fireEvent.click(connect);

      await waitFor(() => expect(vi.mocked(authenticateWallet)).toHaveBeenCalledTimes(1));
      expect(provider.request).toHaveBeenCalledWith({ method: "eth_requestAccounts" });
      expect(vi.mocked(authenticateWallet)).toHaveBeenCalledWith(address, provider);
      vi.mocked(restoreWalletSession).mockResolvedValue({
        userId: "privy-user",
        accountId: tradingAddress,
        loginAddress: address,
      });
      await act(async () => resolveAuthentication());
      expect(screen.getByTestId("wallet-address")).toHaveTextContent(tradingAddress);
      expect(screen.getByTestId("user-id")).toHaveTextContent("privy-user");
    })();
    await cleanScenario2();
    await prepareScenario1();
    // Reload restores only the authenticated server account, without another signature.
    vi.mocked(restoreWalletSession).mockResolvedValue({
      userId: "privy-user",
      accountId: tradingAddress,
      loginAddress: address,
    });
    render(<WalletTrading />);
    await waitFor(() =>
      expect(screen.getByTestId("wallet-address")).toHaveTextContent(tradingAddress),
    );
    expect(screen.getByTestId("user-id")).toHaveTextContent("privy-user");
    expect(authenticateWallet).not.toHaveBeenCalled();
    expect(provider.request).not.toHaveBeenCalledWith({ method: "eth_requestAccounts" });
    fireEvent.click(screen.getByRole("button", { name: "退出" }));
    expect(clearSessionToken).toHaveBeenCalled();
    expect(screen.getByTestId("wallet-address")).toBeEmptyDOMElement();
    expect(screen.getByTestId("user-id")).toBeEmptyDOMElement();
    await cleanScenario2();
    await prepareScenario1();
    // An account change while reload validation is pending cannot restore the old user's UI.
    let finishRestore!: (value: Awaited<ReturnType<typeof restoreWalletSession>>) => void;
    vi.mocked(restoreWalletSession).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRestore = resolve;
        }),
    );
    render(<WalletTrading />);
    await waitFor(() => expect(restoreWalletSession).toHaveBeenCalledWith(address));
    await act(async () => provider.emit("accountsChanged", [tradingAddress]));
    await act(async () =>
      finishRestore({ userId: "old-user", accountId: tradingAddress, loginAddress: address }),
    );
    expect(screen.getByTestId("wallet-address")).toBeEmptyDOMElement();
    expect(screen.getByTestId("user-id")).toBeEmptyDOMElement();
    expect(clearSessionToken).toHaveBeenCalled();
    expect(authenticateWallet).not.toHaveBeenCalled();
  });
});
