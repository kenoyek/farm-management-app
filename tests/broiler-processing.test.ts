import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  measuredProcessing,
  processingData,
  processingWorkspace,
  processingHeads,
  processingCsv,
} from "../src/lib/broiler-processing";
import { broilerSummary, broilerEvidence } from "../src/lib/broiler-lifecycle";
import type { BroilerReview } from "../src/lib/broiler-recovery";
import {
  processingFixture,
  processingSource,
  processingReview,
} from "./broiler-processing-fixture";
it("reconciles exact measured primary/by-product/residual mass and declares yield denominators", () => {
  const p = processingFixture(),
    e = processingSource().events[0];
  expect(measuredProcessing(p, e)).toEqual({
    inputBirds: 10,
    inputLiveKg: "20.000000",
    knownOutputKg: "17.000000",
    totalOutputKg: "17.000000",
    primaryOutputKg: "14.000000",
    primaryYieldFraction: "0.70000000",
    dressingYieldFraction: "0.70000000",
    knownIntendedSaleKg: "16.000000",
    intendedSaleKg: "16.000000",
    intendedYieldFraction: "0.80000000",
    measuredResidualKg: "3.000000",
    knownAccountedKg: "20.000000",
    unreconciledKg: "0.000000",
    massState: "balanced",
  });
  p.residualKg = "2";
  expect(measuredProcessing(p, e)).toMatchObject({
    measuredResidualKg: "2.000000",
    unreconciledKg: "1.000000",
    massState: "unreconciled",
  });
});
it("keeps unknown weights, unassessed intended use and explicit zero residual distinct", () => {
  const p = processingFixture(),
    e = processingSource().events[0];
  p.products[0].weightKg = null;
  p.residualKg = null;
  expect(measuredProcessing(p, e)).toMatchObject({
    knownOutputKg: "3.000000",
    totalOutputKg: null,
    primaryYieldFraction: null,
    intendedSaleKg: null,
    unreconciledKg: null,
    massState: "incomplete",
  });
  p.products[0].weightKg = "14";
  p.products[1].disposition = "unassessed";
  p.residualKg = "0";
  expect(measuredProcessing(p, e)).toMatchObject({
    totalOutputKg: "17.000000",
    primaryYieldFraction: "0.70000000",
    knownIntendedSaleKg: "14.000000",
    intendedSaleKg: null,
    intendedYieldFraction: null,
    measuredResidualKg: "0.000000",
    unreconciledKg: "3.000000",
  });
});
it("refuses excess known mass and priced/live-sold sources without silently normalizing weights", () => {
  const p = processingFixture(),
    e = processingSource().events[0];
  p.products[0].weightKg = "15.000001";
  expect(() => measuredProcessing(p, e)).toThrow("exceeds");
  p.products[0].weightKg = null;
  p.products[1].weightKg = "21";
  expect(() => measuredProcessing(p, e)).toThrow("exceeds");
  expect(() =>
    measuredProcessing(processingFixture(), {
      ...e,
      price_basis: "kg",
      amount: "0.0000",
    }),
  ).toThrow("unsold");
  expect(() =>
    measuredProcessing(
      { ...processingFixture(), processedOn: "2024-01-31" },
      e,
    ),
  ).toThrow("precede");
});
it("preserves precision and distinguishes primary cut yields from a whole-dressed yield", () => {
  const p = processingFixture(),
    e = { ...processingSource().events[0], weight_kg: "3.000001" };
  p.products = [
    {
      name: "Synthetic measured cuts",
      role: "primary",
      disposition: "intended",
      weightKg: "1.000001",
    },
  ];
  p.residualKg = "0";
  p.productForm = "cut_parts";
  expect(measuredProcessing(p, e)).toMatchObject({
    primaryYieldFraction: "0.33333356",
    dressingYieldFraction: null,
    unreconciledKg: "2.000000",
  });
});
it("requires complete distinct shape and whole-harvest scope while permitting explicitly unknown measurements", () => {
  const p = processingFixture();
  for (const patch of [
    { scope: "partial-harvest" },
    { products: [p.products[0], p.products[0]] },
    { products: p.products.map((r) => ({ ...r, role: "other" })) },
    { products: [] },
    { products: Array(13).fill(p.products[0]) },
    { residualKg: "-1" },
    { profit: "900" },
    { products: [{ ...p.products[0], weightKg: "0" }] },
  ])
    expect(processingData.safeParse({ ...p, ...patch }).success).toBe(false);
  expect(
    processingData.parse({
      ...p,
      residualKg: null,
      products: [{ ...p.products[0], weightKg: null }],
    }),
  ).toMatchObject({ residualKg: null });
});
it("keeps one current full-harvest version, preserves withdrawals and blocks source void eligibility until withdrawn", () => {
  const s = processingSource(),
    r = processingReview(s);
  s.processingReviews = [r];
  const before = broilerSummary({ ...s, processingReviews: [] }),
    after = broilerSummary(s);
  expect(after.fcr).toBe(before.fcr);
  expect(after.asOf).toBe("2024-02-02");
  expect(after.expectedPosition).toBe("3");
  expect(after.voidable).not.toContain(r.harvest_id);
  const withdrawal = {
    ...r,
    id: randomUUID(),
    previous_id: r.id,
    revision: 2,
    position: "4",
    input: {
      kind: "withdraw" as const,
      reason: "Synthetic erroneous observation withdrawn",
      evidence: "Synthetic review source",
    },
  };
  s.processingReviews.push(withdrawal);
  expect(processingHeads(s.processingReviews)).toEqual([withdrawal]);
  expect(processingWorkspace(s).lots[0]).toMatchObject({
    sourceState: "withdrawn",
    metrics: null,
  });
  s.events.push({
    ...s.events[0],
    id: randomUUID(),
    kind: "void",
    position: "5",
    void_of_id: r.harvest_id,
    quantity: null,
    weight_kg: null,
  });
  expect(processingWorkspace(s).harvests).toHaveLength(0);
  expect(processingWorkspace(s).lots[0].sourceState).toBe("inactive");
  expect(s.processingReviews[0].input).toEqual(r.input);
});
it("preserves actual measurements under later conflicting guidance and keeps report results independent of today's date", () => {
  const s = processingSource(),
    harvest = s.events[0],
    t = {
      ...harvest,
      id: randomUUID(),
      kind: "treatment" as const,
      position: "1",
      product: "Synthetic actual product",
      administration: "Synthetic original label record",
      earliest_harvest_on: "2024-02-01",
      quantity: 1,
    };
  s.events.unshift(t);
  s.processingReviews = [processingReview(s)];
  s.processingReviews[0].harvest_id = harvest.id;
  s.processingReviews[0].harvest_snapshot = harvest;
  s.reviews = [
    {
      id: randomUUID(),
      kind: "withdrawal",
      treatment_id: t.id,
      position: "4",
      observed_on: "2024-02-02",
      earliest_harvest_on: null,
      reason: "Synthetic later unknown guidance",
      evidence: "Synthetic guidance source",
    } as BroilerReview,
  ];
  const w = processingWorkspace(s);
  expect(w.lots[0].guidance?.currentConcerns).toHaveLength(1);
  expect(w.lots[0].metrics?.primaryOutputKg).toBe("14.000000");
  expect(processingWorkspace({ ...s, today: "2030-01-01" })).toEqual(w);
});
it("exports full original clinical/harvest/measurement sources with formula-safe review text", () => {
  const s = processingSource(),
    r = processingReview(s);
  r.input.reason = "=Synthetic scale register";
  s.processingReviews = [r];
  const source = broilerEvidence(s),
    csv = processingCsv({
      modelVersion: "broiler-whole-harvest-measured-yields-v1",
      source,
      results: processingWorkspace(s),
      evidenceSha256: "test",
    });
  expect(csv).toContain('"Complete lifecycle source"');
  expect(csv).toContain('"Complete original harvest"');
  expect(csv).toContain("'=Synthetic scale register");
  expect(csv).toContain(r.harvest_id);
  expect(source.processingReviews).toEqual([r]);
});
