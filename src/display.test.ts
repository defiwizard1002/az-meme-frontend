import { expect, it } from "vitest";
import fixtures from "../../../tests/display-price.fixtures.json";
import { amount, money, percent, price } from "./display";

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

// 与父仓 E2E 期望共用同一份字面量（tests/display-price.fixtures.json），
// 任一侧改了显示规则都会让这里的断言失败。
it("matches the E2E display fixtures", () => {
  for (const fixture of fixtures) {
    const input = fixture.input as string | number | null;
    expect(price(input)).toBe(fixture.price);
    expect(money(input)).toBe(fixture.money);
  }
});
