import { cleanup, render, screen, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, expect, it } from "vitest";
import { TokenRiskGrid, TokenRiskLabels } from "./TokenRiskLabels";
import type { Token } from "./types";

expect.extend(matchers);

afterEach(cleanup);

it.each([
  { isHoneypot: true, isShowAlert: true, honeypot: "是", alert: "有" },
  { isHoneypot: false, isShowAlert: false, honeypot: "否", alert: "无" },
  { isHoneypot: null, isShowAlert: null, honeypot: "未知", alert: "未知" },
  { isHoneypot: null, isShowAlert: true, honeypot: "未知", alert: "有" },
  { isHoneypot: undefined, isShowAlert: undefined, honeypot: "未知", alert: "未知" },
])(
  "renders independent risk states: $honeypot / $alert",
  ({ isHoneypot, isShowAlert, honeypot, alert }) => {
    render(<TokenRiskLabels security={{ isHoneypot, isShowAlert } as Token["security"]} />);
    const honeypotLabel = screen.getByText(`貔貅：${honeypot}`);
    const alertLabel = screen.getByText(`风险提示：${alert}`);
    expect(honeypotLabel).toBeVisible();
    expect(alertLabel).toBeVisible();
    expect(honeypotLabel).toHaveClass(isHoneypot === true ? "security-danger" : "security-neutral");
    expect(alertLabel).toHaveClass(isShowAlert === true ? "security-warning" : "security-neutral");
  },
);

function metricValue(label: string) {
  return within(screen.getByText(label).closest(".risk-metric") as HTMLElement).getByRole(
    "definition",
  );
}

it("shows the 12 provider metrics using percentage points and the reported sniper fraction", () => {
  const token = {
    holders: 8100,
    security: {
      isHoneypot: false,
      isShowAlert: false,
      top10HolderPct: "16.248",
      devHoldingPct: "0.278",
      sniperCount: 27,
      sniperTotal: 70,
      ratHoldingPct: "0",
      phishingHoldingPct: "2.345",
      bundlerHoldingPct: null,
      dexPaid: true,
      isOpenSource: true,
      isRenounced: false,
      liquidityBurnedPct: "12.345",
      liquidityLockedPct: "50",
    },
  } as unknown as Token;
  render(<TokenRiskGrid token={token} />);
  expect(screen.getAllByRole("definition")).toHaveLength(12);
  expect(metricValue("Top 10")).toHaveTextContent("16.25%");
  expect(metricValue("DEV")).toHaveTextContent("0.28%");
  expect(metricValue("持有人")).toHaveTextContent("8,100");
  expect(metricValue("狙击者")).toHaveTextContent("27 / 70");
  expect(metricValue("老鼠仓")).toHaveTextContent("0%");
  expect(metricValue("钓鱼钱包")).toHaveTextContent("2.35%");
  expect(metricValue("捆绑交易")).toHaveTextContent("未知");
  expect(metricValue("DEX 付费")).toHaveTextContent("是");
  expect(metricValue("非貔貅")).toHaveTextContent("是");
  expect(metricValue("开源")).toHaveTextContent("是");
  expect(metricValue("弃权")).toHaveTextContent("否");
  expect(metricValue("LP 燃烧 / 锁定")).toHaveTextContent("12.35% / 50%");
});

it("leaves missing and invalid provider values unknown rather than treating them as zero or safe", () => {
  const token = {
    security: {
      top10HolderPct: "",
      devHoldingPct: "unknown",
      sniperCount: 27,
      sniperTotal: null,
      ratHoldingPct: null,
      phishingHoldingPct: "-1",
      bundlerHoldingPct: "101",
      dexPaid: null,
      isOpenSource: null,
      isRenounced: null,
      liquidityBurnedPct: null,
      liquidityLockedPct: null,
    },
  } as unknown as Token;
  render(<TokenRiskGrid token={token} />);
  expect(screen.getAllByRole("definition").every((node) => node.textContent === "未知")).toBe(true);
});

it("keeps honeypot and provider alert independent while token metrics change", () => {
  const { rerender } = render(
    <TokenRiskGrid token={{ security: { isHoneypot: null, isShowAlert: true } } as Token} />,
  );
  expect(metricValue("非貔貅")).toHaveTextContent("未知");
  expect(screen.getByText("风险提示：有")).toHaveClass("security-warning");
  rerender(
    <TokenRiskGrid token={{ security: { isHoneypot: false, isShowAlert: null } } as Token} />,
  );
  expect(metricValue("非貔貅")).toHaveTextContent("是");
  expect(screen.getByText("风险提示：未知")).toHaveClass("security-neutral");
});

it("shows known sniper holdings while leaving the unavailable count fraction unknown", () => {
  render(<TokenRiskGrid token={{ holders: 0, security: { sniperHoldingPct: "0.37" } } as Token} />);
  expect(metricValue("持有人")).toHaveTextContent("0");
  expect(metricValue("狙击者")).toHaveTextContent("未知");
  expect(metricValue("狙击者")).toHaveTextContent("持仓 0.37%");
  expect(metricValue("狙击者")).not.toHaveTextContent("/ 70");
});
