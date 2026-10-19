import type { Token } from "./types.js";
export function TokenLiquidity({
  token,
  money,
}: {
  token: Token;
  money: (value: string) => string;
}) {
  const local = token.localLiquidity;
  const label = local
    ? `已知池本金${local.knownPoolCount === null ? "" : `（${local.valuedPoolCount}/${local.knownPoolCount}池）`}`
    : token.liquidityUsd !== undefined
      ? "提供方流动性"
      : "主池流动性";
  const value = local
    ? local.status === "COMPLETE" && local.totalUsd !== null
      ? money(local.totalUsd)
      : local.status === "PARTIAL" && local.knownSubtotalUsd !== null
        ? `${money(local.knownSubtotalUsd)} + 未知`
        : "未知"
    : money(token.liquidityUsd ?? token.pool.liquidityUsd);
  const title = local
    ? `已知池的本金估值，不含累计手续费。${local.asOfBlock ? `区块 ${local.asOfBlock} 快照。` : ""}${local.status !== "COMPLETE" ? "部分数量或美元价格缺失，合计未完整。" : ""}${token.liquidityUsd !== undefined ? `提供方报告：${money(token.liquidityUsd)}。` : ""}`
    : "提供方报告的数值，尚未确认覆盖全部池。";
  return (
    <div title={title}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
