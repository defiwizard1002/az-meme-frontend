import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import Views from "./Callout";
import { requestPublicMarket } from "./api";
vi.mock("./api", () => ({ requestPublicMarket: vi.fn() }));
const request = vi.mocked(requestPublicMarket);
const token = `0x${"ab".repeat(20)}`;
const item = {
  uid: "1",
  author: { name: "Tidal", avatar: null },
  content: { text: "Stock-meme narrative", zhHans: null },
  holding: { usdValue: null, pnlPct: null },
  mcapAtCallout: "6620000",
};
const page = { items: [item], available: true, stale: false, hasMore: false };
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it("renders cards, distinguishes unknown and zero holdings without invented badges", async () => {
  request.mockResolvedValue({
    ...page,
    items: [
      item,
      { ...item, uid: "2", author: { name: "Whale" }, holding: { usdValue: "0", pnlPct: null } },
      {
        ...item,
        uid: "3",
        author: { name: "Holder" },
        holding: { usdValue: "1300", pnlPct: "0.294" },
      },
    ],
  });
  render(<Views tokenAddress={token} chainId={4663} />);
  expect(await screen.findByText("Tidal")).toBeInTheDocument();
  expect(screen.getByText("Holding unknown")).toBeInTheDocument();
  expect(screen.getByText("Not holding")).toBeInTheDocument();
  expect(screen.getByText(/Hold \$/)).toBeInTheDocument();
  expect(screen.queryByText("KOL")).not.toBeInTheDocument();
  expect(screen.getAllByText("MC when posted")).toHaveLength(3);
});
it("filter and token changes abort old requests and ignore late results", async () => {
  let resolveOld!: (value: unknown) => void;
  request
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValue(page);
  const view = render(<Views tokenAddress={token} chainId={4663} />);
  const firstSignal = request.mock.calls[0]![1]!.signal!;
  fireEvent.click(screen.getByRole("button", { name: "Holders only" }));
  expect(firstSignal.aborted).toBe(true);
  expect(await screen.findByText("Tidal")).toBeInTheDocument();
  expect(request.mock.calls[1]![0]).toContain("holders=1");
  const secondSignal = request.mock.calls[1]![1]!.signal!;
  view.rerender(<Views tokenAddress={`0x${"cd".repeat(20)}`} chainId={4663} />);
  expect(secondSignal.aborted).toBe(true);
  resolveOld({ ...page, items: [{ ...item, author: { name: "Wrong token" } }] });
  await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  expect(screen.queryByText("Wrong token")).not.toBeInTheDocument();
  view.unmount();
  expect(request.mock.calls[2]![1]!.signal!.aborted).toBe(true);
});
it("distinguishes unavailable, stale, empty and request error", async () => {
  request
    .mockResolvedValueOnce({ ...page, available: false })
    .mockResolvedValueOnce({ ...page, items: [], stale: true })
    .mockRejectedValueOnce(new Error("Read failed"));
  const view = render(<Views tokenAddress={token} chainId={4663} />);
  expect(await screen.findByText("Views unavailable")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Holders only" }));
  expect(await screen.findByText(/Views may be outdated/)).toBeInTheDocument();
  expect(screen.getByText(/No holder views/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "All" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Read failed");
  view.unmount();
});
