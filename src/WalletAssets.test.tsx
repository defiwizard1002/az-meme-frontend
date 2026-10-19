import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WalletAssets } from "./WalletAssets";
const balances = [
  { asset: "USDG" as const, available: "2.745399", frozen: "0" },
  { asset: "ETH" as const, available: "0.000777824934560926", frozen: "0" },
  { asset: "WETH" as const, available: "0.000032403134077067", frozen: "0" },
];
afterEach(cleanup);
it("opens the actual full asset list and closes by toggle, Escape and outside click", () => {
  render(<WalletAssets balances={balances} error={null} />);
  const button = screen.getByRole("button", { name: "钱包资产" });
  expect(button).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(button);
  const menu = screen.getByRole("dialog", { name: "钱包资产" });
  for (const asset of balances) {
    expect(within(menu).getByText(asset.asset)).toBeInTheDocument();
    expect(within(menu).getByText(asset.available)).toBeInTheDocument();
  }
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(button).toHaveFocus();
  fireEvent.click(button);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(button);
  fireEvent.click(button);
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("shows loading/error accurately and retains the existing account transfer action", () => {
  const transfer = vi.fn();
  const view = render(<WalletAssets balances={undefined} error={null} onTransfer={transfer} />);
  fireEvent.click(screen.getByRole("button", { name: "钱包资产" }));
  expect(screen.getByText("余额加载中")).toBeInTheDocument();
  view.rerender(<WalletAssets balances={balances} error="账户不可用" onTransfer={transfer} />);
  expect(screen.getByText("账户不可用")).toBeInTheDocument();
  expect(screen.queryByText("2.745399")).toBeNull();
  view.rerender(<WalletAssets balances={balances} error={null} onTransfer={transfer} />);
  fireEvent.click(screen.getByRole("button", { name: "账户划转" }));
  expect(transfer).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog")).toBeNull();
});
