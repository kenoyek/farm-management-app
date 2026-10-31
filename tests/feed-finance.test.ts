import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  feedRecognitionLines,
  journalData,
  journalInput,
  trialBalance,
  reverseLines,
} from "../src/lib/financial-journal";
import { journalEntry } from "./financial-journal-fixture";
const data = () => ({
  kind: "recognize_feed",
  sourceId: randomUUID(),
  purchaseSettlement: "payables",
  consumptionTreatment: null,
  paymentEvidence: null,
  policy: "recorded-feed-lot-value-v1",
  reason: "Synthetic original feed accounting recognition",
  evidence: "Synthetic original purchase and accounting policy evidence",
});
it("normalizes explicit feed accounting receipts and requires evidence for cash payment claims", () => {
  const d = data();
  expect(
    journalInput.parse({
      organizationId: randomUUID(),
      entryId: randomUUID(),
      expectedPosition: "0",
      data: { ...d, reason: "  " + d.reason + "  " },
    }).data,
  ).toEqual(d);
  for (const patch of [
    { purchaseSettlement: "cash_bank" },
    { purchaseSettlement: "cash_bank", paymentEvidence: "" },
    { paymentEvidence: "claim" },
    { consumptionTreatment: "expense" },
    { policy: "infer-cost" },
    { amount: "999" },
  ])
    expect(journalData.safeParse({ ...d, ...patch }).success).toBe(false);
  expect(
    journalData.safeParse({
      ...d,
      purchaseSettlement: "cash_bank",
      paymentEvidence: "Synthetic original payment receipt",
    }).success,
  ).toBe(true);
});
it("posts original purchase value to inventory against explicit payables or cash/bank", () => {
  expect(feedRecognitionLines("300.0001", "receipt", "payables", null)).toEqual(
    [
      { account: "1200", side: "debit", amount: "300.0001" },
      { account: "2000", side: "credit", amount: "300.0001" },
    ],
  );
  expect(feedRecognitionLines("0", "receipt", "cash_bank", null)[1]).toEqual({
    account: "1000",
    side: "credit",
    amount: "0.0000",
  });
});
it("distinguishes explicit consumed-feed expense/WIP and actual stock-loss expense", () => {
  expect(feedRecognitionLines("9.3704", "consume", null, "expense")).toEqual([
    { account: "5000", side: "debit", amount: "9.3704" },
    { account: "1200", side: "credit", amount: "9.3704" },
  ]);
  expect(
    feedRecognitionLines("9.3704", "consume", null, "work_in_progress")[0]
      .account,
  ).toBe("1300");
  expect(feedRecognitionLines("6", "loss", null, null)[0]).toEqual({
    account: "5200",
    side: "debit",
    amount: "6.0000",
  });
});
it("rejects preview treatments that do not belong to the chosen original movement", () => {
  for (const [k, p, c] of [
    ["receipt", null, null],
    ["consume", "payables", "expense"],
    ["consume", null, null],
    ["loss", "cash_bank", null],
    ["loss", null, "expense"],
  ] as const)
    expect(() => feedRecognitionLines("1", k, p, c)).toThrow();
});
it("balances original feed recognition and exact reversals without netting currencies or mutating originals", () => {
  const e = journalEntry();
  e.lines = feedRecognitionLines("300.0001", "receipt", "payables", null);
  e.kind = "recognize_feed";
  e.source_kind = "feed";
  const reversed = {
      ...e,
      id: randomUUID(),
      position: "2",
      kind: "reverse" as const,
      reversal_of_id: e.id,
      lines: reverseLines(e.lines),
    },
    usd = {
      ...e,
      id: randomUUID(),
      currency: "USD",
      lines: feedRecognitionLines("0.0001", "loss", null, null),
    };
  expect(trialBalance([e, reversed, usd])).toEqual([
    expect.objectContaining({
      currency: "NGN",
      debits: "600.0002",
      credits: "600.0002",
      debitBalances: "0.0000",
      creditBalances: "0.0000",
    }),
    expect.objectContaining({
      currency: "USD",
      debits: "0.0001",
      credits: "0.0001",
    }),
  ]);
  expect(e.lines[0].side).toBe("debit");
});
