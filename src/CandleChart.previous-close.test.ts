import { describe, expect, it } from "vitest";
import { buildChartData } from "./CandleChart";
import type { Candle } from "./types";

describe("stored previous close chart display", () => {
  it("renders the first page item continuously without borrowing a loaded neighbor or mutating OHLC", () => {
    const item = {
      t: 100,
      o: "3",
      h: "4",
      l: "2",
      c: "4",
      previousClose: "100",
      revision: "9",
      baseVolume: "1",
      quoteVolume: "4",
    } as Candle;
    const original = structuredClone(item);
    const page = buildChartData([item]);
    expect(page.candles).toEqual([{ time: 100, open: 100, high: 100, low: 2, close: 4 }]);
    expect(page.volumes[0]?.value).toBe(4);
    const earlier = { ...item, t: 50, c: "999", previousClose: null };
    expect(buildChartData([earlier, item]).candles[1]).toEqual(page.candles[0]);
    expect(item).toEqual(original);
  });
  it("uses raw open for the first-ever bucket and rejects an older predecessor update", () => {
    const current = {
      t: 100,
      o: "3",
      h: "4",
      l: "2",
      c: "4",
      previousClose: null,
      revision: "9",
      baseVolume: "1",
      quoteVolume: "4",
    } as Candle;
    expect(
      buildChartData([current, { ...current, previousClose: "999", revision: "8" }]).candles[0],
    ).toMatchObject({ open: 3, high: 4, low: 2 });
  });
});
