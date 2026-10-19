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

/** Holdings display only; execution keeps the original exact decimal string. */
export function positionQuantity(value: string): string {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return "—";
  const [whole = "0", fraction = ""] = value.split(".");
  const tail = fraction.slice(0, 3).replace(/0+$/, "");
  if (!/[1-9]/.test(whole) && !/[1-9]/.test(tail)) return /[1-9]/.test(fraction) ? "<0.001" : "0";
  return `${whole.replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${tail ? `.${tail}` : ""}`;
}
