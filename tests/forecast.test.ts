import { describe, it, expect } from "vitest";
import {
  feedForecast,
  eggForecast,
  workbookWeeks,
  workbookEggPeriods,
  biomass,
  fishFeed,
  specificGrowthRate,
  fcr,
} from "../src/lib/forecast";
describe("verified source arithmetic", () => {
  it("matches the first layer feed week", () => {
    const r = feedForecast(500, workbookWeeks);
    expect(r.rows[0]).toMatchObject({
      feedKg: 35,
      cost: "10080.0000",
      deaths: 2.5,
      closing: 497.5,
    });
  });
  it("matches 24-week totals within source-cache precision", () => {
    const r = feedForecast(500, workbookWeeks);
    expect(r.rows).toHaveLength(24);
    expect(r.feedKg).toBeCloseTo(5369.915337, 5);
    expect(Number(r.cost)).toBeCloseTo(1483006.278, 1);
    expect(r.closing).toBeCloseTo(472.7183509, 6);
  });
  it("matches first-month and 18-period legacy egg projections", () => {
    const r = eggForecast(1418, "2024-01", workbookEggPeriods, 30, true);
    expect(r.rows[0]).toMatchObject({
      gross: 17866.8,
      cracked: 89.334,
      trays: 592.5822,
      closing: 1410.91,
    });
    expect(r.trays).toBeCloseTo(17651.89312, 4);
    expect(r.cracked / 30).toBeCloseTo(93.28348768, 6);
    expect(r.closing).toBeCloseTo(1295.661888, 5);
  });
  it("uses leap-year and calendar boundaries without changing the legacy model", () => {
    const p = [{ lay: 1, mortality: 0, cracks: 0 }];
    expect(eggForecast(100, "2024-02", p, 30).eggs).toBe(2900);
    expect(eggForecast(100, "2023-02", p, 30).eggs).toBe(2800);
    expect(eggForecast(100, "2024-01", p, 30).eggs).toBe(3100);
    expect(eggForecast(100, "2024-01", p, 30, true).eggs).toBe(2800);
  });
  it("handles mortality extremes and zero stock without inventing animals", () => {
    expect(feedForecast(0, workbookWeeks).feedKg).toBe(0);
    expect(
      feedForecast(100, [
        { ration: 10, price: 10, mortality: 1 },
        { ration: 10, price: 10, mortality: 0 },
      ]).rows[1].feedKg,
    ).toBe(0);
  });
  it("rejects invalid rates, dates, units and nonfinite values", () => {
    expect(() => eggForecast(100, "2024-13", workbookEggPeriods, 30)).toThrow();
    expect(() =>
      eggForecast(100, "2024-01", [{ lay: 2, mortality: 0, cracks: 0 }], 30),
    ).toThrow();
    expect(() =>
      feedForecast(100, [{ ration: -1, price: 10, mortality: 0 }]),
    ).toThrow();
    expect(() => feedForecast(NaN, workbookWeeks)).toThrow();
  });
});
describe("production growth models", () => {
  it("calculates catfish biomass, feed allowance and SGR", () => {
    expect(biomass(1000, 250)).toBe(250);
    expect(fishFeed(1000, 250, 3)).toBe(7.5);
    expect(specificGrowthRate(100, 200, 10)).toBeCloseTo(6.9314718);
  });
  it("calculates FCR and rejects nonpositive gain and sampling inputs", () => {
    expect(fcr(200, 100)).toBe(2);
    expect(() => fcr(100, 0)).toThrow();
    expect(() => specificGrowthRate(0, 100, 10)).toThrow();
    expect(() => biomass(-1, 100)).toThrow();
  });
});
