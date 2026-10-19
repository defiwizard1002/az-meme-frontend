import { expect, it } from "vitest";
import { displayAmount } from "./decimal-display";
it("truncates display bounds without losing tiny values or large integer precision", () => {
  expect(displayAmount("123.456789123456789")).toBe("123.456");
  expect(displayAmount("0.000000000000123456789")).toBe("0.000000000000123456");
  expect(displayAmount("900719925474099312345.123")).toBe("900,719,925,474,099,312,345");
  expect(displayAmount("8.000000000000000001")).toBe("8");
});
