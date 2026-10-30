import { randomUUID } from "node:crypto";
import type { BroilerSource, BroilerEvent } from "../src/lib/broiler-lifecycle";
import type { BroilerLossReview } from "../src/lib/broiler-loss";
export function lossFixture(): BroilerSource {
  const org = randomUUID(),
    unit = randomUUID();
  const event = (
    kind: "cull" | "harvest",
    quantity: number,
    weight: string | null,
    position: string,
  ): BroilerEvent => ({
    id: randomUUID(),
    organization_id: org,
    unit_id: unit,
    kind,
    recorded_on: "2024-02-01",
    position,
    quantity,
    weight_kg: weight,
    description: "Synthetic loss fixture",
    product: null,
    administration: null,
    earliest_harvest_on: null,
    price_basis: kind === "harvest" ? "kg" : null,
    price_per_unit: kind === "harvest" ? "3" : null,
    amount: kind === "harvest" ? "60.0000" : null,
    currency: kind === "harvest" ? "NGN" : null,
    reference: kind === "harvest" ? "SYNTHETIC-LOSS" : null,
    customer: kind === "harvest" ? "Synthetic buyer" : null,
    void_of_id: null,
    reason: "Synthetic original measured source",
    evidence: "Synthetic source",
    created_by: randomUUID(),
    created_at: "2024-02-01T00:00:00Z",
    submission: {} as BroilerEvent["submission"],
  });
  return {
    unit: {
      id: unit,
      organization_id: org,
      name: "Synthetic loss batch",
      kind: "broilers",
      stocked_on: "2024-02-01",
      opening_count: 100,
      initial_weight_g: "1000",
    },
    records: [
      {
        id: randomUUID(),
        recorded_on: "2024-02-01",
        mortality: 2,
        feed_kg: "10",
        average_weight_g: "2000",
        sample_size: 10,
        adjustment_id: null,
      },
      {
        id: randomUUID(),
        recorded_on: "2024-02-02",
        mortality: 1,
        feed_kg: "20",
        average_weight_g: "2500",
        sample_size: 10,
        adjustment_id: null,
      },
    ],
    events: [event("cull", 3, null, "1"), event("harvest", 10, "20", "2")],
    reviews: [],
    lossReviews: [],
    timezone: "Africa/Lagos",
    today: "2024-02-02",
  };
}
export function weightReview(
  s: BroilerSource,
  kind: "daily" | "cull",
  date: string,
  weight: string | null,
  position = "3",
): BroilerLossReview {
  const target =
    kind === "daily"
      ? s.records.find((r) => r.recorded_on === date)!
      : s.events.find((e) => e.kind === "cull")!;
  return {
    id: randomUUID(),
    organization_id: s.unit.organization_id!,
    unit_id: s.unit.id,
    kind,
    observed_on: date,
    target_event_id: kind === "cull" ? target.id : null,
    source_id:
      kind === "daily"
        ? (s.records.find((r) => r.id === target.id)!.adjustment_id ??
          target.id)
        : target.id,
    source_count:
      kind === "daily"
        ? s.records.find((r) => r.id === target.id)!.mortality
        : s.events.find((e) => e.id === target.id)!.quantity!,
    weight_kg: weight,
    measurement_basis: "whole-bird-at-loss",
    previous_id: null,
    position,
    expected_position: "2",
    expected_daily_id: s.records.at(-1)!.id,
    reason: "Synthetic recorded whole-bird loss mass",
    evidence: "Synthetic original scale record",
    source_snapshot: { ...target },
    created_by: randomUUID(),
    created_at: "2024-02-03T00:00:00Z",
    submission: {} as BroilerLossReview["submission"],
  };
}
export function measuredLossFixture() {
  const s = lossFixture();
  s.lossReviews = [
    weightReview(s, "daily", "2024-02-01", "2.4", "3"),
    weightReview(s, "daily", "2024-02-02", "1.5", "4"),
    weightReview(s, "cull", "2024-02-01", "4.5", "5"),
  ];
  return s;
}
