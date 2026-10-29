import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WalletTrading from "./WalletTrading";
import { authenticateWallet, clearSessionToken } from "./api";

vi.mock("./api", () => ({
  authenticateWallet: vi.fn(),
  clearSessionToken: vi.fn(),
  configureServerSignedTransactions: vi.fn(),
}));

vi.mock("./App", () => ({
  default: (props: {
    walletAddress?: string;
    connectionError?: string;
    onConnect?: () => Promise<boolean> | void;
  }) => (
    <div>
      <button type="button" onClick={() => void props.onConnect?.()}>
        连接钱包
      </button>
      <span data-testid="wallet-address">{props.walletAddress ?? ""}</span>
      <span data-testid="wallet-error">{props.connectionError ?? ""}</span>
    </div>
  ),
}));

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

beforeEach(() => {
  provider = providerFixture();
  Object.defineProperty(window, "ethereum", { configurable: true, value: provider });
  vi.mocked(authenticateWallet).mockReset();
  vi.mocked(authenticateWallet).mockResolvedValue(undefined);
  vi.mocked(clearSessionToken).mockClear();
});

afterEach(() => {
  cleanup();
  delete (window as Window & { ethereum?: unknown }).ethereum;
  vi.restoreAllMocks();
});

describe("WalletTrading wallet authentication", () => {
  it("only syncs the initial and changed account without signing", async () => {
    render(<WalletTrading />);

    await waitFor(() => expect(provider.request).toHaveBeenCalledWith({ method: "eth_accounts" }));
    expect(screen.getByTestId("wallet-address")).toHaveTextContent("");
    expect(vi.mocked(authenticateWallet)).not.toHaveBeenCalled();

    provider.emit("accountsChanged", [address]);
    expect(screen.getByTestId("wallet-address")).toHaveTextContent("");
    expect(vi.mocked(authenticateWallet)).not.toHaveBeenCalled();
  });

  it("authenticates once when the user clicks connect twice while busy", async () => {
    let resolveAuthentication!: () => void;
    vi.mocked(authenticateWallet).mockImplementation(
      () => new Promise<void>((resolve) => (resolveAuthentication = resolve)),
    );
    render(<WalletTrading />);
    await waitFor(() => expect(provider.request).toHaveBeenCalledWith({ method: "eth_accounts" }));

    const connect = screen.getByRole("button", { name: "连接钱包" });
    fireEvent.click(connect);
    fireEvent.click(connect);

    await waitFor(() => expect(vi.mocked(authenticateWallet)).toHaveBeenCalledTimes(1));
    expect(provider.request).toHaveBeenCalledWith({ method: "eth_requestAccounts" });
    expect(vi.mocked(authenticateWallet)).toHaveBeenCalledWith(address, provider);
    resolveAuthentication();
  });
});
