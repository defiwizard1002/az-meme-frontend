type Numeric = string | number | null | undefined;
export function amount(value: Numeric): string {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value)))
    return "—";
  const n = Number(value);
  return Intl.NumberFormat("en-US", {
    notation: Math.abs(n) >= 100_000 ? "compact" : "standard",
    maximumSignificantDigits: 6,
  }).format(n);
}
export function money(value: Numeric): string {
  const formatted = amount(value);
  return formatted === "—" ? formatted : `$${formatted}`;
}
export function percent(value: Numeric): string {
  const formatted = amount(value);
  return formatted === "—" ? formatted : `${formatted}%`;
}
export function shortAddress(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
export function safeUrl(value: string | null | undefined): string | undefined {
  if (!value || !/^https?:\/\//i.test(value)) return undefined;
  try {
    return new URL(value).href;
  } catch {
    return undefined;
  }
}
export function relativeTime(ms: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  return seconds < 60
    ? `${seconds}秒前`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}分钟前`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)}小时前`
        : `${Math.floor(seconds / 86400)}天前`;
}
export function age(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  return seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)}h`
        : `${Math.floor(seconds / 86400)}d`;
}
