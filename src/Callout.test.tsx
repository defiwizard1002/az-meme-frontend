import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import Callout from "./Callout";

const response = {
  rc: 0,
  mc: "SUCCESS",
  ma: [],
  result: {
    items: [
      {
        uid: "callout-1",
        tokenAddress: "0x60b269135b0f19ec6b02104674a522ae273f3b65",
        symbol: "SPCX",
        logo: null,
        platform: "twitter",
        feeds: ["new"],
        launchpad: null,
        isSafe: "safe",
        author: {
          id: "1",
          name: "Gary Marcus",
          handle: "GaryMarcus",
          avatar: null,
          wallet: null,
          followers: 250000,
        },
        content: { text: "serious allegations", zhHans: "如果属实，这是相当严重的指控" },
        holding: { usdValue: null, pnlPct: null },
        mcapAtCallout: "703366.5",
        priceAtCallout: "0.0007033665",
        isDeclaration: false,
        tweetId: null,
        createdAtMs: Date.now() - 60_000,
        firstSeenAtMs: Date.now() - 60_000,
      },
      {
        uid: "callout-2",
        tokenAddress: "bizev8auekt6ndyajftzwyn4oeh1brgknt83qbjvpump",
        symbol: "CHAIRMAN",
        logo: null,
        platform: "pump",
        feeds: ["conviction"],
        launchpad: "Pump.fun",
        isSafe: "safe",
        author: {
          id: "2",
          name: "solgav",
          handle: null,
          avatar: null,
          wallet: null,
          followers: 1020,
        },
        content: { text: "v2 live", zhHans: null },
        holding: { usdValue: "1482.5", pnlPct: "-0.09" },
        mcapAtCallout: "978537",
        priceAtCallout: null,
        isDeclaration: false,
        tweetId: null,
        createdAtMs: Date.now() - 3 * 3600_000,
        firstSeenAtMs: Date.now() - 3 * 3600_000,
      },
    ],
    nextCursor: null,
    stale: false,
    heartbeat: { lastItemAtMs: Date.now(), total: 2 },
  },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("渲染喊单列表，中文文案优先，非 EVM 代币不可点", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 })),
  );
  const onToken = vi.fn();
  render(<Callout onToken={onToken} />);

  expect(await screen.findByText("如果属实，这是相当严重的指控")).toBeInTheDocument();
  expect(screen.getByText("Gary Marcus")).toBeInTheDocument();
  // 中文缺失时回落到原文
  expect(screen.getByText("v2 live")).toBeInTheDocument();
  // EVM 代币是按钮，Solana 地址只显示文字
  const evm = screen.getByRole("button", { name: "SPCX" });
  evm.click();
  expect(onToken).toHaveBeenCalledWith("0x60b269135b0f19ec6b02104674a522ae273f3b65");
  expect(screen.queryByRole("button", { name: "CHAIRMAN" })).toBeNull();
});

it("接口失败时显示错误而不是空列表", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
  render(<Callout onToken={() => {}} />);
  await waitFor(() => expect(screen.getByText(/网络请求失败/)).toBeInTheDocument());
});
