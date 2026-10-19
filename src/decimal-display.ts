/** Display only: truncate decimal strings without converting atomic precision to Number. */
export function displayAmount(value: string, significant = 6): string {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return "—";
  const [rawWhole, fraction = ""] = value.split(".");
  const whole = rawWhole!.replace(/^0+(?=\d)/, "");
  const places =
    whole !== "0"
      ? Math.max(0, significant - whole.length)
      : fraction.search(/[1-9]/) < 0
        ? 0
        : fraction.search(/[1-9]/) + significant;
  const tail = fraction.slice(0, places).replace(/0+$/, "");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${tail ? `.${tail}` : ""}`;
}
