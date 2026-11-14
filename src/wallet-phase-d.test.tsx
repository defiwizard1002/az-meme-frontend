import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ActivityFeed } from "./ActivityFeed";
import { WalletProfile } from "./WalletProfile";
import { UserStateProvider, useUserState } from "./user-state";
import { parseQuickBuyAmounts, UserSettings } from "./UserSettings";
import { walletApi } from "./wallet-api";
import type { ActivityPage, WalletPosition, WalletProfileData } from "./wallet-types";

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
    expect(await screen.findByText("No positions")).toBeVisible();
    expect(screen.queryByText("Waiting for balance snapshot")).toBeNull();
    expect(screen.getByLabelText("7d realized PnL").nextElementSibling).toHaveTextContent("—");
    expect(screen.getByLabelText("7d buys / sells")).toHaveTextContent("—");
    fireEvent.click(screen.getByRole("button", { name: "Load more positions" }));
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
          txHash: `0x${"b".repeat(64)}`,
          chainId: 4663,
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
          explorerBaseUrl="https://example.com"
        />
      </UserStateProvider>,
    );
    await screen.findByText("$2.1K");
    expect(screen.queryByRole("button", { name: "Follow Sell" })).toBeNull();
    expect(screen.getByRole("link", { name: "View" })).toHaveAttribute(
      "href",
      `https://example.com/tx/0x${"b".repeat(64)}`,
    );
    fireEvent.click(screen.getByRole("button", { name: "KOL" }));
    fireEvent.click(screen.getByRole("button", { name: "Sells" }));
    fireEvent.click(screen.getByRole("button", { name: "≥ $2K" }));
    await waitFor(() =>
      expect(walletApi.feed).toHaveBeenLastCalledWith(
        expect.objectContaining({ scope: "KOL", side: "SELL", minUsd: "2000" }),
        expect.any(AbortSignal),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Load more activity" }));
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
          explorerBaseUrl="https://example.com"
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
    expect(screen.getByText(/1 new trade/)).toBeVisible();
    expect(screen.queryByText("$2.2K")).not.toBeInTheDocument();
    fireEvent.mouseLeave(sellCell);
    expect(screen.getByText("$2.2K")).toBeVisible();
  })();
});

it("opens available activity transactions in the configured explorer", async () => {
  const transactionHash = `0x${"a".repeat(64)}`;
  const activity = {
    address,
    token,
    chainId: 4663,
    kind: "BUY",
    timestampMs: Date.now(),
    amountUsd: "2",
    marketCapUsd: "3",
  };
  vi.mocked(walletApi.feed).mockResolvedValue({
    items: [
      { ...activity, eventId: "valid", txHash: transactionHash },
      { ...activity, eventId: "missing", txHash: "" },
      { ...activity, eventId: "invalid", txHash: "not-a-hash" },
    ],
    nextCursor: null,
  } as ActivityPage);
  render(
    <UserStateProvider userId={null}>
      <ActivityFeed
        onWallet={vi.fn()}
        onToken={vi.fn()}
        onTrade={vi.fn()}
        heldTokens={new Set()}
        explorerBaseUrl="https://explorer.example/"
      />
    </UserStateProvider>,
  );
  const link = await screen.findByRole("link", { name: "View" });
  expect(link).toHaveAttribute("href", `https://explorer.example/tx/${transactionHash}`);
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(screen.getAllByTitle("Transaction link unavailable")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "View" })).toBeNull();
});

it("labels observed on-chain net amounts and keeps unavailable values unknown", async () => {
  const incomplete = {
    chainId: 4663,
    address,
    token,
    decimals: 18,
    quantityAtomic: null,
    observedNetAtomic: "10000000000000000000",
    quantityComplete: false,
    costUsd: null,
    boughtAtomic: "0",
    soldAtomic: "0",
    boughtUsd: "0",
    soldUsd: null,
    realizedPnlUsd: null,
    cyclePnlUsd: null,
    cycleNumber: 0,
    updatedAt: 0,
    symbol: "SPCX",
    valueUsd: null,
    unrealizedPnlUsd: null,
  } satisfies WalletPosition;
  vi.mocked(walletApi.profile).mockResolvedValue(null as unknown as WalletProfileData);
  vi.mocked(walletApi.positions).mockResolvedValue({
    items: [
      incomplete,
      {
        ...incomplete,
        token: `0x${"3".repeat(40)}`,
        symbol: "NEG",
        decimals: 6,
        observedNetAtomic: "-1234567",
      },
      {
        ...incomplete,
        token: `0x${"4".repeat(40)}`,
        symbol: "WETH",
        quantityAtomic: "1000000000000000000",
        quantityComplete: true,
        valueUsd: "0",
        unrealizedPnlUsd: "0",
      },
    ],
    nextCursor: null,
  });
  render(
    <UserStateProvider userId={null}>
      <WalletProfile address={address} onClose={vi.fn()} onToken={vi.fn()} />
    </UserStateProvider>,
  );
  const spcx = (await screen.findByRole("button", { name: "SPCX" })).closest("tr")!;
  expect(
    within(spcx).getByTitle("On-chain net movement; position attribution is incomplete"),
  ).toHaveTextContent("10 observed net · incomplete");
  expect(
    within(spcx).getByTitle("Value unavailable: price or complete quantity is missing"),
  ).toHaveTextContent("—");
  expect(
    within(spcx).getByTitle("PnL unavailable: cost basis or value is missing"),
  ).toHaveTextContent("—");
  const negative = screen.getByRole("button", { name: "NEG" }).closest("tr")!;
  expect(
    within(negative).getByTitle("On-chain net movement; position attribution is incomplete"),
  ).toHaveTextContent("-1.23457");
  const weth = screen.getByRole("button", { name: "WETH" }).closest("tr")!;
  expect(within(weth).queryByText(/On-chain net/)).toBeNull();
  expect(within(weth).getAllByText("$0")).toHaveLength(2);
});

it("exposes an exact complete holding quantity to pointer, keyboard and touch users", async () => {
  const position = {
    chainId: 4663,
    address,
    token,
    decimals: 18,
    quantityAtomic: "1234567890123456789",
    observedNetAtomic: "1234567890123456789",
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
    valueUsd: null,
    unrealizedPnlUsd: null,
  } satisfies WalletPosition;
  vi.mocked(walletApi.profile).mockResolvedValue(null as unknown as WalletProfileData);
  vi.mocked(walletApi.positions).mockResolvedValue({
    items: [
      { ...position, symbol: "HELD" },
      {
        ...position,
        token: `0x${"3".repeat(40)}`,
        symbol: "PARTIAL",
        quantityAtomic: null,
        observedNetAtomic: "10000000000000000000",
        quantityComplete: false,
      },
    ],
    nextCursor: null,
  });
  render(
    <UserStateProvider userId={null}>
      <WalletProfile address={address} onClose={vi.fn()} onToken={vi.fn()} />
    </UserStateProvider>,
  );
  const held = (await screen.findByRole("button", { name: "HELD" })).closest("tr")!;
  const quantity = within(held).getByText("Qty");
  expect(quantity).toHaveAccessibleName(
    "Exact holding quantity for HELD: 1.234567890123456789 HELD",
  );
  expect(quantity).toHaveAttribute("title", "Exact quantity: 1.234567890123456789 HELD");
  fireEvent.click(quantity);
  expect(quantity.closest("details")).toHaveAttribute("open");
  expect(within(held).getByText("1.234567890123456789 HELD")).toBeInTheDocument();
  const partial = screen.getByRole("button", { name: "PARTIAL" }).closest("tr")!;
  expect(
    within(partial).getByTitle("On-chain net movement; position attribution is incomplete"),
  ).toHaveTextContent("10 observed net · incomplete");
  expect(within(partial).queryByText("Qty")).toBeNull();
});

it("keeps the measured profile cards visible while wallet data is loading", () => {
  vi.mocked(walletApi.profile).mockImplementation(() => new Promise(() => {}));
  render(
    <UserStateProvider userId={null}>
      <WalletProfile address={address} onClose={vi.fn()} onToken={vi.fn()} />
    </UserStateProvider>,
  );
  expect(screen.getByText("Loading wallet…")).toBeVisible();
  expect(screen.getByText("7d PnL")).toBeVisible();
  expect(screen.getByText("7d win rate")).toBeVisible();
  expect(screen.getByText("7d buys / sells")).toBeVisible();
  expect(screen.getByText("Unrealized PnL")).toBeVisible();
  expect(document.querySelectorAll(".profile-drawer .stat-grid > div")).toHaveLength(4);
  expect(screen.queryByText("No positions")).toBeNull();
  expect(screen.queryByText("No activity")).toBeNull();
});

it("omits only complete holdings whose actual quantity is zero", async () => {
  const position = {
    chainId: 4663,
    address,
    token,
    decimals: 18,
    quantityAtomic: "1000000000000000000",
    observedNetAtomic: "1000000000000000000",
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
    valueUsd: null,
    unrealizedPnlUsd: null,
  } satisfies WalletPosition;
  vi.mocked(walletApi.profile).mockResolvedValue(null as unknown as WalletProfileData);
  vi.mocked(walletApi.positions).mockResolvedValue({
    items: [
      { ...position, token: `0x${"3".repeat(40)}`, symbol: "ZERO", quantityAtomic: "0" },
      {
        ...position,
        token: `0x${"4".repeat(40)}`,
        symbol: "NETZERO",
        quantityAtomic: null,
        observedNetAtomic: "0",
        quantityComplete: false,
      },
      { ...position, token: `0x${"5".repeat(40)}`, symbol: "HELD" },
    ],
    nextCursor: null,
  });
  render(
    <UserStateProvider userId={null}>
      <WalletProfile address={address} onClose={vi.fn()} onToken={vi.fn()} />
    </UserStateProvider>,
  );
  expect(await screen.findByRole("button", { name: "HELD" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "ZERO" })).toBeNull();
  expect(screen.getByRole("button", { name: "NETZERO" })).toBeVisible();
  expect(screen.queryByText("No positions")).toBeNull();
});

it("uses the selected quick-buy amount for a holding action", async () => {
  vi.mocked(walletApi.profile).mockResolvedValue(null as unknown as WalletProfileData);
  vi.mocked(walletApi.positions).mockResolvedValue({
    items: [
      {
        chainId: 4663,
        address,
        token,
        decimals: 18,
        quantityAtomic: "1000000000000000000",
        observedNetAtomic: "1000000000000000000",
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
        symbol: "HELD",
        valueUsd: null,
        unrealizedPnlUsd: null,
      },
    ],
    nextCursor: null,
  });
  const onTrade = vi.fn();
  render(
    <UserStateProvider userId={null}>
      <WalletProfile
        address={address}
        onClose={vi.fn()}
        onToken={vi.fn()}
        onTrade={onTrade}
        quickBuyAmount="25"
      />
    </UserStateProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Buy HELD with 25 USDG" }));
  expect(onTrade).toHaveBeenCalledWith(token, "BUY", "25");
});

it("uses the selected activity quick-buy preset for a row buy", async () => {
  vi.mocked(walletApi.feed).mockResolvedValue({
    items: [
      {
        eventId: "d".repeat(64),
        address,
        token,
        kind: "BUY",
        timestampMs: Date.now(),
        amountUsd: "2",
        marketCapUsd: "3",
      },
    ],
    nextCursor: null,
  } as ActivityPage);
  const onTrade = vi.fn();
  render(
    <UserStateProvider userId={null}>
      <ActivityFeed onWallet={vi.fn()} onToken={vi.fn()} onTrade={onTrade} heldTokens={new Set()} />
    </UserStateProvider>,
  );
  await screen.findByRole("button", { name: /10 USDG/ });
  expect(await screen.findByText("1 trade")).toBeVisible();
  expect(screen.getByRole("button", { name: /^Follow / })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: /10 USDG/ }));
  expect(onTrade).toHaveBeenCalledWith(token, "BUY", "10");
});

it("settings keeps its saved confirmation after the persisted amounts update", async () => {
  render(
    <UserStateProvider userId="fresh-test-user">
      <UserSettings onWallet={() => {}} onToken={() => {}} />
    </UserStateProvider>,
  );
  const input = await screen.findByRole("textbox", { name: "Buy presets" });
  fireEvent.change(input, { target: { value: "1.25, 2" } });
  fireEvent.click(screen.getByRole("button", { name: "Save quick-buy amounts" }));
  await waitFor(() =>
    expect(walletApi.saveState).toHaveBeenCalledWith(
      "SETTINGS",
      "preferences",
      { quickBuyAmounts: ["1.25", "2"] },
      expect.any(AbortSignal),
    ),
  );
  expect(await screen.findByText("Quick-buy amounts saved")).toBeVisible();
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
