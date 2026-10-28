import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  layerReport,
  layerReportSheets,
  localDate,
  type LayerReportInput,
  type LayerSource,
} from "../src/lib/layer-report";
import { eggForecast } from "../src/lib/forecast";
const org = randomUUID(),
  flock = randomUUID(),
  farm = randomUUID(),
  forecastId = randomUUID();
const now = new Date("2026-10-28T09:00:00Z");
function fixture() {
  const periods = [{ lay: 0.8, mortality: 0.1, cracks: 0.05 }],
    input = {
      opening: 100,
      startMonth: "2024-02",
      traySize: 30,
      legacy28: false,
      periods,
    };
  const source: LayerSource = {
    timezone: "Africa/Lagos",
    unit: {
      id: flock,
      organization_id: org,
      farm_id: farm,
      name: "=Synthetic layer flock",
      kind: "layers",
      stocked_on: "2024-02-01",
      opening_count: 100,
    },
    records: [
      { mortality: 2, eggs: 80, cracked: 2, feed_kg: "1.125000" },
      { mortality: 0, eggs: 0, cracked: 0, feed_kg: "0.000000" },
      { mortality: 1, eggs: 90, cracked: 1, feed_kg: "1.400000" },
    ].map((r, i) => ({
      ...r,
      id: randomUUID(),
      organization_id: org,
      unit_id: flock,
      recorded_on: `2024-02-0${i + 1}`,
      notes: "Synthetic fixture only",
      created_at: "2024-02-04T00:00:00Z",
    })),
    forecast: {
      id: forecastId,
      organization_id: org,
      name: "Synthetic calendar baseline",
      kind: "layer-eggs",
      input,
      result: eggForecast(100, "2024-02", periods, 30),
      created_at: "2024-01-31T00:00:00Z",
    },
  };
  const options: LayerReportInput = {
    organizationId: org,
    unitId: flock,
    from: "2024-02-01",
    to: "2024-02-03",
    traySize: 30,
    forecastId,
  };
  return { source, options };
}
it("uses opening daily hens and weighted hen-days, exact feed, explicit zero records and whole physical trays", () => {
  const { source, options } = fixture(),
    original = structuredClone(source),
    r = layerReport(options, source, now);
  expect(r.rows.map((d) => d.openingHens)).toEqual([100, 98, 98]);
  expect(r.rows.map((d) => d.closingHens)).toEqual([98, 98, 97]);
  expect(r.henDays).toBe(296);
  expect(r.henDayPercent).toBeCloseTo((170 / 296) * 100, 10);
  expect(r.rows[1]).toMatchObject({
    recorded: true,
    eggs: 0,
    feedKg: "0.000000",
    henDayPercent: 0,
  });
  expect(r.recordedTotals).toMatchObject({
    eggs: 170,
    cracked: 3,
    saleable: 167,
    feedKg: "2.525000",
  });
  expect([r.wholeTrays, r.remainderEggs]).toEqual([5, 17]);
  expect(source).toEqual(original);
});
it("reconciles a leap-year calendar forecast on recorded dates without changing its original opening-stock model", () => {
  const { source, options } = fixture(),
    r = layerReport(options, source, now);
  expect(source.forecast!.result.rows[0].days).toBe(29);
  expect(r.forecast?.aligned).toBe(true);
  expect(r.expectedTotals).toEqual({ gross: 240, cracked: 12, saleable: 228 });
  expect(r.deltas).toEqual({ gross: -70, cracked: -9, saleable: -61 });
  expect(r.rows[0].grossDelta).toBe(0);
  expect(r.rows[2].forecast?.openingHens).toBe(100);
});
it("does not turn missing dates into zero counts and withholds later population and full-window totals", () => {
  const { source, options } = fixture();
  source.records.splice(1, 1);
  const r = layerReport(options, source, now);
  expect(r.coverage.missingDates).toEqual(["2024-02-02"]);
  expect(r.rows[1]).toMatchObject({
    recorded: false,
    openingHens: 98,
    eggs: null,
    closingHens: null,
  });
  expect(r.rows[2].openingHens).toBeNull();
  expect(r.rows[2].henDayPercent).toBeNull();
  expect(r.henDays).toBeNull();
  expect(r.actualTotals).toBeNull();
  expect(r.deltas).toBeNull();
  expect(r.recordedTotals.eggs).toBe(170);
});
it("retains unknown denominators after a gap before the selected range and refuses unproven forecast population alignment", () => {
  const { source, options } = fixture();
  source.unit.stocked_on = "2024-01-31";
  options.from = "2024-02-02";
  const r = layerReport(options, source, now);
  expect(r.coverage.recordedDays).toBe(2);
  expect(r.actualTotals?.eggs).toBe(90);
  expect(r.henDays).toBeNull();
  expect(r.forecast?.aligned).toBe(false);
  expect(r.deltas).toBeNull();
  expect(r.coverage.firstMissingHistory).toBe("2024-01-31");
});
it("withholds legacy 28-day calendar variances and different opening populations without prorating or scaling", () => {
  const { source, options } = fixture();
  source.forecast!.input.legacy28 = true;
  source.forecast!.result = eggForecast(
    100,
    "2024-02",
    source.forecast!.input.periods,
    30,
    true,
  );
  let r = layerReport(options, source, now);
  expect(r.rows.every((d) => d.forecast === null)).toBe(true);
  expect(r.expectedTotals).toBeNull();
  expect(r.forecast?.reason).toContain("28-day");
  expect(r.actualTotals?.eggs).toBe(170);
  source.forecast!.input.legacy28 = false;
  source.forecast!.input.opening = 200;
  source.forecast!.result = eggForecast(
    200,
    "2024-02",
    source.forecast!.input.periods,
    30,
  );
  r = layerReport(options, source, now);
  expect(r.expectedTotals?.gross).toBe(480);
  expect(r.deltas).toBeNull();
  expect(r.forecast?.reason).toContain("differs");
});
it("keeps zero-hen denominators undefined and flags eggs recorded without a positive opening flock", () => {
  const { source, options } = fixture();
  source.records[0].mortality = 100;
  source.records[2].mortality = 0;
  const r = layerReport(options, source, now);
  expect(r.rows[1]).toMatchObject({
    openingHens: 0,
    eggs: 0,
    henDayPercent: null,
  });
  expect(r.rows[2].issues.length).toBe(1);
  expect(r.henDays).toBe(100);
  expect(r.henDayPercent).toBeNull();
  expect(r.deltas).toBeNull();
});
it("uses organization-local dates, bounds the window and rejects mismatched/malformed immutable sources", () => {
  expect(localDate("Africa/Lagos", new Date("2026-10-27T23:30:00Z"))).toBe(
    "2026-10-28",
  );
  const { source, options } = fixture();
  expect(() =>
    layerReport({ ...options, to: "2027-02-04" }, source, now),
  ).toThrow();
  expect(() =>
    layerReport({ ...options, unitId: randomUUID() }, source, now),
  ).toThrow(/match/);
  source.forecast!.result.rows[0].gross += 1;
  expect(() => layerReport(options, source, now)).toThrow(/inconsistent/);
});
it("retains historical source IDs, unknown cells and original forecast periods in report exports", () => {
  const { source, options } = fixture();
  source.records.splice(1, 1);
  const r = layerReport(options, source, now),
    sheets = layerReportSheets(r, "digest", source);
  expect(sheets).toHaveLength(4);
  expect(sheets[1].rows[2][1]).toBeNull();
  expect(sheets[1].rows[2][6]).toBeNull();
  expect(sheets[2].rows[1][0]).toBe(source.records[0].id);
  expect(sheets[3].rows[8][1]).toBe(29);
});
