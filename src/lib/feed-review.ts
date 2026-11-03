import { z } from "zod";
import DecimalBase from "decimal.js";
import {
  feedStockDay,
  feedWithdrawalValue,
  feedStockResults,
  type FeedStockEvent,
} from "./feed-stock";
const D = DecimalBase.clone({
  precision: 40,
  rounding: DecimalBase.ROUND_HALF_UP,
});
export const feedReturnReviewModel = "feed-reconciliation-v2";
export const feedReviewModel = "feed-reconciliation-v1";
const uuid = z.uuid().transform((v) => v.toLowerCase()),
  common = {
    targetId: uuid,
    previousId: uuid.nullable(),
    reason: z.string().trim().min(10).max(2000),
    evidence: z.string().trim().min(3).max(2000),
  };
export const feedReviewData = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("source"),
    ...common,
    policy: z.literal("same-quantity-current-feed-evidence-v1"),
    scope: z.literal("unchanged-physical-consumption"),
  }),
  z.strictObject({
    kind: z.literal("cost"),
    ...common,
    totalCost: z
      .string()
      .refine(
        (v) =>
          /^(?:0|[1-9]\d{0,8})(?:\.\d{1,4})?$/.test(v) && new D(v).lte(1e8),
      )
      .transform((v) => new D(v).toFixed(4)),
    costEvidence: z.string().trim().min(3).max(2000),
    policy: z.literal("reviewed-specific-lot-cost-v1"),
    scope: z.literal("actual-purchase-cost-revision"),
  }),
]);
export const feedReviewInput = z.strictObject({
  organizationId: uuid,
  reviewId: uuid,
  date: feedStockDay,
  expectedStockPosition: z.string().regex(/^(0|[1-9]\d{0,18})$/),
  expectedReviewPosition: z.string().regex(/^(0|[1-9]\d{0,18})$/),
  expectedSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  data: feedReviewData,
});
export type FeedReviewInput = z.infer<typeof feedReviewInput>;
export type FeedReviewData = z.infer<typeof feedReviewData>;
export type FeedReview = {
  id: string;
  organization_id: string;
  model_version: string;
  kind: FeedReviewData["kind"];
  target_id: string;
  previous_id: string | null;
  revision: number;
  position: string;
  reviewed_on: string;
  expected_stock_position: string;
  expected_review_position: string;
  expected_source_sha256: string;
  source_sha256: string;
  currency: string;
  input: FeedReviewData;
  source_snapshot: {
    event?: FeedStockEvent;
    currentSource?: Record<string, unknown>;
    receipt?: FeedStockEvent;
    events?: FeedStockEvent[];
    linkedConsumption?: {
      id: string;
      lot_id: string;
      weight_kg: string;
      source_sha256: string | null;
    }[];
  };
  submission: FeedReviewInput;
  created_by: string;
  created_at: string;
};
export function feedReviewResults(
  review: Pick<FeedReview, "kind" | "source_snapshot" | "input" | "currency">,
) {
  const s = review.source_snapshot;
  if (review.input.kind === "source") {
    if (!s.event || !s.currentSource)
      throw Error("Incomplete original/current feed source evidence.");
    const linked = s.linkedConsumption;
    if (
      !linked ||
      !linked.some(
        (e) => e.id === s.event!.id && e.weight_kg === s.event!.weight_kg,
      )
    )
      throw Error("Incomplete daily linkage evidence.");
    const linkedKg = linked.reduce((n, e) => n.plus(e.weight_kg), new D(0)),
      currentFeed = (s.currentSource.record as { feed_kg: string })?.feed_kg;
    if (!currentFeed || linkedKg.gt(currentFeed))
      throw Error("Captured linked consumption exceeds actual feed.");
    return {
      kind: "source" as const,
      linkedKg: linkedKg.toFixed(6),
      eventId: s.event.id,
      unitId: s.event.unit_id,
      date: s.event.recorded_on,
      unchangedKg: s.event.weight_kg,
      originalAmount: s.event.amount,
      currency: s.event.currency,
      currentSource: s.currentSource,
      statement:
        "Same physical lot quantity reaffirmed; original stock and book rows are unchanged.",
    };
  }
  if (!s.receipt || !s.events || review.input.kind !== "cost")
    throw Error("Incomplete original lot-cost source.");
  const original = feedStockResults(s.events).lots.find(
    (l) => l.receipt.id === s.receipt!.id,
  );
  if (!original || !original.active)
    throw Error("Original active purchase lot required.");
  const voids = new Set(
      s.events.filter((e) => e.kind === "void").map((e) => e.void_of_id),
    ),
    active = s.events.filter(
      (e) =>
        ["consume", "loss", "supplier_return"].includes(e.kind) &&
        !voids.has(e.id),
    );
  let remainingKg = new D(s.receipt.weight_kg),
    remainingValue = review.input.totalCost,
    consumed = new D(0),
    lost = new D(0),
    returned = new D(0);
  const allocations = active.map((e) => {
    const value = feedWithdrawalValue(
      remainingKg.toFixed(6),
      remainingValue,
      e.weight_kg,
    )!;
    remainingKg = remainingKg.minus(e.weight_kg);
    remainingValue = new D(remainingValue).minus(value).toFixed(4);
    if (e.kind === "consume") consumed = consumed.plus(value);
    else if (e.kind === "loss") lost = lost.plus(value);
    else returned = returned.plus(value);
    return {
      eventId: e.id,
      kind: e.kind,
      unitId: e.unit_id,
      date: e.recorded_on,
      weightKg: e.weight_kg,
      originalValue: e.amount,
      reviewedValue: value,
      delta: e.amount === null ? null : new D(value).minus(e.amount).toFixed(4),
    };
  });
  const delta = (value: string, old: string | null) =>
    old === null ? null : new D(value).minus(old).toFixed(4);
  return {
    kind: "cost" as const,
    lotId: s.receipt.id,
    currency: s.receipt.currency,
    receivedKg: s.receipt.weight_kg,
    consumedKg: original.consumedKg,
    ...(original.returnedKg !== undefined
      ? {
          returnedKg: original.returnedKg,
          originalReturnedValue: original.returnedValue!,
          reviewedReturnedValue: returned.toFixed(4),
          returnedDelta: delta(returned.toFixed(4), original.returnedValue!),
        }
      : {}),
    lostKg: original.lostKg,
    remainingKg: remainingKg.toFixed(6),
    originalTotalCost: s.receipt.amount,
    reviewedTotalCost: review.input.totalCost,
    totalDelta: delta(review.input.totalCost, s.receipt.amount),
    reviewedConsumedValue: consumed.toFixed(4),
    reviewedLostValue: lost.toFixed(4),
    reviewedRemainingValue: remainingValue,
    consumedDelta: delta(consumed.toFixed(4), original.consumedValue),
    lostDelta: delta(lost.toFixed(4), original.lostValue),
    remainingDelta: delta(remainingValue, original.remainingValue),
    allocations,
    statement:
      "Full revised lot cost; deltas compare with original stock values, not the previous review. No automatic stock or journal posting.",
  };
}
export type FeedReviewReport = {
  modelVersion: string;
  review: FeedReview;
  results: ReturnType<typeof feedReviewResults>;
  evidenceSha256: string;
};
export type FeedReviewWorkspace = {
  today: string;
  expectedStockPosition: string;
  expectedReviewPosition: string;
  targets: {
    id: string;
    kind: string;
    date: string;
    label: string;
    lotId: string;
    weightKg: string;
    currency: string;
  }[];
  history: {
    id: string;
    kind: string;
    target_id: string;
    revision: number;
    reviewed_on: string;
  }[];
  selected: {
    kind: "source" | "cost";
    targetId: string;
    latestId: string | null;
    sourceSha256: string | null;
    snapshot: FeedReview["source_snapshot"] | null;
  } | null;
  report: FeedReviewReport | null;
  sourceCurrent: boolean | null;
};
export function feedReviewCsv(r: FeedReviewReport) {
  const rows: unknown[][] = [
    ["Feed evidence and late-cost review", r.modelVersion],
    ["Evidence SHA-256", r.evidenceSha256],
    ["Complete immutable review", JSON.stringify(r.review)],
    ["Complete reviewed results", JSON.stringify(r.results)],
    [
      "No automatic stock or journal posting. Original currency; no complete cost or profit claim.",
    ],
    [],
    ["Field", "Value"],
  ];
  for (const [k, v] of Object.entries(r.results))
    rows.push([k, typeof v === "object" ? JSON.stringify(v) : v]);
  rows.push(
    [],
    ["Review reason", r.review.input.reason],
    ["Review evidence", r.review.input.evidence],
  );
  if (r.review.input.kind === "cost")
    rows.push(["Cost evidence", r.review.input.costEvidence]);
  return rows
    .map((row) =>
      row
        .map((v) => {
          let s = v == null ? "" : String(v);
          if (/^(?:\s*[=+\-@]|[\t\r\n])/.test(s)) s = "'" + s;
          return '"' + s.replaceAll('"', '""') + '"';
        })
        .join(","),
    )
    .join("\r\n");
}
