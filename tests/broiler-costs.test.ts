import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  actualCostData,
  allocateActualCosts,
  actualCostCsv,
  actualCostModel,
  type ActualCostReview,
} from "../src/lib/broiler-costs";
import { costFixture, costSource } from "./broiler-costs-fixture";
it("reconciles incurred category totals across explicit lot allocation, sold/lost/remaining kg and unallocated batch cost", () => {
  const s = costSource(),
    p = costFixture(s.events[0].id),
    r = allocateActualCosts(p, s);
  expect(r).toMatchObject({
    currency: "NGN",
    throughDate: "2024-02-03",
    knownCostSubtotal: "300.0000",
    totalDeclaredIncurredCost: "300.0000",
    allocatedCost: "150.0001",
    unallocatedKnownCost: "149.9999",
    unknownCategories: [],
  });
  expect(r.lots[0]).toMatchObject({
    receivedKg: "14.000000",
    soldKg: "3.123456",
    lostKg: "0.123456",
    remainingKg: "10.753088",
    allocatedCostPerKg: "10.71429286",
    recordedSales: { NGN: "3.8559" },
  });
  expect(
    Number(r.soldKgCost) + Number(r.lostKgCost) + Number(r.remainingKgCost),
  ).toBeCloseTo(150.0001, 8);
  expect(r).not.toHaveProperty("profit");
  expect(r).not.toHaveProperty("cash");
});
it("uses cumulative four-place kg apportionment so rounding never manufactures or loses cost", () => {
  const s = costSource();
  s.events[0].weight_kg = "3.000000";
  s.events[1].weight_kg = "1.000000";
  s.events[2].weight_kg = "1.000000";
  const p = costFixture(s.events[0].id);
  p.allocations[0].amount = "0.0001";
  const r = allocateActualCosts(p, s);
  expect(r).toMatchObject({
    soldKgCost: "0.0000",
    lostKgCost: "0.0001",
    remainingKgCost: "0.0000",
    allocatedCost: "0.0001",
    unallocatedKnownCost: "299.9999",
  });
});
it("keeps missing costs distinct from evidenced zeros and withholds a complete total without complete review", () => {
  const s = costSource(),
    p = costFixture();
  p.costs[1].amount = null;
  p.costs[1].evidence = "";
  expect(allocateActualCosts(p, s)).toMatchObject({
    knownCostSubtotal: "100.0000",
    totalDeclaredIncurredCost: null,
    unknownCategories: ["feed"],
  });
  p.costs[1].amount = "0";
  p.costs[1].evidence = "Synthetic explicit no consumed feed cost";
  p.completeCosts = false;
  expect(allocateActualCosts(p, s).totalDeclaredIncurredCost).toBeNull();
  p.completeCosts = true;
  expect(allocateActualCosts(p, s).totalDeclaredIncurredCost).toBe("100.0000");
  p.allocations = [
    {
      lotId: s.events[0].id,
      amount: "0",
      evidence: "Synthetic by-product nil cost policy",
    },
  ];
  expect(allocateActualCosts(p, s).lots[0].allocatedCost).toBe("0.0000");
});
it("requires exact categories, non-overlapping known allocations, complete shape and evidence for every known zero", () => {
  const p = costFixture(randomUUID());
  for (const patch of [
    { costs: Array(10).fill(p.costs[0]) },
    { costs: p.costs.slice(1) },
    { allocations: [p.allocations[0], p.allocations[0]] },
    { allocations: [{ ...p.allocations[0], amount: "300.0001" }] },
    { costs: p.costs.map((c) => ({ ...c, evidence: "" })) },
    { currency: "ngn" },
    { policy: "infer-by-sale-price" },
    { scope: "forecast-costs" },
    { profit: "100" },
  ])
    expect(actualCostData.safeParse({ ...p, ...patch }).success).toBe(false);
});
it("refuses foreign/voided receipt targets and never derives allocation from sale values or forecast costs", () => {
  const s = costSource(),
    p = costFixture(randomUUID());
  expect(() => allocateActualCosts(p, s)).toThrow("active receipt");
  p.allocations[0].lotId = s.events[0].id;
  s.events.push({
    ...s.events[0],
    id: randomUUID(),
    kind: "void",
    position: "4",
    void_of_id: s.events[0].id,
  });
  expect(() => allocateActualCosts(p, s)).toThrow("active receipt");
  p.allocations = [];
  expect(allocateActualCosts(p, s).unallocatedKnownCost).toBe("300.0000");
});
it("preserves original currency sales separately and includes fully dispatched lots without zero denominators", () => {
  const s = costSource();
  s.events[1].weight_kg = "14.000000";
  s.events[1].currency = "USD";
  s.events = s.events.slice(0, 2);
  const r = allocateActualCosts(costFixture(s.events[0].id), s);
  expect(r.lots[0]).toMatchObject({
    remainingKg: "0.000000",
    soldKgCost: "150.0001",
    lostKgCost: "0.0000",
    remainingKgCost: "0.0000",
    recordedSales: { USD: "3.8559" },
  });
  expect(r.recordedProductSaleValues).toEqual({ USD: "3.8559" });
  expect(r.currency).toBe("NGN");
});
it("retains original source/receipt history and formula-safe human evidence in cost CSV", () => {
  const s = costSource(),
    p = costFixture(s.events[0].id);
  p.costs[0].evidence = "=Synthetic incurred voucher";
  p.allocations[0].evidence = "=Synthetic explicit allocation";
  const source = {
      id: randomUUID(),
      revision: 1,
      input: p,
      source_snapshot: s,
    } as ActualCostReview,
    r = {
      modelVersion: actualCostModel,
      source,
      results: allocateActualCosts(p, s),
      evidenceSha256: "fixture",
    },
    csv = actualCostCsv(r);
  expect(csv).toContain("'=Synthetic incurred voucher");
  expect(csv).toContain("'=Synthetic explicit allocation");
  expect(csv).toContain('"Complete immutable source"');
  expect(csv).toContain(s.source.processingReviews[0].id);
  expect(csv).toContain(s.events[0].id);
});
