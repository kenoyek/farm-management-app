import { randomUUID } from "node:crypto";
import { feedReviewModel, type FeedReview } from "../src/lib/feed-review";
import { feedEvent, feedReceipt } from "./feed-stock-fixture";
export function costReview(): FeedReview {
  const receipt = feedEvent({
      ...feedReceipt(),
      weightKg: "3",
      totalCost: "3",
    }),
    loss = feedEvent(
      {
        kind: "loss",
        lotId: receipt.id,
        weightKg: "1",
        reason: "Synthetic original measured feed loss",
        evidence: "Synthetic scale record",
      },
      {
        id: randomUUID(),
        lot_id: receipt.id,
        weight_kg: "1.000000",
        amount: "1.0000",
        kind: "loss",
        position: "2",
      },
    ),
    id = randomUUID();
  const data = {
    kind: "cost" as const,
    targetId: receipt.id,
    previousId: null,
    totalCost: "0.0001",
    costEvidence: "Synthetic final invoice with explicit cost boundary",
    policy: "reviewed-specific-lot-cost-v1" as const,
    scope: "actual-purchase-cost-revision" as const,
    reason: "Synthetic original late actual purchase cost review",
    evidence: "Synthetic final complete lot cost, no duplicate expense",
  };
  return {
    id,
    organization_id: receipt.organization_id,
    model_version: feedReviewModel,
    kind: "cost",
    target_id: receipt.id,
    previous_id: null,
    revision: 1,
    position: "1",
    reviewed_on: "2024-02-03",
    expected_stock_position: "2",
    expected_review_position: "0",
    expected_source_sha256: "a".repeat(64),
    source_sha256: "a".repeat(64),
    currency: "NGN",
    input: data,
    source_snapshot: { receipt, events: [receipt, loss] },
    submission: {
      organizationId: receipt.organization_id,
      reviewId: id,
      date: "2024-02-03",
      expectedStockPosition: "2",
      expectedReviewPosition: "0",
      expectedSourceSha256: "a".repeat(64),
      data,
    },
    created_by: receipt.created_by,
    created_at: "2024-02-03T00:00:00Z",
  };
}
