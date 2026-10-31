import { randomUUID } from "node:crypto";
import {
  actualCostCategories,
  type ActualCostData,
  type ActualCostSnapshot,
} from "../src/lib/broiler-costs";
import { broilerEvidence } from "../src/lib/broiler-lifecycle";
import type { ProductEvent } from "../src/lib/broiler-products";
import {
  processingSource,
  processingReview,
} from "./broiler-processing-fixture";
export function costFixture(lotId?: string): ActualCostData {
  return {
    currency: "NGN",
    costs: actualCostCategories.map((category, i) => ({
      category,
      amount: i === 0 ? "100" : i === 1 ? "200" : "0",
      evidence:
        "Synthetic batch-attributed incurred total; no duplicate or purchase cost",
    })),
    allocations: lotId
      ? [
          {
            lotId,
            amount: "150.0001",
            evidence: "Synthetic explicit whole-lot joint-cost allocation",
          },
        ]
      : [],
    completeCosts: true,
    policy: "explicit-lot-totals-uniform-kg-v1",
    scope: "actual-incurred-batch-category-totals",
    reason: "Synthetic evidenced actual batch cost review",
    evidence:
      "Synthetic incurred category totals through loaded actuals, consumed-feed valuation, no overlap",
  };
}
export function costSource(): ActualCostSnapshot {
  const s = processingSource(),
    r = processingReview(s);
  s.processingReviews = [r];
  const lotId = randomUUID(),
    base = {
      organization_id: s.unit.organization_id!,
      unit_id: s.unit.id,
      recorded_on: "2024-02-03",
      expected_position: "0",
      expected_source_position: "3",
      expected_daily_id: s.records.at(-1)!.id,
      price_per_kg: null,
      amount: null,
      currency: null,
      reference: null,
      void_of_id: null,
      created_by: randomUUID(),
      created_at: "2024-02-03T00:00:00Z",
    };
  const receipt = {
    ...base,
    id: lotId,
    lot_id: lotId,
    kind: "receipt",
    position: "1",
    source_review_id: r.id,
    output_index: 0,
    weight_kg: "14.000000",
    source_snapshot: r,
    input: {
      kind: "receipt",
      location: "Synthetic cold room",
      reason: "Synthetic original available whole output",
      evidence: "Synthetic stock source",
    },
    submission: {},
  } as ProductEvent;
  const sale = {
    ...base,
    id: randomUUID(),
    lot_id: lotId,
    kind: "sale",
    position: "2",
    source_review_id: null,
    output_index: null,
    weight_kg: "3.123456",
    source_snapshot: null,
    price_per_kg: "1.2345",
    amount: "3.8559",
    currency: "NGN",
    reference: "SYNTHETIC-COST-SALE",
    input: {
      kind: "sale",
      reason: "Synthetic measured sale",
      evidence: "Synthetic dispatch register",
    },
    submission: {},
  } as ProductEvent;
  const loss = {
    ...sale,
    id: randomUUID(),
    kind: "loss",
    position: "3",
    weight_kg: "0.123456",
    amount: null,
    currency: null,
    price_per_kg: null,
    reference: null,
  } as ProductEvent;
  return { source: broilerEvidence(s), events: [receipt, sale, loss] };
}
