import { randomUUID } from "node:crypto";
import { lossFixture } from "./broiler-loss-fixture";
import type {
  ProcessingRecord,
  ProcessingReview,
} from "../src/lib/broiler-processing";
export const processingFixture = (): ProcessingRecord => ({
  kind: "record",
  processedOn: "2024-02-03",
  productForm: "dressed_whole",
  products: [
    {
      name: "Synthetic whole dressed birds",
      role: "primary",
      disposition: "intended",
      weightKg: "14",
    },
    {
      name: "Synthetic giblets",
      role: "by_product",
      disposition: "intended",
      weightKg: "2",
    },
    {
      name: "Synthetic feathers",
      role: "other",
      disposition: "not_intended",
      weightKg: "1",
    },
  ],
  residualKg: "3",
  scope: "whole-harvest-no-added-mass",
  reason: "Synthetic measured full-harvest outputs",
  evidence:
    "Synthetic owned unsold whole group; original scale register; distinct outputs",
});
export function processingSource() {
  const s = lossFixture();
  s.events = s.events
    .filter((e) => e.kind === "harvest")
    .map((e) => ({
      ...e,
      price_basis: "unpriced" as const,
      price_per_unit: null,
      amount: null,
      currency: null,
      reference: null,
      customer: null,
    }));
  s.records.forEach((r) => (r.mortality = 0));
  s.today = "2024-02-03";
  s.processingReviews = [];
  return s;
}
export function processingReview(
  s = processingSource(),
  input = processingFixture(),
): ProcessingReview {
  return {
    id: randomUUID(),
    organization_id: s.unit.organization_id!,
    unit_id: s.unit.id,
    harvest_id: s.events[0].id,
    previous_id: null,
    revision: 1,
    position: "3",
    expected_position: "2",
    expected_daily_id: s.records.at(-1)!.id,
    input,
    harvest_snapshot: s.events[0],
    unit_snapshot: s.unit,
    timezone: s.timezone,
    submission: {} as ProcessingReview["submission"],
    created_by: randomUUID(),
    created_at: "2024-02-03T00:00:00Z",
  };
}
