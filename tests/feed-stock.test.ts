import { it, expect } from "vitest";
import {
  feedStockData,
  feedStockInput,
  feedWithdrawalValue,
  feedStockResults,
  feedStockCsv,
  type FeedStockReport,
} from "../src/lib/feed-stock";
import { feedReceipt, feedEvent } from "./feed-stock-fixture";
it("normalizes exact decimal purchase inputs, evidence and UUID receipts", () => {
  const p = feedStockInput.parse({
    organizationId: "A3C05E0D-20B2-4FB1-8F85-6D273F1BB1FD",
    eventId: "C7D3E33D-47B1-47CD-9988-643AA7850E60",
    date: "2024-02-29",
    expectedPosition: "0",
    data: {
      ...feedReceipt(),
      reason: "  Synthetic original purchase review  ",
    },
  });
  expect(p.organizationId).toBe(p.organizationId.toLowerCase());
  expect(p.data).toMatchObject({
    weightKg: "100.000000",
    totalCost: "300.0001",
    reason: "Synthetic original purchase review",
  });
});
it("keeps unknown total cost distinct from evidenced zero and rejects unsupported claims", () => {
  expect(
    feedStockData.safeParse({
      ...feedReceipt(),
      totalCost: null,
      costEvidence: null,
    }).success,
  ).toBe(true);
  expect(
    feedStockData.safeParse({ ...feedReceipt(), totalCost: "0" }).success,
  ).toBe(true);
  for (const d of [
    { totalCost: null },
    { costEvidence: "" },
    { weightKg: "0" },
    { weightKg: "1.0000001" },
    { totalCost: "1.00001" },
    { totalCost: "-1" },
    { profit: "100" },
    { scope: "forecast-receipt" },
  ])
    expect(feedStockData.safeParse({ ...feedReceipt(), ...d }).success).toBe(
      false,
    );
});
it("allocates exact remaining lot cost with a final residual and no cross-lot averaging", () => {
  expect(feedWithdrawalValue("3", "0.0001", "1")).toBe("0.0000");
  expect(feedWithdrawalValue("2", "0.0001", "1")).toBe("0.0001");
  expect(feedWithdrawalValue("1", "0", "1")).toBe("0.0000");
  expect(feedWithdrawalValue("100", "300.0001", "3.123456")).toBe("9.3704");
  expect(feedWithdrawalValue("1", null, "0.5")).toBeNull();
  expect(() => feedWithdrawalValue("1", "4", "1.000001")).toThrow();
});
it("conserves original received value through partial consumption/loss and separate currency lots", () => {
  const r = feedEvent(),
    consumption = feedEvent(
      {
        kind: "consume",
        lotId: r.id,
        unitId: r.created_by,
        weightKg: "10",
        expectedSourceSha256: "a".repeat(64),
        scope: "actual-recorded-feed-consumption",
        reason: "Synthetic actual consumed feed review",
        evidence: "Synthetic daily feed source",
      },
      {
        lot_id: r.id,
        weight_kg: "10.000000",
        amount: "30.0000",
        unit_id: r.created_by,
      },
    ),
    loss = feedEvent(
      {
        kind: "loss",
        lotId: r.id,
        weightKg: "2",
        reason: "Synthetic measured feed loss review",
        evidence: "Synthetic actual spoiled feed weight",
      },
      { lot_id: r.id, weight_kg: "2.000000", amount: "6.0000" },
    ),
    usd = feedEvent(
      { ...feedReceipt(), currency: "USD", totalCost: "25" },
      { currency: "USD" },
    );
  const out = feedStockResults([r, consumption, loss, usd]);
  expect(out.lots[0]).toMatchObject({
    consumedKg: "10.000000",
    lostKg: "2.000000",
    balanceKg: "88.000000",
    remainingValue: "264.0001",
  });
  expect(out.currencies).toEqual([
    expect.objectContaining({
      currency: "NGN",
      knownReceivedValue: "300.0001",
      knownConsumedValue: "30.0000",
      knownLostValue: "6.0000",
      knownRemainingValue: "264.0001",
    }),
    expect.objectContaining({ currency: "USD", knownReceivedValue: "25.0000" }),
  ]);
});
it("retains full original receipts while exact erroneous reversals restore their values", () => {
  const r = feedEvent(),
    l = feedEvent(
      {
        kind: "loss",
        lotId: r.id,
        weightKg: "1",
        reason: "Synthetic measured feed loss review",
        evidence: "Synthetic weight record",
      },
      { lot_id: r.id, amount: "3.0000" },
    ),
    v = feedEvent(
      {
        kind: "void",
        voidOfId: l.id,
        reason: "Synthetic erroneous loss did not occur",
        evidence: "Synthetic original corrected observation",
      },
      { lot_id: r.id, void_of_id: l.id, amount: l.amount },
    );
  expect(feedStockResults([r, l]).lots[0].balanceKg).toBe("99.000000");
  expect(feedStockResults([r, l, v]).lots[0]).toMatchObject({
    balanceKg: "100.000000",
    remainingValue: "300.0001",
  });
});
it("reports unknown-cost kg without inventing value and rejects negative saved balances", () => {
  const r = feedEvent({
      ...feedReceipt(),
      totalCost: null,
      costEvidence: null,
    }),
    l = feedEvent(
      {
        kind: "loss",
        lotId: r.id,
        weightKg: "1",
        reason: "Synthetic unknown cost feed loss review",
        evidence: "Synthetic scale record",
      },
      { lot_id: r.id, amount: null },
    );
  expect(feedStockResults([r, l]).currencies[0]).toMatchObject({
    knownReceivedValue: "0.0000",
    unknownValueLots: 1,
    unknownRemainingKg: "99.000000",
  });
  expect(feedStockResults([r, l]).lots[0].lostValue).toBeNull();
  expect(() =>
    feedStockResults([r, { ...l, weight_kg: "101.000000" }]),
  ).toThrow();
});
it("exports complete original evidence and formula-safe CSV with explicit unknown blanks", () => {
  const e = feedEvent({
      ...feedReceipt(),
      feedName: "=Synthetic malicious spreadsheet label",
      totalCost: null,
      costEvidence: null,
    }),
    r: FeedStockReport = {
      modelVersion: e.model_version,
      policy: e.policy,
      organizationId: e.organization_id,
      asOf: "2024-02-01",
      throughPosition: "1",
      events: [e],
      results: feedStockResults([e]),
      evidenceSha256: "b".repeat(64),
    },
    csv = feedStockCsv(r);
  expect(csv).toContain("'=Synthetic malicious spreadsheet label");
  expect(csv).toContain("Complete event and source");
  expect(csv).toContain(JSON.stringify(e).replaceAll('"', '""'));
  expect(csv).not.toContain("undefined");
});
