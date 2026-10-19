import type { Token } from "./types";

export function TokenRiskLabels({ security }: { security: Token["security"] }) {
  return (
    <>
      <span className={security.isHoneypot === true ? "security-danger" : "security-neutral"}>
        貔貅：{security.isHoneypot === true ? "是" : security.isHoneypot === false ? "否" : "未知"}
      </span>
      <span className={security.isShowAlert === true ? "security-warning" : "security-neutral"}>
        风险提示：
        {security.isShowAlert === true ? "有" : security.isShowAlert === false ? "无" : "未知"}
      </span>
    </>
  );
}

const percentFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const countFormatter = new Intl.NumberFormat("en-US");

function percent(value: string | null | undefined): string {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value.trim())) return "未知";
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100
    ? `${percentFormatter.format(number)}%`
    : "未知";
}

function count(value: number | null | undefined): string {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? countFormatter.format(value)
    : "未知";
}

function yesNo(value: boolean | null | undefined): string {
  return value === true ? "是" : value === false ? "否" : "未知";
}

/** Missing provider fields deliberately remain unknown, including nullable booleans. */
export function TokenRiskGrid({ token }: { token: Token }) {
  const security = token.security;
  const sniperCount = count(security.sniperCount);
  const sniperTotal = count(security.sniperTotal);
  const snipers =
    sniperCount !== "未知" &&
    sniperTotal !== "未知" &&
    security.sniperCount! <= security.sniperTotal!
      ? `${sniperCount} / ${sniperTotal}`
      : "未知";
  const sniperHoldings = percent(security.sniperHoldingPct);
  const burned = percent(security.liquidityBurnedPct);
  const locked = percent(security.liquidityLockedPct);
  const values = [
    { label: "Top 10", value: percent(security.top10HolderPct) },
    { label: "DEV", value: percent(security.devHoldingPct) },
    { label: "持有人", value: count(token.holders) },
    {
      label: "狙击者",
      value: snipers,
      detail: sniperHoldings === "未知" ? undefined : `持仓 ${sniperHoldings}`,
    },
    { label: "老鼠仓", value: percent(security.ratHoldingPct) },
    { label: "钓鱼钱包", value: percent(security.phishingHoldingPct) },
    { label: "捆绑交易", value: percent(security.bundlerHoldingPct) },
    { label: "DEX 付费", value: yesNo(security.dexPaid) },
    {
      label: "非貔貅",
      value: yesNo(
        security.isHoneypot === null || security.isHoneypot === undefined
          ? null
          : !security.isHoneypot,
      ),
      tone:
        security.isHoneypot === true
          ? "danger"
          : security.isHoneypot === false
            ? "safe"
            : "neutral",
    },
    { label: "开源", value: yesNo(security.isOpenSource) },
    { label: "弃权", value: yesNo(security.isRenounced) },
    {
      label: "LP 燃烧 / 锁定",
      value: burned === "未知" && locked === "未知" ? "未知" : `${burned} / ${locked}`,
    },
  ];
  return (
    <section className="token-risk-panel" aria-label="代币安全与持仓">
      <div className="risk-grid-heading">
        <h3>安全与持仓</h3>
        <span className={security.isShowAlert === true ? "security-warning" : "security-neutral"}>
          风险提示：
          {security.isShowAlert === true ? "有" : security.isShowAlert === false ? "无" : "未知"}
        </span>
      </div>
      <dl className="risk-grid">
        {values.map(({ label, value, tone, detail }) => (
          <div className="risk-metric" key={label}>
            <dt className="risk-metric-label">{label}</dt>
            <dd className={`risk-metric-value security-${tone ?? "neutral"}`}>
              {value}
              {detail && <small className="risk-metric-detail">{detail}</small>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
