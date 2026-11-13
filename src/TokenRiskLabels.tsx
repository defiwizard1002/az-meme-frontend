import type { Token } from "./types";

type Tone = "safe" | "warning" | "danger" | "neutral";
interface RiskMetric {
  label: string;
  value: string;
  tone: Tone;
}
const format = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const yesNo = (value: boolean | null | undefined) =>
  value === true ? "是" : value === false ? "否" : "—";

function riskMetrics(security: Token["security"]): RiskMetric[] {
  const values: RiskMetric[] = (
    [
      ["Top 10 持仓", security.top10HolderPct, 30, 45],
      ["Dev 持仓", security.devHoldingPct, 5, 10],
      ["Rat 持仓", security.ratHoldingPct, 8, null],
      ["Sniper 持仓", security.sniperHoldingPct, 15, null],
      ["Bundler 持仓", security.bundlerHoldingPct, 10, 20],
      ["Phishing 持仓", security.phishingHoldingPct, 10, 25],
      ["买入税", security.buyTaxPct, 0, null],
      ["卖出税", security.sellTaxPct, 0, 5],
    ] as const
  ).map(([label, raw, warn, red]) => {
    const n = raw == null || raw.trim() === "" ? NaN : Number(raw);
    const known = Number.isFinite(n) && n >= 0 && n <= 100;
    return {
      label,
      value: known ? `${format.format(n)}%` : "—",
      tone: !known ? "neutral" : red !== null && n > red ? "danger" : n > warn ? "warning" : "safe",
    };
  });
  const ratio =
    security.rugRatio == null || security.rugRatio.trim() === "" ? NaN : Number(security.rugRatio);
  const knownRatio = Number.isFinite(ratio) && ratio >= 0 && ratio <= 1;
  values.push({
    label: "Rug ratio",
    value: knownRatio ? String(ratio) : "—",
    tone: !knownRatio ? "neutral" : ratio > 0.3 ? "danger" : ratio >= 0.1 ? "warning" : "safe",
  });
  for (const [label, value, bad] of [
    ["貔貅", security.isHoneypot, true],
    ["刷量", security.isWashTrading, true],
    ["开源", security.isOpenSource, false],
    ["放弃权限", security.isRenounced, false],
  ] as const) {
    values.push({
      label,
      value: yesNo(value),
      tone: value == null ? "neutral" : value === bad ? (bad ? "danger" : "warning") : "safe",
    });
  }
  return values;
}
export function safetySeverity(security: Token["security"]): Tone {
  const tones = riskMetrics(security).map((metric) => metric.tone);
  return tones.includes("danger")
    ? "danger"
    : tones.includes("warning")
      ? "warning"
      : tones.includes("neutral")
        ? "neutral"
        : "safe";
}
export function TokenRiskLabels({ security }: { security: Token["security"] }) {
  const tone = safetySeverity(security);
  return (
    <span className={`security-${tone}`}>
      {{ danger: "高风险", warning: "有风险项", neutral: "风险未知", safe: "已知项未见风险" }[tone]}
    </span>
  );
}
export function TokenRiskGrid({ token }: { token: Token }) {
  const security = token.security;
  const metrics = riskMetrics(security);
  const tone = safetySeverity(security);
  return (
    <section className="token-risk-panel panel" aria-label="Safety 安全信息">
      <div className="risk-grid-heading">
        <span aria-hidden="true" className={`risk-status-icon security-${tone}`}>
          {{ safe: "✓", warning: "!", danger: "×", neutral: "—" }[tone]}
        </span>
        <div className="risk-summary">
          <TokenRiskLabels security={security} />
          <p>
            {
              {
                safe: "No obvious red flags found. For reference only.",
                warning: "Notable risk factors identified. Trade with caution.",
                danger: "High-risk signals detected. You could lose most of your investment.",
                neutral: "Insufficient data to assess risk. Trade with caution.",
              }[tone]
            }
          </p>
        </div>
      </div>
      {security.isHoneypot === true && <p className="security-danger">已识别貔貅，已禁止买入</p>}
      <dl className="risk-grid">
        {[...metrics.slice(9), ...metrics.slice(0, 6), metrics[8], metrics[7]].map(
          ({ label, value, tone }) => (
            <div className="risk-metric" key={label}>
              <dt className="risk-metric-label">{label}</dt>
              <dd className={`risk-metric-value security-${tone}`}>{value}</dd>
            </div>
          ),
        )}
      </dl>
      <details className="risk-extra">
        <summary>Additional data</summary>
        <dl className="risk-grid">
          {[
            ["买入税", security.buyTaxPct],
            ["Rat 成交量占比", security.ratVolumePct],
            ["Bundler 成交量占比", security.bundlerVolumePct],
            ["Phishing 成交量占比", security.phishingVolumePct],
          ].map(([label, value]) => (
            <div className="risk-metric" key={label}>
              <dt>{label}</dt>
              <dd>{value == null ? "未知" : `${format.format(Number(value))}%`}</dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}
