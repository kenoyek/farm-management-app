import { z } from "zod";
import Decimal from "decimal.js";
import type { BroilerEvent } from "./broiler-lifecycle";
const decimal = (max: number, zero: boolean) =>
  z
    .string()
    .refine((v) => {
      if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/.test(v)) return false;
      const n = new Decimal(v);
      return n.lte(max) && (zero || n.gt(0));
    }, "Enter a decimal within range, with at most six places.")
    .transform((v) => new Decimal(v).toFixed(6));
const common = {
  organizationId: z.uuid(),
  unitId: z.uuid(),
  eventId: z.uuid(),
  date: z.iso.date(),
  previousId: z.uuid().nullable(),
  expectedPosition: z.string().regex(/^(0|[1-9]\d{0,18})$/),
  expectedDailyId: z.uuid().nullable(),
  reason: z.string().trim().min(10).max(2000),
  evidence: z.string().trim().min(3).max(2000),
};
export const broilerReviewInput = z.discriminatedUnion("kind", [
  z.strictObject({
    ...common,
    kind: z.literal("withdrawal"),
    treatmentId: z.uuid(),
    earliestHarvestOn: z.iso.date().nullable(),
  }),
  z
    .strictObject({
      ...common,
      kind: z.literal("daily"),
      baseRecordId: z.uuid().nullable(),
      mortality: z.number().int().min(0).max(1e8),
      feedKg: decimal(1e8, true),
      averageWeightG: decimal(1e6, false).nullable(),
      sampleSize: z.number().int().min(1).max(1e8).nullable(),
      notes: z.string().max(2000),
    })
    .refine(
      (v) => (v.averageWeightG === null) === (v.sampleSize === null),
      "Average weight and sample size must both be supplied or both unknown.",
    ),
]);
export type BroilerReviewInput = z.infer<typeof broilerReviewInput>;
export type BroilerReview = {
  id: string;
  organization_id: string;
  unit_id: string;
  kind: "withdrawal" | "daily";
  observed_on: string;
  previous_id: string | null;
  base_record_id: string | null;
  treatment_id: string | null;
  mortality: number | null;
  feed_kg: string | null;
  average_weight_g: string | null;
  sample_size: number | null;
  notes: string | null;
  earliest_harvest_on: string | null;
  position: string;
  expected_position: string;
  expected_daily_id: string | null;
  reason: string;
  evidence: string;
  created_by: string;
  created_at: string;
  submission: BroilerReviewInput;
};
export function currentBroilerReviews(reviews: BroilerReview[]) {
  const replaced = new Set(reviews.map((r) => r.previous_id));
  return reviews.filter((r) => !replaced.has(r.id));
}
export function broilerTreatments(
  events: BroilerEvent[],
  reviews: BroilerReview[],
) {
  const voids = new Set(events.map((e) => e.void_of_id));
  const heads = currentBroilerReviews(reviews).filter(
    (r) => r.kind === "withdrawal",
  );
  return events
    .filter((e) => e.kind === "treatment" && !voids.has(e.id))
    .map((e) => {
      const r = heads.find((r) => r.treatment_id === e.id);
      return {
        ...e,
        original_earliest_harvest_on: e.earliest_harvest_on,
        earliest_harvest_on: r ? r.earliest_harvest_on : e.earliest_harvest_on,
        review_id: r?.id ?? null,
        reviewed_on: r?.observed_on ?? null,
        review_reason: r?.reason ?? null,
        review_evidence: r?.evidence ?? null,
      };
    });
}
