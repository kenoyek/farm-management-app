import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  journalData,
  reviewedCostLines,
  trialBalance,
  reverseLines,
} from "../src/lib/financial-journal";
import { journalEntry } from "./financial-journal-fixture";
const d = () => ({
  kind: "recognize_feed_cost",
  reviewId: randomUUID(),
  settlement: "payables",
  paymentEvidence: null,
  consumptionTreatment: "expense",
  policy: "reviewed-feed-cost-ledger-v1",
  reason: "Synthetic full reviewed cost journal adjustment",
  evidence: "Synthetic linked books and actual reviewed cost evidence",
});
it("requires an exact reviewed authority and explicit payment/consumption policy", () => {
  expect(journalData.safeParse(d()).success).toBe(true);
  for (const patch of [
    { settlement: "cash_bank" },
    { paymentEvidence: "claim" },
    { consumptionTreatment: null },
    { price: "999" },
    { policy: "guess-cost" },
  ])
    expect(journalData.safeParse({ ...d(), ...patch }).success).toBe(false);
  expect(
    journalData.safeParse({
      ...d(),
      settlement: "cash_bank",
      paymentEvidence: "Synthetic paid/refund record",
    }).success,
  ).toBe(true);
});
it("nets reviewed source changes into balanced inventory, expense, loss and payable lines", () => {
  expect(
    reviewedCostLines(
      [
        { kind: "receipt", account: "1200", delta: "29.9999" },
        { kind: "consume", account: "5000", delta: "0.9370" },
        { kind: "loss", account: "5200", delta: "0.6000" },
      ],
      "payables",
    ),
  ).toEqual([
    { account: "1200", side: "debit", amount: "28.4629" },
    { account: "2000", side: "credit", amount: "29.9999" },
    { account: "5000", side: "debit", amount: "0.9370" },
    { account: "5200", side: "debit", amount: "0.6000" },
  ]);
});
it("handles credit notes/refunds as signed differences and preserves WIP classification", () => {
  const x = reviewedCostLines(
    [
      { kind: "receipt", account: "1200", delta: "-90" },
      { kind: "consume", account: "1300", delta: "-2.8111" },
      { kind: "loss", account: "5200", delta: "-1.8" },
    ],
    "cash_bank",
  );
  expect(x).toContainEqual({
    account: "1000",
    side: "debit",
    amount: "90.0000",
  });
  expect(x).toContainEqual({
    account: "1200",
    side: "credit",
    amount: "85.3889",
  });
  expect(x.some((l) => l.account === "5000")).toBe(false);
});
it("records unchanged reviewed authority with an explicit balanced zero marker", () => {
  expect(
    reviewedCostLines(
      [{ kind: "receipt", account: "1200", delta: "0" }],
      "payables",
    ),
  ).toEqual([
    { account: "1200", side: "debit", amount: "0.0000" },
    { account: "2000", side: "credit", amount: "0.0000" },
  ]);
});
it("refuses invented account types or nonfinite deltas", () => {
  for (const x of [
    { kind: "consume", account: "4000", delta: "1" },
    { kind: "loss", account: "1300", delta: "1" },
    { kind: "receipt", account: "2000", delta: "1" },
    { kind: "receipt", account: "1200", delta: "NaN" },
  ])
    expect(() => reviewedCostLines([x], "payables")).toThrow();
});
it("retains original-currency balance and opposite-line reversals without editing old entries", () => {
  const e = journalEntry();
  e.lines = reviewedCostLines(
    [
      { kind: "receipt", account: "1200", delta: "30" },
      { kind: "consume", account: "1300", delta: "1" },
    ],
    "payables",
  );
  const reverse = { ...e, id: randomUUID(), lines: reverseLines(e.lines) },
    usd = {
      ...e,
      id: randomUUID(),
      currency: "USD",
      lines: reviewedCostLines(
        [{ kind: "receipt", account: "1200", delta: "0.0001" }],
        "payables",
      ),
    };
  expect(trialBalance([e, reverse, usd])).toEqual([
    expect.objectContaining({
      currency: "NGN",
      debits: "60.0000",
      credits: "60.0000",
      debitBalances: "0.0000",
    }),
    expect.objectContaining({
      currency: "USD",
      debits: "0.0001",
      credits: "0.0001",
    }),
  ]);
});
