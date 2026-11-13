import type { Token } from "./types";

type Tone = "safe" | "warning" | "danger" | "neutral";
interface RiskMetric {
  key: string;
  label: string;
  value: string;
  tone: Tone;
}
const format = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
function riskMetrics(security: Token["security"]): RiskMetric[] {
  const values: RiskMetric[] = (
    [
      ["Top 10", security.top10HolderPct, 30, 45],
      ["Dev", security.devHoldingPct, 5, 10],
      ["Insiders", null, 0, null],
      ["Rat", security.ratHoldingPct, 8, null],
      ["Snipers", security.sniperHoldingPct, 15, null],
      ["Bundlers", security.bundlerHoldingPct, 10, 20],
      ["Phishing", security.phishingHoldingPct, 10, 25],
      ["Buy tax", security.buyTaxPct, 0, null],
      ["Sell tax", security.sellTaxPct, 0, 5],
    ] as const
  ).map(([label, raw, warn, red]) => {
    const n = raw == null || raw.trim() === "" ? NaN : Number(raw);
    const known = Number.isFinite(n) && n >= 0 && n <= 100;
    return {
      key: label,
      label,
      value: known ? `${format.format(n)}%` : "—",
      tone: !known ? "neutral" : red !== null && n > red ? "danger" : n > warn ? "warning" : "safe",
    };
  });
  const ratio =
    security.rugRatio == null || security.rugRatio.trim() === "" ? NaN : Number(security.rugRatio);
  const knownRatio = Number.isFinite(ratio) && ratio >= 0 && ratio <= 1;
  values.push({
    key: "Rug risk",
    label: "Rug risk",
    value: knownRatio ? String(ratio) : "—",
    tone: !knownRatio ? "neutral" : ratio > 0.3 ? "danger" : ratio >= 0.1 ? "warning" : "safe",
  });
  for (const [label, value, safeValue, safeLabel, riskLabel] of [
    ["Honeypot", security.isHoneypot, false, "No honeypot", "Honeypot detected"],
    ["Wash trading", security.isWashTrading, false, "No wash", "Wash trading"],
    ["Open source", security.isOpenSource, true, "Verified", "Not verified"],
    ["Renounced", security.isRenounced, true, "Renounced", "Not renounced"],
  ] as const) {
    const safe = value == null ? null : value === safeValue;
    values.push({
      key: label,
      label: safe == null ? label : safe ? safeLabel : riskLabel,
      value: safe == null ? "—" : safe ? "✓" : "!",
      tone:
        safe == null
          ? "neutral"
          : safe
            ? "safe"
            : label === "Honeypot" || label === "Wash trading"
              ? "danger"
              : "warning",
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
      {{ danger: "High risk", warning: "Caution", neutral: "Risk unknown", safe: "Low risk" }[tone]}
    </span>
  );
}
export function TokenRiskGrid({ token }: { token: Token }) {
  const security = token.security;
  const metrics = riskMetrics(security);
  const byKey = new Map(metrics.map((metric) => [metric.key, metric]));
  const tone = safetySeverity(security);
  return (
    <section className="token-risk-panel panel" aria-label="Safety information">
      <div className="risk-grid-heading">
        <span aria-hidden="true" className={`risk-status-icon security-${tone}`}>
          {{ safe: "✓", warning: "!", danger: "×", neutral: "—" }[tone]}
        </span>
        <div className="risk-summary">
          <TokenRiskLabels security={security} />
          <p>
            {
              {
                safe: "No obvious red flags found. For reference only, not investment advice — memes are very volatile.",
                warning: "Notable risk factors identified. Trade with caution.",
                danger: "High-risk signals detected. You could lose most of your investment.",
                neutral: "Insufficient data to assess risk. Trade with caution.",
              }[tone]
            }
          </p>
        </div>
      </div>
      {security.isHoneypot === true && (
        <p className="security-danger">Honeypot detected. Buying is disabled</p>
      )}
      <dl className="risk-grid">
        {[
          "No honeypot",
          "No wash",
          "Verified",
          "Renounced",
          "Top 10",
          "Dev",
          "Insiders",
          "Snipers",
          "Phishing",
          "Bundlers",
          "Rug risk",
          "Sell tax",
        ].map((label) => {
          const metric = byKey.get(
            {
              "No honeypot": "Honeypot",
              "No wash": "Wash trading",
              Verified: "Open source",
            }[label] ?? label,
          )!;
          return (
            <div className="risk-metric" key={label}>
              <dt className="risk-metric-label">{label}</dt>
              <dd className={`risk-metric-value security-${metric.tone}`}>{metric.value}</dd>
            </div>
          );
        })}
      </dl>
      <details className="risk-extra">
        <summary>Additional data</summary>
        <dl className="risk-grid">
          {[
            ["Buy tax", security.buyTaxPct],
            ["Rat", security.ratHoldingPct],
            ["Rat volume share", security.ratVolumePct],
            ["Bundler volume share", security.bundlerVolumePct],
            ["Phishing volume share", security.phishingVolumePct],
          ].map(([label, value]) => (
            <div className="risk-metric" key={label}>
              <dt>{label}</dt>
              <dd>{value == null ? "Unknown" : `${format.format(Number(value))}%`}</dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}
