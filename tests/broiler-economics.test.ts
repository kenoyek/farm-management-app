import { expect, it } from "vitest";
import Decimal from "decimal.js";
import {
  projectEconomics,
  economicsData,
  compareEconomics,
  economicsCsv,
  type EconomicsReport,
} from "../src/lib/broiler-economics";
import { projectBroilerPlan } from "../src/lib/broiler-planning";
import { economicsFixture, economicsPlan } from "./broiler-economics-fixture";
const make = (id: string, input = economicsFixture()): EconomicsReport => {
  const p = economicsPlan();
  return {
    source: {
      id,
      organization_id: p.organization_id,
      unit_id: p.unit_id,
      previous_id: null,
      revision: 1,
      plan_id: p.id,
      model_version: "broiler-declared-budget-yield-v1",
      input,
      plan_snapshot: p,
      created_by: p.created_by,
      created_at: p.created_at,
    },
    plan: {
      source: p,
      forecast: projectBroilerPlan(p.input, p.unit_snapshot),
      evidenceSha256: "test",
    },
    economics: projectEconomics(input, p),
    evidenceSha256: "test",
  };
};
it("allocates exact source feed/chicks once and computes declared processed yield, margin and break-even", () => {
  const p = economicsPlan(),
    before = JSON.stringify(p),
    r = projectEconomics(economicsFixture(), p);
  expect(r).toMatchObject({
    currency: "NGN",
    expectedSaleBirds: "81.00000000",
    expectedLiveKg: "178.200000",
    expectedProcessedKg: "133.650000",
    totalPlannedCost: "229.5500",
    expectedRevenue: "2673.0000",
    projectedMargin: "2443.4500",
    costPerSurvivingBird: "2.8340",
    costPerLiveKg: "1.2882",
    costPerProcessedKg: "1.7175",
    breakEvenSalePrice: "1.7175",
    marginPercent: "91.412271",
    missingCosts: [],
    issues: [],
  });
  expect(r.costs.map((c) => c.amount)).toEqual([
    "123.4500",
    "96.1000",
    "10.0000",
    ...Array(7).fill("0.0000"),
  ]);
  expect(JSON.stringify(p)).toBe(before);
});
it("distinguishes a declared complete budget, unknown category, missing feed/chick assumptions and explicit zeros", () => {
  const p = economicsPlan(),
    d = economicsFixture();
  d.completeBudget = false;
  expect(projectEconomics(d, p)).toMatchObject({
    knownCostSubtotal: "229.5500",
    totalPlannedCost: null,
    projectedMargin: null,
    breakEvenSalePrice: null,
    expectedRevenue: "2673.0000",
  });
  d.completeBudget = true;
  d.costs[0].amount = null;
  p.input.chickCostPerBird = null;
  p.input.stages[0].pricePerKg = null;
  expect(projectEconomics(d, p)).toMatchObject({
    knownCostSubtotal: "0.0000",
    totalPlannedCost: null,
    missingCosts: ["chicks", "feed", "health"],
    projectedMargin: null,
  });
  p.input.chickCostPerBird = "0";
  p.input.stages.forEach((s) => (s.pricePerKg = "0"));
  d.costs[0].amount = "0";
  d.salePrice = "0";
  expect(projectEconomics(d, p)).toMatchObject({
    totalPlannedCost: "0.0000",
    expectedRevenue: "0.0000",
    projectedMargin: "0.0000",
    marginPercent: null,
    breakEvenSalePrice: "0.0000",
  });
});
it("uses one exclusive bird/live-kg/processed-kg sale basis and withholds unknown or zero denominators", () => {
  const p = economicsPlan(),
    d = economicsFixture();
  d.saleBasis = "bird";
  d.yieldFraction = null;
  d.yieldEvidence = "";
  d.salePrice = "10";
  expect(projectEconomics(d, p)).toMatchObject({
    expectedProcessedKg: null,
    saleQuantity: "81.00000000",
    expectedRevenue: "810.0000",
    breakEvenSalePrice: "2.8340",
  });
  d.saleBasis = "liveKg";
  expect(projectEconomics(d, p).expectedRevenue).toBe("1782.0000");
  d.saleBasis = "processedKg";
  expect(projectEconomics(d, p)).toMatchObject({
    saleQuantity: null,
    expectedRevenue: null,
    projectedMargin: null,
  });
  d.yieldFraction = "0";
  d.yieldEvidence = "Synthetic zero saleable yield";
  expect(projectEconomics(d, p)).toMatchObject({
    saleQuantity: "0.000000",
    expectedRevenue: "0.0000",
    projectedMargin: "-229.5500",
    breakEvenSalePrice: null,
    costPerProcessedKg: null,
    marginPercent: null,
  });
  d.salePrice = null;
  expect(projectEconomics(d, p).expectedRevenue).toBeNull();
  p.input.stages[0].mortalityDaily = null;
  expect(projectEconomics(d, p)).toMatchObject({
    expectedSaleBirds: null,
    expectedLiveKg: null,
    totalPlannedCost: null,
  });
});
it("carries unrounded mortality, biomass, feed and money into economics instead of multiplying displayed outputs", () => {
  const p = economicsPlan(),
    d = economicsFixture();
  p.unit_snapshot.opening_count = 1;
  p.input.chickCostPerBird = "0";
  p.input.stages.forEach((s) => {
    s.mortalityDaily = "0.12345678";
    s.pricePerKg = "0.0001";
    s.rationG = "0.000001";
  });
  d.costs.forEach((c) => (c.amount = "0"));
  d.yieldFraction = "0.12345678";
  d.salePrice = "99999999.9999";
  const Exact = Decimal.clone({ precision: 40 }),
    birds = new Exact(1).minus("0.12345678").pow(3),
    quantity = birds.mul("2.2").mul("0.12345678"),
    expected = quantity.mul(d.salePrice).toFixed(4);
  const r = projectEconomics(d, p);
  expect(r.expectedRevenue).toBe(expected);
  expect(new Exact(r.saleQuantity!).mul(d.salePrice).toFixed(4)).not.toBe(
    expected,
  );
  expect(r.totalPlannedCost).toBe("0.0000");
  expect(r.breakEvenSalePrice).not.toBeNull();
});
it("rejects fabricated totals, duplicates, negative/invalid precision and unsubstantiated price/yield claims", () => {
  const d = economicsFixture();
  for (const patch of [
    { profit: 1 },
    { salePrice: "NaN" },
    { salePrice: "-1" },
    { salePrice: "1.00001" },
    { yieldFraction: "1.01" },
    { yieldFraction: "0.123456789" },
    { completeBudget: null },
    { priceEvidence: "" },
    { yieldEvidence: "" },
    { saleBasis: "liveKg" },
    { costs: [...d.costs.slice(1), d.costs[1]] },
  ])
    expect(economicsData.safeParse({ ...d, ...patch }).success).toBe(false);
  expect(
    economicsData.parse({ ...d, salePrice: "0", yieldFraction: "0" }),
  ).toMatchObject({ salePrice: "0.0000", yieldFraction: "0.00000000" });
});
it("compares two to four saved same-currency whole batches, reverses baselines and retains unavailable outcomes", () => {
  const a = make("a"),
    d = economicsFixture();
  d.costs[0].amount = "20";
  const b = make("b", d),
    r = compareEconomics([a, b], "a");
  expect(r.comparisons[1].deltas).toEqual({
    totalPlannedCost: "10.0000",
    expectedRevenue: "0.0000",
    projectedMargin: "-10.0000",
  });
  expect(
    compareEconomics([a, b], "b").comparisons[0].deltas.projectedMargin,
  ).toBe("10.0000");
  d.costs[0].amount = null;
  const unknown = make("unknown", d);
  expect(
    compareEconomics([a, unknown], "a").comparisons[1].deltas.projectedMargin,
  ).toBeNull();
  b.economics.currency = "USD";
  expect(() => compareEconomics([a, b], "a")).toThrow("currency");
  b.economics.currency = "NGN";
  b.source.unit_id = "other";
  expect(() => compareEconomics([a, b], "a")).toThrow("same batch");
  expect(() => compareEconomics([a, a], "a")).toThrow("distinct");
  expect(() => compareEconomics([a], "a")).toThrow("two to four");
  expect(() => compareEconomics([a, unknown], "missing")).toThrow("baseline");
});
it("exports complete source/plan budgets and comparisons while neutralizing formula-like labels and preserving unknowns", () => {
  const d = economicsFixture();
  d.name = "=Synthetic export";
  d.costs[0].amount = null;
  const a = make("a", d),
    b = make("b");
  const csv = economicsCsv(a);
  expect(csv).toContain('"Scenario name","\'=Synthetic export"');
  expect(csv).toContain('"totalPlannedCost",""');
  expect(csv).toContain('"Immutable source"');
  expect(csv).toContain('"Linked plan report"');
  expect(
    economicsCsv({ ...compareEconomics([a, b], "b"), evidenceSha256: "test" }),
  ).toContain('"Comparison source"');
});
