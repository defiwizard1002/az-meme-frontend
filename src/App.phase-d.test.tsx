import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ getConfig: vi.fn(), getToken: vi.fn(), getAccount: vi.fn() }));
vi.mock("./api", () => ({ memeApi: api }));
vi.mock("./wallet-api", () => ({
  walletApi: { positions: vi.fn().mockResolvedValue({ items: [], nextCursor: null }) },
}));
vi.mock("./user-state", () => ({
  UserStateProvider: ({ children }: any) => children,
  useUserState: () => ({ followed: new Set(), watchlist: new Set(), authenticated: false }),
}));
vi.mock("./Discover", () => ({
  default: ({ compact, onToken }: any) =>
    compact ? (
      <button onClick={() => onToken({ tokenAddress: `0x${"3".repeat(40)}`, symbol: "TOKEN C" })}>
        Rail token
      </button>
    ) : (
      <div>Discover public</div>
    ),
}));
vi.mock("./ActivityFeed", () => ({ ActivityRibbon: () => null, ActivityFeed: () => null }));
vi.mock("./WalletProfile", () => ({ WalletProfile: () => null }));
vi.mock("./UserSettings", () => ({ UserSettings: () => null }));
vi.mock("./Portfolio", () => ({ Portfolio: () => null }));
vi.mock("./TradingPanel", () => ({ TradingPanel: () => null }));
vi.mock("./TokenDetails", () => ({ TokenDetails: ({ token }: any) => <div>{token.symbol}</div> }));
import App from "./App";
const prepareScenario1 = () => {
  window.location.hash = "";
  vi.clearAllMocks();
  api.getConfig.mockResolvedValue({ explorerBaseUrl: "" });
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
};
beforeEach(prepareScenario1);
const cleanScenario2 = () => {
  cleanup();
  vi.restoreAllMocks();
};
afterEach(cleanScenario2);
it("App.phase-d: 2 related scenarios", async () => {
  // keeps public discovery available when account loading fails
  await (async () => {
    api.getAccount.mockRejectedValue(new Error("account unavailable"));
    render(<App walletAddress={`0x${"1".repeat(40)}`} />);
    expect(screen.getByText("Discover public")).toBeInTheDocument();
    expect(await screen.findByText(/账户读取失败/)).toBeInTheDocument();
    expect(screen.getByText("Discover public")).toBeInTheDocument();
  })();
  await cleanScenario2();
  await prepareScenario1();
  // ignores an old token response after navigation
  await (async () => {
    const a = `0x${"1".repeat(40)}`,
      b = `0x${"2".repeat(40)}`;
    let resolveA!: (value: any) => void;
    api.getToken.mockImplementation((address: string) =>
      address === a
        ? new Promise((resolve) => {
            resolveA = resolve;
          })
        : Promise.resolve({ tokenAddress: b, symbol: "TOKEN B" }),
    );
    window.location.hash = `token/${a}`;
    render(<App />);
    await waitFor(() => expect(api.getToken).toHaveBeenCalledWith(a));
    act(() => {
      window.location.hash = `token/${b}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(await screen.findByText("TOKEN B")).toBeInTheDocument();
    await act(async () => resolveA({ tokenAddress: a, symbol: "TOKEN A" }));
    expect(screen.getByRole("button", { name: "Rail token" })).toBeInTheDocument();
    expect(screen.queryByText("TOKEN A")).not.toBeInTheDocument();
    expect(screen.getByText("TOKEN B")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rail token" }));
    expect(window.location.hash).toBe(`#token/0x${"3".repeat(40)}`);
  })();
});
