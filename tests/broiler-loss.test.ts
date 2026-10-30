import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  broilerSummary,
  broilerCsv,
  broilerEvidence,
} from "../src/lib/broiler-lifecycle";
import { broilerLossInput, broilerLossEvidence } from "../src/lib/broiler-loss";
import {
  lossFixture,
  measuredLossFixture,
  weightReview,
} from "./broiler-loss-fixture";
it("includes measured deaths, culls and live harvests once in complete cohort gain without altering counts, feed or prices", () => {
  const s = measuredLossFixture(),
    before = JSON.stringify(s),
    r = broilerSummary(s);
  expect(r).toMatchObject({
    balance: 84,
    mortality: 3,
    culled: 3,
    harvested: 10,
    feedKg: "30.000000",
    measuredDeathKg: "3.900000",
    knownMeasuredDeathKg: "3.900000",
    measuredWithdrawalKg: "24.500000",
    estimatedClosingBiomassKg: "210.000000",
    cohortGainKg: "138.400000",
    fcr: "0.216763",
    expectedPosition: "5",
    sales: { NGN: "60.0000" },
  });
  expect(r.lossEvidence.targets.map((t) => t.state)).toEqual([
    "reviewed",
    "reviewed",
    "reviewed",
  ]);
  expect(JSON.stringify(s)).toBe(before);
  expect(r.asOf).toBe("2024-02-02");
});
it("withholds death biomass and gain when any positive daily loss lacks a current exact revision/count", () => {
  const s = measuredLossFixture();
  s.records[0].adjustment_id = randomUUID();
  const r = broilerSummary(s);
  expect(r).toMatchObject({
    measuredDeathKg: null,
    knownMeasuredDeathKg: "1.500000",
    cohortGainKg: null,
    fcr: null,
  });
  expect(
    r.lossEvidence.targets.find(
      (t) => t.date === "2024-02-01" && t.kind === "daily",
    )?.state,
  ).toBe("stale");
  s.lossReviews!.push({
    ...weightReview(s, "daily", "2024-02-01", "2.4", "6"),
    previous_id: s.lossReviews![0].id,
  });
  expect(broilerSummary(s).fcr).toBe("0.216763");
  s.records[0].mortality = 3;
  expect(broilerSummary(s).fcr).toBeNull();
});
it("lets an explicit unknown cull review supersede an original measured total without falling back or double counting", () => {
  const s = measuredLossFixture();
  s.events[0].weight_kg = "8";
  expect(broilerSummary(s).measuredWithdrawalKg).toBe("24.500000");
  const previous = s.lossReviews![2];
  s.lossReviews!.push({
    ...weightReview(s, "cull", "2024-02-01", null, "6"),
    previous_id: previous.id,
  });
  expect(broilerSummary(s)).toMatchObject({
    measuredWithdrawalKg: "20.000000",
    cohortGainKg: null,
    fcr: null,
  });
  expect(
    broilerLossEvidence(s).targets.find((t) => t.kind === "cull"),
  ).toMatchObject({ originalWeightKg: "8", weightKg: null, state: "unknown" });
  expect(s.events[0].weight_kg).toBe("8");
});
it("retains inactive weight history after a cull void or corrected zero deaths, and excludes it from biomass", () => {
  const s = measuredLossFixture();
  s.events.push({
    ...s.events[0],
    id: randomUUID(),
    kind: "void",
    position: "6",
    void_of_id: s.events[0].id,
    quantity: null,
    weight_kg: null,
  });
  s.records[0].mortality = 0;
  s.records[0].adjustment_id = randomUUID();
  const r = broilerSummary(s);
  expect(r).toMatchObject({
    balance: 89,
    measuredDeathKg: "1.500000",
    measuredWithdrawalKg: "20.000000",
    cohortGainKg: "144.000000",
  });
  expect(
    r.lossEvidence.history.filter((h) => h.status === "inactive"),
  ).toHaveLength(2);
  expect(s.lossReviews).toHaveLength(3);
});
it("retains complete-feed, positive-gain and post-withdrawal sampling gates even with all losses weighed", () => {
  const s = measuredLossFixture();
  s.records.splice(1, 1);
  expect(broilerSummary(s).fcrUnavailableReasons.join(" ")).toContain(
    "after the last withdrawal",
  );
  const gap = measuredLossFixture();
  gap.records[1].recorded_on = "2024-02-03";
  expect(broilerSummary(gap).completeFeed).toBe(false);
  expect(broilerSummary(gap).fcr).toBeNull();
  const negative = measuredLossFixture();
  negative.unit.initial_weight_g = "10000";
  expect(broilerSummary(negative).fcr).toBeNull();
  const unknown = lossFixture();
  expect(broilerSummary(unknown)).toMatchObject({
    measuredDeathKg: null,
    cohortGainKg: null,
    fcr: null,
  });
});
it("allows a complete weighed final harvest with measured death biomass and no invented remaining sample", () => {
  const s = measuredLossFixture();
  s.events[1].recorded_on = "2024-02-02";
  s.events[1].quantity = 94;
  s.events[1].weight_kg = "235";
  s.records.forEach((r) => {
    r.average_weight_g = null;
    r.sample_size = null;
  });
  expect(broilerSummary(s)).toMatchObject({
    balance: 0,
    estimatedClosingBiomassKg: "0.000000",
    cohortGainKg: "143.400000",
    fcr: "0.209205",
  });
});
it("validates exact whole-bird measurements and normalizes receipts without permitting assumed masses or derived results", () => {
  const s = measuredLossFixture(),
    r = s.lossReviews![0],
    p = {
      organizationId: r.organization_id,
      unitId: r.unit_id,
      reviewId: r.id,
      kind: "daily",
      date: r.observed_on,
      targetEventId: null,
      sourceId: r.source_id,
      sourceCount: 2,
      weightKg: "2.4",
      measurementBasis: "whole-bird-at-loss",
      previousId: null,
      expectedPosition: "5",
      expectedDailyId: r.expected_daily_id,
      reason: r.reason,
      evidence: r.evidence,
    };
  expect(broilerLossInput.parse(p)).toMatchObject({ weightKg: "2.400000" });
  expect(broilerLossInput.parse({ ...p, weightKg: null }).weightKg).toBeNull();
  for (const patch of [
    { weightKg: "0" },
    { weightKg: "-1" },
    { weightKg: "NaN" },
    { weightKg: "1.0000001" },
    { sourceCount: 2.5 },
    { sourceCount: 0 },
    { measurementBasis: "sample-estimate" },
    { targetEventId: randomUUID() },
    { cohortGainKg: "900" },
  ])
    expect(broilerLossInput.safeParse({ ...p, ...patch }).success).toBe(false);
});
it("exports every loss review, its exact original source and the current evidence state with a versioned source model", () => {
  const s = measuredLossFixture();
  s.lossReviews![0].reason = "=Synthetic review source";
  const evidence = broilerEvidence(s);
  expect(evidence.modelVersion).toBe("broiler-reviewed-loss-biomass-v3");
  expect(evidence.lossReviews).toEqual(s.lossReviews);
  const csv = broilerCsv({
    ...s,
    modelVersion: evidence.modelVersion,
    summary: broilerSummary(s),
    evidenceSha256: "synthetic-digest",
  });
  expect(csv).toContain('"Loss biomass review history"');
  expect(csv).toContain('"Current loss biomass evidence"');
  expect(csv).toContain('"Complete original loss source"');
  expect(csv).toContain("'=Synthetic review source");
  expect(csv).toContain('"Measured dead-bird kg","3.900000"');
  expect(csv).toContain(s.lossReviews![0].source_id);
});
