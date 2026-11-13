import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  vi.useRealTimers();
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

it("refreshes every 15 seconds without overlap or blanking, and cleans up changed selections", async () => {
  vi.useFakeTimers();
  request.mockResolvedValue(page);
  const view = render(<Views tokenAddress={token} chainId={4663} />);
  await act(async () => {});
  const card = screen.getByText("Tidal").closest("article");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(14999);
  });
  expect(request).toHaveBeenCalledTimes(1);
  let resolveRefresh!: (value: unknown) => void;
  request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(request).toHaveBeenCalledTimes(2);
  expect(screen.getByText("Tidal").closest("article")).toBe(card);
  expect(screen.queryByText("Loading views…")).not.toBeInTheDocument();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(request).toHaveBeenCalledTimes(2);
  const oldSignal = request.mock.calls[1]![1]!.signal!;
  fireEvent.click(screen.getByRole("button", { name: "Holders only" }));
  await act(async () => {});
  expect(oldSignal.aborted).toBe(true);
  await act(async () => {
    resolveRefresh({ ...page, items: [{ ...item, author: { name: "Wrong selection" } }] });
  });
  expect(screen.queryByText("Wrong selection")).not.toBeInTheDocument();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(request).toHaveBeenCalledTimes(4);
  expect(request.mock.calls[3]![0]).toContain(`tokens/${token}/callouts?chainId=4663&holders=1`);
  expect(screen.getByRole("button", { name: "Holders only" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  request.mockRejectedValueOnce(new Error("Refresh failed"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Refresh failed");
  expect(screen.getByText("Tidal")).toBeInTheDocument();
  const previous = request.mock.calls.at(-1)![1]!.signal!;
  view.rerender(<Views tokenAddress={`0x${"cd".repeat(20)}`} chainId={4664} />);
  await act(async () => {});
  expect(previous.aborted).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(request).toHaveBeenCalledTimes(7);
  expect(request.mock.calls[6]![0]).toContain(
    `tokens/0x${"cd".repeat(20)}/callouts?chainId=4664&holders=1`,
  );
  const finalSignal = request.mock.calls[6]![1]!.signal!;
  view.unmount();
  expect(finalSignal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(30000);
  expect(request).toHaveBeenCalledTimes(7);
});
