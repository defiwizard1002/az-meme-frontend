import { cleanup, render, screen, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, expect, it } from "vitest";
import { TokenRiskGrid, safetySeverity } from "./TokenRiskLabels";
import type { Token } from "./types";
expect.extend(matchers);
const cleanScenario1 = cleanup;
afterEach(cleanScenario1);
const token = (security: Partial<Token["security"]>) => ({ security }) as Token;
const metric = (name: string) =>
  within(screen.getByText(name).closest(".risk-metric") as HTMLElement).getByRole("definition");
it("TokenRiskLabels: 3 related scenarios", async () => {
  // keeps known high risk visible when concentration is missing and distinguishes known zero
  await (async () => {
    render(
      <TokenRiskGrid
        token={token({ isHoneypot: true, top10HolderPct: null, devHoldingPct: "0" })}
      />,
    );
    expect(screen.getByText("高风险")).toHaveClass("security-danger");
    expect(screen.getByText(/信息不完整/)).toBeVisible();
    expect(screen.getByText(/已禁止买入/)).toBeVisible();
    expect(metric("Dev 持仓")).toHaveTextContent("0%");
    expect(metric("Dev 持仓")).toHaveClass("security-safe");
    expect(metric("Top 10 持仓")).toHaveTextContent("未知");
  })();
  await cleanScenario1();
  // applies every documented threshold including boundary values and boolean risk
  await (async () => {
    for (const [field, green, warning, red] of [
      ["top10HolderPct", "30", "45", "45.01"],
      ["devHoldingPct", "5", "10", "10.01"],
      ["ratHoldingPct", "8", "100", null],
      ["sniperHoldingPct", "15", "100", null],
      ["bundlerHoldingPct", "10", "20", "20.01"],
      ["phishingHoldingPct", "10", "25", "25.01"],
      ["rugRatio", "0.099", "0.3", "0.301"],
      ["buyTaxPct", "0", "100", null],
      ["sellTaxPct", "0", "5", "5.001"],
    ] as const) {
      expect(safetySeverity(token({ [field]: green }).security)).toBe("neutral");
      expect(safetySeverity(token({ [field]: warning }).security)).toBe("warning");
      if (red) expect(safetySeverity(token({ [field]: red }).security)).toBe("danger");
    }
    expect(safetySeverity(token({ rugRatio: "0.1" }).security)).toBe("warning");
    expect(safetySeverity(token({ isWashTrading: true }).security)).toBe("danger");
    expect(safetySeverity(token({ isOpenSource: false }).security)).toBe("warning");
    expect(safetySeverity(token({ isRenounced: false }).security)).toBe("warning");
  })();
  await cleanScenario1();
  // does not substitute volume fractions for holding risk and preserves unknown fields
  await (async () => {
    render(
      <TokenRiskGrid
        token={token({ ratVolumePct: "95", bundlerVolumePct: "40", phishingVolumePct: "30" })}
      />,
    );
    expect(metric("Rat 持仓")).toHaveTextContent("未知");
    expect(metric("Bundler 持仓")).toHaveTextContent("未知");
    expect(metric("Rat 成交量占比")).toHaveTextContent("95%");
    expect(metric("Bundler 成交量占比")).toHaveTextContent("40%");
    expect(screen.getByText("风险未知")).toHaveClass("security-neutral");
  })();
});
