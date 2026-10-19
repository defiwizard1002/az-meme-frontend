import { expect, it } from "vitest";
import { displayAmount, positionQuantity } from "./decimal-display";
it("truncates display bounds without losing tiny values or large integer precision", () => {
  expect(displayAmount("123.456789123456789")).toBe("123.456");
  expect(displayAmount("0.000000000000123456789")).toBe("0.000000000000123456");
  expect(displayAmount("900719925474099312345.123")).toBe("900,719,925,474,099,312,345");
  expect(displayAmount("8.000000000000000001")).toBe("8");
});

it("shows three decimal places for holdings without rounding positive dust to zero", () => {
  expect(positionQuantity("0")).toBe("0");
  expect(positionQuantity("0.003860795207337225")).toBe("0.003");
  expect(positionQuantity("0.000006486365974824")).toBe("<0.001");
  expect(positionQuantity("0.001")).toBe("0.001");
  expect(positionQuantity("123.456789")).toBe("123.456");
  expect(positionQuantity("9007199254740993.123456")).toBe("9,007,199,254,740,993.123");
});
