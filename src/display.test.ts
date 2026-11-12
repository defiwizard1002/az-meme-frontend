import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { amount, money, percent, price } from "./display";

// Shared with the parent E2E expectations (scripts/display-price.mjs); the same
// literals appear in tests/display-price.fixtures.json so either side changing
// the rendered format fails a test.
const here = dirname(fileURLToPath(import.meta.url));
const fixtures: Array<{ input: unknown; amount: string; price: string }> = JSON.parse(
  readFileSync(resolve(here, "../../../tests/display-price.fixtures.json"), "utf8"),
);

it("formats USD and prices without long decimal tails", () => {
  expect(money("0.00000000000019856")).toBe("$1.986e-13");
  expect(money("0.0000003447702")).toBe("$0.0000003448");
  expect(money("3447702")).toBe("$3,447,702");
  expect(money("1234.56789")).toBe("$1,234.57");
  expect(price("0.01234567")).toBe("0.01235");
  expect(price("0.000000001234567")).toBe("0.000000001235");
  expect(money("-0.00000000000019856")).toBe("$-1.986e-13");
  expect(amount("0.00000000000004761905")).toBe("4.762e-14");
  expect(percent("40.8651753632579711904761904761")).toBe("40.8652%");
  expect(money(0)).toBe("$0");
  for (const value of [null, undefined, "", "invalid", Infinity]) {
    expect(money(value)).toBe("—");
    expect(price(value)).toBe("—");
  }
});

it("matches the E2E display fixtures", () => {
  for (const fixture of fixtures) {
    expect(price(fixture.input as string | number | null)).toBe(fixture.price);
    expect(money(fixture.input as string | number | null)).toBe(fixture.money);
  }
});
