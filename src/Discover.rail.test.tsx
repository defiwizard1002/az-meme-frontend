import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import Discover from "./Discover";
vi.mock("./user-state", () => ({
  useUserState: () => ({ watchlist: new Set(), authenticated: false, quickBuyAmounts: ["10"] }),
}));
vi.mock("./api", () => ({
  request: vi.fn(),
  requestPublicMarket: vi.fn().mockResolvedValue({
    items: [
      {
        tokenAddress: "0x1234",
        symbol: "TEST",
        priceUsd: "0.001",
        marketCapUsd: "7670000",
        change1h: "6.07738",
        change24h: "100",
        volume1hUsd: "1",
      },
    ],
    stale: false,
  }),
  memeApi: { getWsTicket: vi.fn().mockRejectedValue(new Error("offline test")) },
  wsBaseUrl: "ws://localhost",
}));
afterEach(cleanup);
it("uses actual 1h change and compact MC in the detail rail", async () => {
  render(<Discover compact onToken={vi.fn()} onQuickBuy={vi.fn()} onConnect={vi.fn()} />);
  expect(await screen.findByText("$7.67M", { exact: false })).toHaveAttribute("title", "7670000");
  expect(screen.getByText("6.08%", { exact: false })).toHaveTextContent("1h");
  expect(screen.queryByText("100%", { exact: false })).toBeNull();
});

it("renders New lifecycle in its own status column", async () => {
  render(<Discover onToken={vi.fn()} onQuickBuy={vi.fn()} onConnect={vi.fn()} />);
  await screen.findByText("TEST");
  fireEvent.click(screen.getByRole("button", { name: "New" }));
  expect(await screen.findByRole("columnheader", { name: "Status" })).toBeVisible();
  await screen.findByText("TEST");
  expect(screen.getAllByRole("row")[1].children).toHaveLength(11);
});
