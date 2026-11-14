import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("./wallet-api", () => ({
  walletApi: { feed: vi.fn().mockResolvedValue({ items: [], nextCursor: null }) },
}));
import { ActivityRibbon } from "./ActivityFeed";
import { walletApi } from "./wallet-api";
afterEach(cleanup);
it("renders the live strip with an honest empty feed and Smart money entry", async () => {
  render(<ActivityRibbon onWallet={() => {}} onToken={() => {}} onSmartMoney={() => {}} />);
  expect(await screen.findByText("No recent activity")).toBeInTheDocument();
  expect(screen.getByText("● Live")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Smart money ›" })).toBeInTheDocument();
});

it("uses stored wallet and token identity when the feed provides it", async () => {
  vi.mocked(walletApi.feed).mockResolvedValueOnce({
    items: [
      {
        eventId: "event",
        chainId: 4663,
        address: `0x${"a".repeat(40)}`,
        token: `0x${"b".repeat(40)}`,
        txHash: `0x${"c".repeat(64)}`,
        blockNumber: 1,
        transactionIndex: 1,
        timestampMs: Date.now(),
        kind: "BUY",
        quantityAtomic: "1",
        decimals: 18,
        amountUsd: "2",
        realizedPnlUsd: null,
        cycleClosed: false,
        closedCyclePnlUsd: null,
        gap: null,
        source: "LOCAL_TRANSFERS",
        walletName: "Cold Hands",
        tokenSymbol: "DHAND",
      },
    ],
    nextCursor: null,
  });
  render(<ActivityRibbon onWallet={() => {}} onToken={() => {}} onSmartMoney={() => {}} />);
  expect(await screen.findByRole("button", { name: "Cold Hands" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "DHAND" })).toBeInTheDocument();
  const groups = document.querySelectorAll(".ticker-group");
  expect(groups).toHaveLength(2);
  expect(groups[1]).toHaveAttribute("aria-hidden", "true");
  expect(groups[1]).toHaveAttribute("inert");
  expect(groups[0].textContent).toBe(groups[1].textContent);
});
