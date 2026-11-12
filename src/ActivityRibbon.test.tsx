import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("./wallet-api", () => ({
  walletApi: { feed: vi.fn().mockResolvedValue({ items: [], nextCursor: null }) },
}));
import { ActivityRibbon } from "./ActivityFeed";
afterEach(cleanup);
it("renders the live strip with an honest empty feed and Smart money entry", async () => {
  render(<ActivityRibbon onWallet={() => {}} onToken={() => {}} onSmartMoney={() => {}} />);
  expect(await screen.findByText("暂无最近动态")).toBeInTheDocument();
  expect(screen.getByText("● Live")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Smart money ›" })).toBeInTheDocument();
});
