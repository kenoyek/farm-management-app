import { randomUUID } from "node:crypto";
import {
  feedStockInput,
  feedStockModel,
  feedValuePolicy,
  type FeedStockData,
  type FeedStockEvent,
} from "../src/lib/feed-stock";
export function feedReceipt(): Extract<FeedStockData, { kind: "receipt" }> {
  return {
    kind: "receipt",
    feedName: "Synthetic purchased complete feed",
    supplier: "Synthetic feed supplier",
    reference: "SYNTHETIC-FEED-" + randomUUID(),
    location: "Synthetic feed room",
    weightKg: "100",
    currency: "NGN",
    totalCost: "300.0001",
    costEvidence:
      "Synthetic original invoice total including supplied landed charges, no tax inference",
    scope: "actual-owned-purchase-receipt",
    reason: "Synthetic reviewed original feed purchase",
    evidence: "Synthetic owned physical receipt and original stock register",
  };
}
export function feedEvent(
  data: FeedStockData = feedReceipt(),
  patch: Partial<FeedStockEvent> = {},
): FeedStockEvent {
  const p = feedStockInput.parse({
    organizationId: randomUUID(),
    eventId: randomUUID(),
    date: "2024-02-01",
    expectedPosition: "0",
    data,
  });
  return {
    id: p.eventId,
    organization_id: p.organizationId,
    model_version: feedStockModel,
    policy: feedValuePolicy,
    kind: p.data.kind,
    position: "1",
    expected_position: "0",
    recorded_on: p.date,
    lot_id: p.eventId,
    unit_id: null,
    weight_kg: p.data.kind === "receipt" ? p.data.weightKg : "1.000000",
    amount: p.data.kind === "receipt" ? p.data.totalCost : "3.0000",
    currency: "NGN",
    void_of_id: null,
    source_snapshot: null,
    source_sha256: null,
    input: p.data,
    submission: p,
    created_by: randomUUID(),
    created_at: "2024-02-01T00:00:00Z",
    ...patch,
  };
}
