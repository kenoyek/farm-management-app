import { it, expect } from "vitest";
import {
  feedReviewInput,
  feedReviewResults,
  feedReviewCsv,
} from "../src/lib/feed-review";
import { costReview } from "./feed-review-fixture";
it("normalizes versioned late-cost inputs with explicit evidence and exact receipt tokens", () => {
  const r = costReview(),
    p = feedReviewInput.parse({
      ...r.submission,
      data: {
        ...r.input,
        totalCost: "1",
        reason: "  " + r.input.reason + "  ",
      },
    });
  expect(p.data).toMatchObject({ totalCost: "1.0000", reason: r.input.reason });
});
it("rejects unknown, negative, excessive-precision and invented cost review claims", () => {
  const r = costReview();
  for (const patch of [
    { totalCost: null },
    { totalCost: "-1" },
    { totalCost: "1.00001" },
    { costEvidence: "" },
    { scope: "forecast" },
    { profit: "999" },
  ])
    expect(
      feedReviewInput.safeParse({
        ...r.submission,
        data: { ...r.input, ...patch },
      }).success,
    ).toBe(false);
});
it("preserves exact revised cost residual and signed original-value deltas", () => {
  const r = costReview(),
    v = feedReviewResults(r);
  expect(v).toMatchObject({
    kind: "cost",
    originalTotalCost: "3.0000",
    reviewedTotalCost: "0.0001",
    totalDelta: "-2.9999",
    reviewedLostValue: "0.0000",
    reviewedRemainingValue: "0.0001",
    lostDelta: "-1.0000",
    remainingDelta: "-1.9999",
  });
  expect(r.source_snapshot.events![1].amount).toBe("1.0000");
});
it("keeps unknown original value distinct from known revised zero", () => {
  const r = costReview();
  r.source_snapshot.receipt!.amount = null;
  r.source_snapshot.events![0].amount = null;
  r.source_snapshot.events![1].amount = null;
  if (r.input.kind !== "cost") throw Error();
  r.input.totalCost = "0.0000";
  expect(feedReviewResults(r)).toMatchObject({
    originalTotalCost: null,
    totalDelta: null,
    reviewedTotalCost: "0.0000",
    lostDelta: null,
    remainingDelta: null,
    reviewedRemainingValue: "0.0000",
  });
});
it("allocates only active withdrawals and fully depletes without inventing remaining stock", () => {
  const r = costReview(),
    out = r.source_snapshot.events![1],
    third = {
      ...out,
      id: crypto.randomUUID(),
      position: "3",
      weight_kg: "2.000000",
      amount: "2.0000",
    };
  r.source_snapshot.events!.push(third);
  expect(feedReviewResults(r)).toMatchObject({
    remainingKg: "0.000000",
    reviewedRemainingValue: "0.0000",
    reviewedLostValue: "0.0001",
  });
  r.source_snapshot.events!.push({
    ...out,
    id: crypto.randomUUID(),
    kind: "void",
    position: "4",
    void_of_id: out.id,
  });
  expect(feedReviewResults(r)).toMatchObject({
    lostKg: "2.000000",
    remainingKg: "1.000000",
  });
});
it("source reaffirmation preserves original kg/value while retaining current daily evidence", () => {
  const r = costReview(),
    e = r.source_snapshot.events![1];
  r.kind = "source";
  r.input = {
    kind: "source",
    targetId: e.id,
    previousId: null,
    policy: "same-quantity-current-feed-evidence-v1",
    scope: "unchanged-physical-consumption",
    reason: "Synthetic unchanged actual quantity review",
    evidence: "Synthetic current daily and original scale comparison",
  };
  r.source_snapshot = {
    event: { ...e, kind: "consume" },
    currentSource: { record: { feed_kg: "5.000000" } },
    linkedConsumption: [
      {
        id: e.id,
        lot_id: e.lot_id,
        weight_kg: e.weight_kg,
        source_sha256: null,
      },
    ],
  };
  expect(feedReviewResults(r)).toMatchObject({
    kind: "source",
    unchangedKg: "1.000000",
    originalAmount: "1.0000",
    linkedKg: "1.000000",
    currentSource: { record: { feed_kg: "5.000000" } },
  });
  r.source_snapshot.currentSource = { record: { feed_kg: "0.500000" } };
  expect(() => feedReviewResults(r)).toThrow("exceeds actual feed");
});
it("exports full immutable sources and signed delta evidence with formula-safe human cells", () => {
  const r = costReview();
  r.input.reason = "=Synthetic spreadsheet-like review reason";
  const csv = feedReviewCsv({
    modelVersion: r.model_version,
    review: r,
    results: feedReviewResults(r),
    evidenceSha256: "b".repeat(64),
  });
  expect(csv).toContain("'=Synthetic spreadsheet-like review reason");
  expect(csv).toContain("Complete immutable review");
  expect(csv).toContain(JSON.stringify(r).replaceAll('"', '""'));
  expect(csv).toContain("'-2.9999");
});
