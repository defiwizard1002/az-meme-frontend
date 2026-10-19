import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { TokenLiquidity } from "./TokenLiquidity.js";
import type { Token } from "./types.js";
afterEach(cleanup);
const token = { liquidityUsd: "846.88", pool: { liquidityUsd: "999" } } as Token;
const local = {
  status: "COMPLETE",
  knownPoolCount: 9,
  valuedPoolCount: 9,
  totalUsd: "3202.76",
  knownSubtotalUsd: "3202.76",
  asOfBlock: 92578604,
} as NonNullable<Token["localLiquidity"]>;
it("shows actual known-pool sum, its coverage and the separate provider report", () => {
  render(<TokenLiquidity token={{ ...token, localLiquidity: local }} money={(x) => `$${x}`} />);
  expect(screen.getByText("已知池本金（9/9池）")).toBeInTheDocument();
  expect(screen.getByText("$3202.76")).toBeInTheDocument();
  expect(screen.getByTitle(/不含累计手续费.*92578604.*提供方报告：\$846.88/)).toBeInTheDocument();
});
it("keeps an incomplete sum visibly unknown", () => {
  render(
    <TokenLiquidity
      token={{
        ...token,
        localLiquidity: { ...local, status: "PARTIAL", valuedPoolCount: 8, totalUsd: null },
      }}
      money={(x) => `$${x}`}
    />,
  );
  expect(screen.getByText("$3202.76 + 未知")).toBeInTheDocument();
  expect(screen.getByText("已知池本金（8/9池）")).toBeInTheDocument();
});
it("labels older provider data without asserting an aggregate", () => {
  render(<TokenLiquidity token={token} money={(x) => `$${x}`} />);
  expect(screen.getByText("提供方流动性")).toBeInTheDocument();
  expect(screen.getByText("$846.88")).toBeInTheDocument();
});
