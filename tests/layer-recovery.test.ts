import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { layerReport, type LayerSource } from "../src/lib/layer-report";
import {
  layerAdjustmentInput,
  type LayerAdjustment,
} from "../src/lib/layer-recovery";
function fixture() {
  const org = randomUUID(),
    u = randomUUID();
  const source: LayerSource = {
    timezone: "Africa/Lagos",
    unit: {
      id: u,
      organization_id: org,
      farm_id: randomUUID(),
      name: "Synthetic recovery",
      kind: "layers",
      stocked_on: "2024-02-01",
      opening_count: 100,
    },
    forecast: null,
    records: [1, 3, 4].map((d, i) => ({
      id: randomUUID(),
      organization_id: org,
      unit_id: u,
      recorded_on: `2024-02-0${d}`,
      mortality: i === 0 ? 2 : 1,
      eggs: 80,
      cracked: 1,
      feed_kg: "1.000000",
      notes: "Original observation",
      created_at: "2024-02-05T00:00:00Z",
    })),
    adjustments: [],
  };
  const options = {
    organizationId: org,
    unitId: u,
    from: "2024-02-01",
    to: "2024-02-04",
    traySize: 30,
    forecastId: null,
  };
  function adjustment(
    kind: "daily" | "census",
    date: string,
    values: Partial<LayerAdjustment> = {},
  ): LayerAdjustment {
    return {
      id: randomUUID(),
      organization_id: org,
      unit_id: u,
      kind,
      observed_on: date,
      previous_id: null,
      base_record_id: null,
      mortality: null,
      eggs: null,
      cracked: null,
      feed_kg: null,
      notes: null,
      opening_hens: kind === "census" ? 90 : null,
      reason: "Synthetic reviewed correction",
      evidence: "Dated synthetic count sheet",
      created_by: randomUUID(),
      created_at: "2024-02-06T00:00:00Z",
      ...values,
    };
  }
  return { source, options, adjustment };
}
it("restores denominators after a census without filling earlier missing eggs or feed", () => {
  const { source, options, adjustment } = fixture();
  source.adjustments!.push(adjustment("census", "2024-02-03"));
  const r = layerReport(options, source);
  expect(r.rows.map((r) => r.openingHens)).toEqual([100, 98, 90, 89]);
  expect(r.rows[1].eggs).toBeNull();
  expect(r.henDays).toBeNull();
  expect(r.actualTotals).toBeNull();
  const later = layerReport({ ...options, from: "2024-02-03" }, source);
  expect(later.henDays).toBe(179);
  expect(later.henDayPercent).toBeCloseTo((160 / 179) * 100, 10);
  expect(later.modelVersion).toBe("layer-hen-day-opening-census-v2");
});
it("uses full replacement values, genuine zero backfills and exact feed while preserving originals", () => {
  const { source, options, adjustment } = fixture(),
    before = structuredClone(source.records);
  source.adjustments!.push(
    adjustment("daily", "2024-02-02", {
      mortality: 0,
      eggs: 0,
      cracked: 0,
      feed_kg: "0.000000",
      notes: "Genuine zero sheet",
    }),
  );
  const original = source.records[0];
  source.adjustments!.push(
    adjustment("daily", "2024-02-01", {
      base_record_id: original.id,
      mortality: 5,
      eggs: 70,
      cracked: 2,
      feed_kg: "1.123456",
      notes: "Reviewed source",
    }),
  );
  const r = layerReport(options, source);
  expect(r.rows.map((r) => r.openingHens)).toEqual([100, 95, 95, 94]);
  expect(r.actualTotals).toMatchObject({
    eggs: 230,
    mortality: 7,
    feedKg: "3.123456",
  });
  expect(source.records).toEqual(before);
});
it("applies only the latest linked review and rejects incomplete, branching or foreign source histories", () => {
  const { source, options, adjustment } = fixture();
  const a = adjustment("census", "2024-02-03"),
    b = adjustment("census", "2024-02-03", {
      previous_id: a.id,
      opening_hens: 80,
    });
  source.adjustments = [a, b];
  expect(layerReport(options, source).rows[2].openingHens).toBe(80);
  source.adjustments = [b];
  expect(() => layerReport(options, source)).toThrow(/Incomplete/);
  source.adjustments = [a, b, { ...b, id: randomUUID() }];
  expect(() => layerReport(options, source)).toThrow(/branching/);
  source.adjustments = [{ ...a, organization_id: randomUUID() }];
  expect(() => layerReport(options, source)).toThrow(/match/);
});
it("checks mortality separately on both sides of every census rather than hiding earlier impossible losses", () => {
  const { source, options, adjustment } = fixture();
  source.records[0].mortality = 101;
  source.adjustments = [
    adjustment("census", "2024-02-03", { opening_hens: 200 }),
  ];
  expect(() => layerReport(options, source)).toThrow(/census segment/);
  source.records[0].mortality = 2;
  source.adjustments = [
    adjustment("census", "2024-02-03", { opening_hens: 1 }),
  ];
  expect(() => layerReport(options, source)).toThrow(/census segment/);
});
it("treats a census on an unrecorded day as opening knowledge only and loses knowledge again after a later gap", () => {
  const { source, options, adjustment } = fixture();
  source.adjustments = [adjustment("census", "2024-02-02")];
  const r = layerReport(options, source);
  expect(r.rows[1].openingHens).toBe(90);
  expect(r.rows[1].closingHens).toBeNull();
  expect(r.rows[2].openingHens).toBeNull();
});
it("requires complete explicit daily values, bounded exact decimal feed, evidence and a distinct census payload", () => {
  const base = {
    organizationId: randomUUID(),
    unitId: randomUUID(),
    eventId: randomUUID(),
    date: "2024-02-01",
    previousId: null,
    reason: "Reviewed dated observation",
    evidence: "Count sheet",
  };
  expect(
    layerAdjustmentInput.parse({
      ...base,
      kind: "daily",
      baseRecordId: null,
      mortality: 0,
      eggs: 0,
      cracked: 0,
      feedKg: "0",
      notes: "",
    }),
  ).toMatchObject({ feedKg: "0.000000" });
  for (const value of [
    {
      ...base,
      kind: "daily",
      baseRecordId: null,
      eggs: 0,
      cracked: 0,
      feedKg: "0",
      notes: "",
    },
    { ...base, kind: "census", openingHens: 90, eggs: 1 },
    {
      ...base,
      kind: "daily",
      baseRecordId: null,
      mortality: 0,
      eggs: 1,
      cracked: 2,
      feedKg: "1.1234567",
      notes: "",
    },
  ])
    expect(layerAdjustmentInput.safeParse(value).success).toBe(false);
});
