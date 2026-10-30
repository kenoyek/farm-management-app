import { z } from "zod";
import Decimal from "decimal.js";
import type { BroilerSource } from "./broiler-lifecycle";
const uuid = z.uuid().transform((v) => v.toLowerCase());
export const broilerLossInput = z
  .strictObject({
    organizationId: uuid,
    unitId: uuid,
    reviewId: uuid,
    kind: z.enum(["daily", "cull"]),
    date: z.iso.date(),
    targetEventId: uuid.nullable(),
    sourceId: uuid,
    sourceCount: z.number().int().min(1).max(1e8),
    weightKg: z
      .string()
      .refine(
        (v) =>
          /^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/.test(v) &&
          new Decimal(v).gt(0) &&
          new Decimal(v).lte(1e8),
        "Supply a positive measured group kg value, or explicitly unknown.",
      )
      .transform((v) => new Decimal(v).toFixed(6))
      .nullable(),
    measurementBasis: z.literal("whole-bird-at-loss"),
    previousId: uuid.nullable(),
    expectedPosition: z.string().regex(/^(0|[1-9]\d{0,18})$/),
    expectedDailyId: uuid.nullable(),
    reason: z.string().trim().min(10).max(2000),
    evidence: z.string().trim().min(3).max(2000),
  })
  .refine(
    (v) => (v.kind === "daily") === (v.targetEventId === null),
    "Daily losses use their observation date; culls require the exact original event.",
  );
export type BroilerLossInput = z.infer<typeof broilerLossInput>;
export type BroilerLossReview = {
  id: string;
  organization_id: string;
  unit_id: string;
  kind: "daily" | "cull";
  observed_on: string;
  target_event_id: string | null;
  source_id: string;
  source_count: number;
  weight_kg: string | null;
  measurement_basis: "whole-bird-at-loss";
  previous_id: string | null;
  position: string;
  expected_position: string;
  expected_daily_id: string | null;
  reason: string;
  evidence: string;
  source_snapshot: Record<string, unknown>;
  submission: BroilerLossInput;
  created_by: string;
  created_at: string;
};
export function lossHeads(reviews: BroilerLossReview[]) {
  const replaced = new Set(reviews.map((r) => r.previous_id));
  return reviews.filter((r) => !replaced.has(r.id));
}
export function broilerLossEvidence(s: BroilerSource) {
  const heads = lossHeads(s.lossReviews ?? []),
    voids = new Set(s.events.map((e) => e.void_of_id));
  const targets = [
    ...s.records
      .filter((r) => r.mortality > 0)
      .map((r) => ({
        key: "daily:" + r.recorded_on,
        kind: "daily" as const,
        date: r.recorded_on,
        targetEventId: null as string | null,
        sourceId: r.adjustment_id ?? r.id,
        sourceCount: r.mortality,
        originalWeightKg: null as string | null,
      })),
    ...s.events
      .filter((e) => e.kind === "cull" && !voids.has(e.id))
      .map((e) => ({
        key: "cull:" + e.id,
        kind: "cull" as const,
        date: e.recorded_on,
        targetEventId: e.id,
        sourceId: e.id,
        sourceCount: e.quantity!,
        originalWeightKg: e.weight_kg,
      })),
  ]
    .sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key))
    .map((t) => {
      const review = heads.find(
        (r) =>
          r.kind === t.kind &&
          (t.kind === "daily"
            ? r.observed_on === t.date
            : r.target_event_id === t.targetEventId),
      );
      const stale =
        !!review &&
        (review.source_id !== t.sourceId ||
          review.source_count !== t.sourceCount);
      const weightKg = review
        ? stale
          ? null
          : review.weight_kg
        : t.originalWeightKg;
      return {
        ...t,
        reviewId: review?.id ?? null,
        weightKg,
        state: stale
          ? "stale"
          : weightKg === null
            ? "unknown"
            : review
              ? "reviewed"
              : "original",
        evidence: review?.evidence ?? null,
      };
    });
  const history = heads.map((r) => ({
    id: r.id,
    status: targets.find((t) => t.reviewId === r.id)?.state ?? "inactive",
    kind: r.kind,
    date: r.observed_on,
    targetEventId: r.target_event_id,
  }));
  return { targets, history };
}
