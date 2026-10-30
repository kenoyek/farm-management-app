import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  broilerPlanData,
  projectBroilerPlan,
  type PlanUnit,
} from "../src/lib/broiler-planning";
import { planFixture } from "./broiler-planning-fixture";
const unit: PlanUnit = {
  id: randomUUID(),
  organization_id: randomUUID(),
  farm_id: randomUUID(),
  name: "Synthetic actual batch",
  kind: "broilers",
  stocked_on: "2024-02-01",
  opening_count: 100,
  initial_weight_g: "1000.000000",
};
it("projects exact daily opening-stock feed, source mortality and linear target weights without posting actuals", () => {
  const input = broilerPlanData.parse(planFixture()),
    before = JSON.stringify(input),
    r = projectBroilerPlan(input, unit);
  expect(r).toMatchObject({
    durationDays: 3,
    plannedHarvestDate: "2024-02-04",
    expectedClosingBirds: "81.00000000",
    expectedDeaths: "19.00000000",
    feedKg: "35.200000",
    feedCost: "96.1000",
    chickCost: "123.4500",
    expectedHarvestBiomassKg: "178.200000",
    expectedGrossLiveValue: "1782.0000",
    averageDailyGainG: "400.000000",
  });
  expect(r.rows.map((d) => d.targetWeightG)).toEqual([
    "1000.000000",
    "1500.000000",
    "2000.000000",
  ]);
  expect(r.rows.map((d) => d.feedKg)).toEqual([
    "10.000000",
    "9.000000",
    "16.200000",
  ]);
  expect(JSON.stringify(input)).toBe(before);
});
it("propagates missing mortality/feed/price distinctly from explicit zero assumptions", () => {
  const p = broilerPlanData.parse(planFixture());
  p.stages[0].pricePerKg = null;
  expect(projectBroilerPlan(p, unit)).toMatchObject({
    feedKg: "35.200000",
    feedCost: null,
  });
  p.stages[0].mortalityDaily = null;
  const r = projectBroilerPlan(p, unit);
  expect(r.rows[0].feedKg).toBe("10.000000");
  expect(r).toMatchObject({
    feedKg: null,
    expectedClosingBirds: null,
    expectedHarvestBiomassKg: null,
    expectedGrossLiveValue: null,
  });
  p.stages.forEach((s) => {
    s.rationG = "0";
    s.mortalityDaily = "0";
    s.pricePerKg = "0";
  });
  expect(projectBroilerPlan(p, unit)).toMatchObject({
    feedKg: "0.000000",
    feedCost: "0.0000",
    expectedClosingBirds: "100.00000000",
  });
});
it("handles leap-day age alignment and explicit bird rather than kg pricing", () => {
  const p = broilerPlanData.parse(planFixture());
  p.hatchDate = null;
  p.saleBasis = "bird";
  p.salePrice = "3.3333";
  expect(
    projectBroilerPlan(p, { ...unit, stocked_on: "2024-02-28" }),
  ).toMatchObject({
    plannedHarvestDate: "2024-03-02",
    expectedGrossLiveValue: "269.9973",
  });
  expect(
    projectBroilerPlan(p, { ...unit, stocked_on: "2024-02-28" }).rows[1].date,
  ).toBe("2024-02-29");
});
it("requires ordered complete age schedules, cited targets and paired guide temperatures", () => {
  for (const change of [
    (p: ReturnType<typeof planFixture>) => (p.stages[1].startAge = 8),
    (p: ReturnType<typeof planFixture>) => (p.stages[1].endAge = 10),
    (p: ReturnType<typeof planFixture>) => (p.targets[1].ageDays = 9),
    (p: ReturnType<typeof planFixture>) => (p.sourceReference = ""),
    (p: ReturnType<typeof planFixture>) => (p.stages[0].tempMaxC = null),
    (p: ReturnType<typeof planFixture>) => (p.stages[0].tempMinC = "31"),
    (p: ReturnType<typeof planFixture>) => (p.stages[0].rationG = "NaN"),
    (p: ReturnType<typeof planFixture>) =>
      (p.stages[0].mortalityDaily = "1.000000001"),
  ]) {
    const p = planFixture();
    change(p);
    expect(broilerPlanData.safeParse(p).success).toBe(false);
  }
});
it("refuses mismatched hatch age, undefined prices and unsupported planning outputs", () => {
  const p = broilerPlanData.parse(planFixture());
  p.hatchDate = "2024-01-26";
  expect(() => projectBroilerPlan(p, unit)).toThrow("Hatch");
  expect(
    broilerPlanData.safeParse({ ...planFixture(), salePrice: null }).success,
  ).toBe(false);
  expect(
    broilerPlanData.safeParse({ ...planFixture(), result: { profit: 1 } })
      .success,
  ).toBe(false);
});
it("does not manufacture FCR, profit or processed yield from a live-weight planning guide", () => {
  const p = broilerPlanData.parse({
    ...planFixture(),
    saleBasis: "unpriced",
    salePrice: null,
    chickCostPerBird: null,
  });
  const r = projectBroilerPlan(p, unit);
  expect(r.expectedGrossLiveValue).toBeNull();
  expect(r.chickCost).toBeNull();
  expect(r).not.toHaveProperty("profit");
  expect(r).not.toHaveProperty("fcr");
  expect(r).not.toHaveProperty("processedYield");
  const dec = broilerPlanData.safeParse({
    ...planFixture(),
    stages: [
      { ...planFixture().stages[0], rationG: "invalid" },
      planFixture().stages[1],
    ],
  });
  expect(dec.success).toBe(false);
});
