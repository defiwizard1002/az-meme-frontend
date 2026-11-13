import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ActivityFeed } from "./ActivityFeed";
import { WalletProfile } from "./WalletProfile";
import { UserStateProvider, useUserState } from "./user-state";
import { parseQuickBuyAmounts, UserSettings } from "./UserSettings";
import { walletApi } from "./wallet-api";
import type { ActivityPage, WalletProfileData } from "./wallet-types";

vi.mock("./wallet-api", () => ({
  walletApi: {
    profile: vi.fn(),
    positions: vi.fn(),
    activities: vi.fn(),
    feed: vi.fn(),
    state: vi.fn(),
    saveState: vi.fn(),
    deleteState: vi.fn(),
  },
}));
const address = `0x${"1".repeat(40)}`;
const token = `0x${"2".repeat(40)}`;
const emptyPage = { items: [], nextCursor: null };
const prepareScenario1 = () => {
  vi.resetAllMocks();
  vi.mocked(walletApi.state).mockResolvedValue(emptyPage);
  vi.mocked(walletApi.positions).mockResolvedValue(emptyPage);
  vi.mocked(walletApi.activities).mockResolvedValue(emptyPage);
  vi.mocked(walletApi.feed).mockResolvedValue(emptyPage);
  vi.mocked(walletApi.saveState).mockResolvedValue({ saved: true });
};
beforeEach(prepareScenario1);
const cleanScenario2 = () => {
  cleanup();
  vi.restoreAllMocks();
};
afterEach(cleanScenario2);

it("wallet-phase-d: 4 related scenarios", async () => {
  // validates quick amounts independently from trade maximum and retains exact decimals
  await (async () => {
    expect(parseQuickBuyAmounts("1, 12.25, 1000000")).toEqual(["1", "12.25", "1000000"]);
    expect(parseQuickBuyAmounts("")).toEqual([]);
    for (const text of ["0.99", "1000000.01", "12.345", "1e3", "-1", "1,2,3,4,5,6,7,8,9"])
      expect(() => parseQuickBuyAmounts(text)).toThrow();
  })();
  await cleanScenario2();
  await prepareScenario1();
  // discards private state from the previous account even when its request resolves late
  await (async () => {
    const oldPage = { items: [{ target: address, value: {}, updatedAt: 1 }], nextCursor: null };
    vi.mocked(walletApi.state).mockImplementation(async (kind) =>
      kind === "FOLLOW" ? oldPage : emptyPage,
    );
    function State() {
      const state = useUserState();
      return (
        <div>
          <span>{[...state.followed].join(",") || "No follows"}</span>
          <button type="button" onClick={state.reload}>
            Reload
          </button>
        </div>
      );
    }
    const view = render(
      <UserStateProvider userId="first">
        <State />
      </UserStateProvider>,
    );
    await screen.findByText(address);
    await waitFor(() => expect(walletApi.state).toHaveBeenCalledTimes(4));
    const resolveOld: Array<() => void> = [];
    vi.mocked(walletApi.state).mockImplementation(
      (kind) =>
        new Promise((resolve) => {
          resolveOld.push(() => resolve(kind === "FOLLOW" ? oldPage : emptyPage));
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(walletApi.state).toHaveBeenCalledTimes(8));
    vi.mocked(walletApi.state).mockResolvedValue(emptyPage);
    view.rerender(
      <UserStateProvider userId="second">
        <State />
      </UserStateProvider>,
    );
    expect(screen.queryByText(address)).not.toBeInTheDocument();
    await waitFor(() => expect(walletApi.state).toHaveBeenCalledTimes(12));
    await act(async () => {
      for (const resolve of resolveOld) resolve();
    });
    expect(screen.getByText("No follows")).toBeVisible();
    expect(screen.queryByText(address)).not.toBeInTheDocument();
  })();
  await cleanScenario2();
  await prepareScenario1();
  // shows incomplete profile statistics as unknown and uses position cursors
  await (async () => {
    vi.mocked(walletApi.profile).mockResolvedValue({
      address,
      chainId: 4663,
      name: null,
      avatarUrl: null,
      xUrl: null,
      labels: [],
      trackingStatus: "PENDING_SNAPSHOT",
      coverage: "UNKNOWN",
      coverageMs: null,
      trackingStartedAt: null,
      stats: null,
      statsAt: null,
      window: null,
      windowComplete: false,
      unrealizedPnlUsd: null,
      own: false,
      trackingRequestedAt: null,
      snapshotBlock: null,
      snapshotHash: null,
      processedBlock: null,
      gapCount: 0,
      source: "LOCAL",
    } satisfies WalletProfileData);
    vi.mocked(walletApi.positions)
      .mockResolvedValueOnce({ items: [], nextCursor: token })
      .mockResolvedValue(emptyPage);
    render(
      <UserStateProvider userId={null}>
        <WalletProfile address={address} onClose={vi.fn()} onToken={vi.fn()} />
      </UserStateProvider>,
    );
    expect(await screen.findByText("暂无持仓")).toBeVisible();
    expect(screen.queryByText("等待余额快照")).toBeNull();
    expect(screen.getByLabelText("7 日已实现盈亏")).toHaveTextContent("—");
    expect(screen.getByLabelText("7 日买入 / 卖出")).toHaveTextContent("—");
    fireEvent.click(screen.getByRole("button", { name: "更多持仓" }));
    await waitFor(() =>
      expect(walletApi.positions).toHaveBeenLastCalledWith(address, token, expect.any(AbortSignal)),
    );
  })();
  await cleanScenario2();
  await prepareScenario1();
  // combines feed filters, pages with the server cursor, and only offers sell for held tokens
  await (async () => {
    const refreshers: Array<() => void> = [];
    const originalInterval = window.setInterval.bind(window);
    vi.spyOn(window, "setInterval").mockImplementation((callback, delay) => {
      if (delay === 30_000) {
        refreshers.push(callback as () => void);
        return 100_000;
      }
      return originalInterval(callback, delay);
    });
    const cursor = { timestampMs: 5000, eventId: "a".repeat(64) };
    const page = {
      items: [
        {
          eventId: "b".repeat(64),
          address,
          token,
          kind: "SELL",
          timestampMs: Date.now(),
          amountUsd: "2100",
          marketCapUsd: "10000",
          labels: ["KOL"],
        },
      ],
      nextCursor: cursor,
    } as ActivityPage;
    vi.mocked(walletApi.feed).mockResolvedValue(page);
    const onTrade = vi.fn();
    const view = render(
      <UserStateProvider userId="me">
        <ActivityFeed
          onWallet={vi.fn()}
          onToken={vi.fn()}
          onTrade={onTrade}
          heldTokens={new Set()}
        />
      </UserStateProvider>,
    );
    await screen.findByText("$2.1K");
    expect(screen.queryByRole("button", { name: "Follow Sell" })).toBeNull();
    expect(screen.getByRole("button", { name: "View" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "KOL" }));
    fireEvent.click(screen.getByRole("button", { name: "Sells" }));
    fireEvent.click(screen.getByRole("button", { name: "≥ $2K" }));
    await waitFor(() =>
      expect(walletApi.feed).toHaveBeenLastCalledWith(
        expect.objectContaining({ scope: "KOL", side: "SELL", minUsd: "2000" }),
        expect.any(AbortSignal),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "加载更多动态" }));
    await waitFor(() =>
      expect(walletApi.feed).toHaveBeenLastCalledWith(
        expect.objectContaining({ before: cursor }),
        expect.any(AbortSignal),
      ),
    );
    view.rerender(
      <UserStateProvider userId="me">
        <ActivityFeed
          onWallet={vi.fn()}
          onToken={vi.fn()}
          onTrade={onTrade}
          heldTokens={new Set([token])}
        />
      </UserStateProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Follow Sell" }));
    expect(onTrade).toHaveBeenCalledWith(token, "SELL");
    const sellCell = screen.getByRole("button", { name: "Follow Sell" }).parentElement!;
    fireEvent.mouseEnter(sellCell);
    vi.mocked(walletApi.feed).mockResolvedValue({
      items: [
        {
          ...page.items[0]!,
          eventId: "c".repeat(64),
          amountUsd: "2200",
          timestampMs: Date.now() + 1,
        },
      ],
      nextCursor: cursor,
    });
    await act(async () => {
      refreshers.at(-1)!();
    });
    expect(screen.getByText(/1 条新动态/)).toBeVisible();
    expect(screen.queryByText("$2.2K")).not.toBeInTheDocument();
    fireEvent.mouseLeave(sellCell);
    expect(screen.getByText("$2.2K")).toBeVisible();
  })();
});

it("settings keeps its saved confirmation after the persisted amounts update", async () => {
  render(
    <UserStateProvider userId="fresh-test-user">
      <UserSettings onWallet={() => {}} onToken={() => {}} />
    </UserStateProvider>,
  );
  const input = await screen.findByRole("textbox", { name: "买入预设" });
  fireEvent.change(input, { target: { value: "1.25, 2" } });
  fireEvent.click(screen.getByRole("button", { name: "保存快捷金额" }));
  await waitFor(() =>
    expect(walletApi.saveState).toHaveBeenCalledWith(
      "SETTINGS",
      "preferences",
      { quickBuyAmounts: ["1.25", "2"] },
      expect.any(AbortSignal),
    ),
  );
  expect(await screen.findByText("快捷金额已保存")).toBeVisible();
  expect(input).toHaveValue("1.25, 2");
});
it("renders provided wallet token identity while retaining its address", async () => {
  vi.mocked(walletApi.profile).mockResolvedValue(null as unknown as WalletProfileData);
  vi.mocked(walletApi.positions).mockResolvedValue({
    items: [
      {
        chainId: 4663,
        address,
        token,
        decimals: 18,
        quantityAtomic: "1000000000000000000",
        observedNetAtomic: "0",
        quantityComplete: true,
        costUsd: null,
        boughtAtomic: "0",
        soldAtomic: "0",
        boughtUsd: null,
        soldUsd: null,
        realizedPnlUsd: null,
        cyclePnlUsd: null,
        cycleNumber: 0,
        updatedAt: 0,
        symbol: "NVDA",
        name: "NVIDIA",
        logo: "https://example.com/nvda.png",
      },
    ],
    nextCursor: null,
  });
  render(
    <UserStateProvider userId={null}>
      <WalletProfile address={address} onClose={vi.fn()} onToken={vi.fn()} />
    </UserStateProvider>,
  );
  const button = await screen.findByRole("button", { name: "NVDA" });
  expect(button).toHaveAttribute("title", token);
  expect(button.querySelector("img")).toHaveAttribute("src", "https://example.com/nvda.png");
});
