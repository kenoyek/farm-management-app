import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  broilerReviewInput,
  broilerTreatments,
  type BroilerReview,
} from "../src/lib/broiler-recovery";
import {
  broilerSummary,
  type BroilerEvent,
  type BroilerSource,
} from "../src/lib/broiler-lifecycle";
const uuid = randomUUID();
const base = {
  organizationId: randomUUID(),
  unitId: uuid,
  eventId: randomUUID(),
  date: "2024-02-05",
  previousId: null,
  expectedPosition: "0",
  expectedDailyId: null,
  reason: "Synthetic complete review",
  evidence: "Synthetic source",
};
const treatment = {
  id: randomUUID(),
  kind: "treatment",
  recorded_on: "2024-02-01",
  quantity: 10,
  earliest_harvest_on: null,
  position: "1",
} as BroilerEvent;
const review = (p: Partial<BroilerReview>) =>
  ({
    id: randomUUID(),
    kind: "withdrawal",
    treatment_id: treatment.id,
    observed_on: "2024-02-05",
    earliest_harvest_on: "2024-02-03",
    position: "3",
    previous_id: null,
    ...p,
  }) as BroilerReview;
it("requires complete explicit daily values and a paired nullable representative sample", () => {
  const p = {
    ...base,
    kind: "daily",
    baseRecordId: null,
    mortality: 0,
    feedKg: "0",
    averageWeightG: null,
    sampleSize: null,
    notes: "",
  };
  expect(broilerReviewInput.parse(p)).toMatchObject({
    feedKg: "0.000000",
    mortality: 0,
  });
  for (const invalid of [
    { feedKg: undefined },
    { feedKg: "NaN" },
    { feedKg: "1.0000001" },
    { averageWeightG: "2000", sampleSize: null },
    { mortality: 1.5 },
    { amount: "123" },
  ])
    expect(broilerReviewInput.safeParse({ ...p, ...invalid }).success).toBe(
      false,
    );
});
it("distinguishes an unknown amended date from the original date and preserves the genuine administration", () => {
  const t = { ...treatment, earliest_harvest_on: "2024-02-02" },
    r = review({ earliest_harvest_on: null });
  const ts = broilerTreatments([t], [r]);
  expect(ts[0]).toMatchObject({
    id: t.id,
    original_earliest_harvest_on: "2024-02-02",
    earliest_harvest_on: null,
    review_id: r.id,
  });
  expect(t.earliest_harvest_on).toBe("2024-02-02");
});
it("keeps exact original/posting-time guidance while flagging a later changed-date conflict with earlier harvests", () => {
  const first = review({ position: "2", earliest_harvest_on: "2024-02-03" }),
    second = review({
      position: "4",
      previous_id: null,
      earliest_harvest_on: null,
    });
  second.previous_id = first.id;
  const harvest = {
    id: randomUUID(),
    kind: "harvest",
    recorded_on: "2024-02-03",
    quantity: 2,
    weight_kg: "4",
    position: "3",
    amount: null,
    currency: null,
  } as BroilerEvent;
  const s: BroilerSource = {
    unit: {
      id: uuid,
      name: "Synthetic",
      kind: "broilers",
      stocked_on: "2024-02-01",
      opening_count: 10,
      initial_weight_g: "1000",
    },
    records: [],
    events: [treatment, harvest],
    reviews: [first, second],
    timezone: "Africa/Lagos",
    today: "2024-02-05",
  };
  const r = broilerSummary(s);
  expect(r.expectedPosition).toBe("4");
  expect(r.harvestGuidance[0]).toMatchObject({
    recordedHolds: [],
    currentConcerns: [
      {
        treatmentId: treatment.id,
        reviewId: second.id,
        earliestHarvestOn: null,
      },
    ],
  });
  expect(r.voidable).not.toContain(harvest.id);
  expect(r.holds).toHaveLength(1);
  expect(r.asOf).toBe("2024-02-05");
});
it("does not revive a voided administration or treat its old review as a new treatment", () => {
  const v = {
    id: randomUUID(),
    kind: "void",
    void_of_id: treatment.id,
    position: "3",
  } as BroilerEvent;
  expect(broilerTreatments([treatment, v], [review({})])).toEqual([]);
});
