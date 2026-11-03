import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  feedStockData,
  feedStockResults,
  feedStockCsv,
  feedReturnModel,
  type FeedStockData,
  type FeedStockReport,
} from "../src/lib/feed-stock";
import { feedEvent, feedReceipt } from "./feed-stock-fixture";
import { feedReviewResults } from "../src/lib/feed-review";
import { costReview } from "./feed-review-fixture";
import {
  feedRecognitionLines,
  reviewedCostLines,
  journalData,
} from "../src/lib/financial-journal";
const returned = (
  lotId: string,
): Extract<FeedStockData, { kind: "supplier_return" }> => ({
  kind: "supplier_return",
  lotId,
  weightKg: "1",
  returnReference: "SYNTHETIC-RETURN",
  supplierEvidence: "Synthetic original supplier signed handover",
  scope: "actual-unused-feed-return-to-original-supplier",
  reason: "Synthetic actual unused feed return",
  evidence: "Synthetic weighed unused stock left the original store",
});
it("requires exact return scope, supplier handover, positive six-place quantity and reference", () => {
  const d = returned(randomUUID());
  expect(feedStockData.safeParse(d).success).toBe(true);
  for (const patch of [
    { scope: "consumer-return" },
    { weightKg: "0" },
    { weightKg: "1.0000001" },
    { supplierEvidence: "" },
    { returnReference: "" },
    { credit: "100" },
    { supplier: "Another recipient" },
  ])
    expect(feedStockData.safeParse({ ...d, ...patch }).success).toBe(false);
});
it("conserves original known value and kg without counting returned feed as consumption or loss", () => {
  const receipt = feedEvent({
      ...feedReceipt(),
      weightKg: "3",
      totalCost: "0.0001",
    }),
    ret = feedEvent(returned(receipt.id), {
      lot_id: receipt.id,
      weight_kg: "1.000000",
      amount: "0.0000",
      position: "2",
      model_version: feedReturnModel,
    }),
    loss = feedEvent(
      {
        kind: "loss",
        lotId: receipt.id,
        weightKg: "1",
        reason: "Synthetic weighed feed loss",
        evidence: "Synthetic scale register",
      },
      {
        lot_id: receipt.id,
        weight_kg: "1.000000",
        amount: "0.0001",
        position: "3",
      },
    ),
    r = feedStockResults([receipt, ret, loss]);
  expect(r.lots[0]).toMatchObject({
    receivedKg: "3.000000",
    returnedKg: "1.000000",
    lostKg: "1.000000",
    consumedKg: "0.000000",
    balanceKg: "1.000000",
    returnedValue: "0.0000",
    remainingValue: "0.0000",
  });
  expect(r.consumption).toEqual([]);
  expect(r.currencies[0].knownReturnedValue).toBe("0.0000");
});
it("keeps unknown returned cost unknown and excludes erroneous voided return quantities", () => {
  const receipt = feedEvent({
      ...feedReceipt(),
      totalCost: null,
      costEvidence: null,
    }),
    ret = feedEvent(returned(receipt.id), {
      lot_id: receipt.id,
      amount: null,
      weight_kg: "1.000000",
      position: "2",
      model_version: feedReturnModel,
    }),
    voided = feedEvent(
      {
        kind: "void",
        voidOfId: ret.id,
        reason: "Synthetic return never physically occurred",
        evidence: "Synthetic handover register correction",
      },
      {
        lot_id: receipt.id,
        void_of_id: ret.id,
        kind: "void",
        position: "3",
        model_version: feedReturnModel,
      },
    );
  expect(feedStockResults([receipt, ret]).lots[0].returnedValue).toBeNull();
  expect(feedStockResults([receipt, ret]).currencies[0].unknownReturnedKg).toBe(
    "1.000000",
  );
  expect(feedStockResults([receipt, ret, voided]).lots[0]).toMatchObject({
    returnedKg: "0.000000",
    returnedValue: null,
    balanceKg: "100.000000",
  });
});
it("adds return columns only to return-aware stock reports and preserves old JSON shape", () => {
  const receipt = feedEvent(),
    old = feedStockResults([receipt]);
  expect(old.lots[0]).not.toHaveProperty("returnedKg");
  expect(old.currencies[0]).not.toHaveProperty("knownReturnedValue");
  const ret = feedEvent(returned(receipt.id), {
      lot_id: receipt.id,
      model_version: feedReturnModel,
    }),
    r: FeedStockReport = {
      modelVersion: feedReturnModel,
      policy: receipt.policy,
      organizationId: receipt.organization_id,
      asOf: "2024-02-02",
      throughPosition: "2",
      events: [receipt, ret],
      results: feedStockResults([receipt, ret]),
      evidenceSha256: "a".repeat(64),
    };
  expect(feedStockCsv(r)).toContain('"Returned kg"');
  expect(feedStockCsv(r)).toContain('"Returned value"');
});
it("reprices returns independently with final residual and unknown original differences", () => {
  const review = costReview(),
    receipt = review.source_snapshot.receipt!;
  review.source_snapshot.events = [
    receipt,
    feedEvent(returned(receipt.id), {
      lot_id: receipt.id,
      weight_kg: "1.000000",
      amount: null,
      position: "2",
      model_version: feedReturnModel,
    }),
  ];
  receipt.amount = null;
  review.input = { ...review.input, totalCost: "3" } as typeof review.input;
  const r = feedReviewResults(review);
  expect(r).toMatchObject({
    kind: "cost",
    returnedKg: "1.000000",
    reviewedReturnedValue: "1.0000",
    reviewedRemainingValue: "2.0000",
    returnedDelta: null,
    reviewedLostValue: "0.0000",
  });
});
it("requires return-aware cost evidence and nets return credits/refunds against inventory without inventing expense", () => {
  const p = {
    kind: "recognize_feed_cost",
    reviewId: randomUUID(),
    settlement: "payables",
    paymentEvidence: null,
    consumptionTreatment: "expense",
    policy: "reviewed-feed-cost-ledger-v2",
    returnSettlement: "payables",
    returnAccountingEvidence:
      "Synthetic complete credit/refund accounting authority",
    reason: "Synthetic complete cost adjustment",
    evidence: "Synthetic actual original and revised books",
  };
  expect(journalData.safeParse(p).success).toBe(true);
  expect(
    journalData.safeParse({ ...p, returnAccountingEvidence: undefined })
      .success,
  ).toBe(false);
  expect(
    journalData.safeParse({ ...p, policy: "reviewed-feed-cost-ledger-v1" })
      .success,
  ).toBe(false);
  expect(
    feedRecognitionLines("30", "supplier_return", "cash_bank", null),
  ).toEqual([
    { account: "1000", side: "debit", amount: "30.0000" },
    { account: "1200", side: "credit", amount: "30.0000" },
  ]);
  expect(
    reviewedCostLines(
      [
        { kind: "receipt", account: "1200", delta: "100" },
        { kind: "supplier_return", account: "2000", delta: "100" },
      ],
      "payables",
    ),
  ).toEqual([
    { account: "1200", side: "debit", amount: "0.0000" },
    { account: "2000", side: "credit", amount: "0.0000" },
  ]);
});
