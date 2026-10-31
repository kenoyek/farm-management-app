import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  journalData,
  trialBalance,
  recognitionLines,
  reverseLines,
  journalCsv,
  journalModel,
  chartVersion,
  chart,
} from "../src/lib/financial-journal";
import { manualJournal, journalEntry } from "./financial-journal-fixture";
it("balances exact decimal book movements and account-side balances without binary floating-point errors", () => {
  const d = manualJournal();
  d.lines = [
    { account: "1000", side: "debit", amount: "0.1" },
    { account: "1100", side: "debit", amount: "0.2" },
    { account: "3000", side: "credit", amount: "0.3" },
  ];
  const e = journalEntry(d),
    r = trialBalance([e])[0];
  expect(r).toMatchObject({
    currency: "NGN",
    debits: "0.3000",
    credits: "0.3000",
    debitBalances: "0.3000",
    creditBalances: "0.3000",
  });
  expect(r.accounts.find((a) => a.code === "1000")!.debitBalance).toBe(
    "0.1000",
  );
  expect(r).not.toHaveProperty("profit");
});
it("recognizes original sale value once using receivables or explicitly chosen cash, retaining zero-priced evidence", () => {
  expect(recognitionLines("3.8559", "product", "receivables")).toEqual([
    { account: "1100", side: "debit", amount: "3.8559" },
    { account: "4100", side: "credit", amount: "3.8559" },
  ]);
  expect(recognitionLines("0", "live", "cash_bank")).toEqual([
    { account: "1000", side: "debit", amount: "0.0000" },
    { account: "4000", side: "credit", amount: "0.0000" },
  ]);
  const p = {
    kind: "recognize_sale",
    sourceKind: "live",
    sourceId: randomUUID(),
    settlement: "cash_bank",
    cashEvidence: null,
    policy: "recorded-dispatch-value-v1",
    reason: "Synthetic financial recognition",
    evidence: "Synthetic source register",
  };
  expect(journalData.safeParse(p).success).toBe(false);
  expect(
    journalData.safeParse({
      ...p,
      cashEvidence: "Synthetic actual cash receipt",
    }).success,
  ).toBe(true);
  expect(
    journalData.safeParse({
      ...p,
      settlement: "receivables",
      cashEvidence: "cash guessed",
    }).success,
  ).toBe(false);
});
it("appends exact opposite lines for correction while retaining original entries and original currencies", () => {
  const first = journalEntry(),
    reversal = {
      ...first,
      id: randomUUID(),
      position: "2",
      kind: "reverse" as const,
      reversal_of_id: first.id,
      lines: reverseLines(first.lines),
    };
  const r = trialBalance([first, reversal])[0];
  expect(r.debits).toBe("200.0000");
  expect(r.credits).toBe("200.0000");
  expect(r.debitBalances).toBe("0.0000");
  expect(r.creditBalances).toBe("0.0000");
  expect(first.lines[0].side).toBe("debit");
});
it("keeps currencies separate and exposes contra account balances without inventing missing opening cash", () => {
  const a = journalEntry(),
    d = manualJournal();
  d.currency = "USD";
  d.lines = [
    { account: "5000", side: "debit", amount: "25" },
    { account: "1000", side: "credit", amount: "25" },
  ];
  const r = trialBalance([a, journalEntry(d, "2")]);
  expect(r.map((c) => c.currency)).toEqual(["NGN", "USD"]);
  expect(r[1].accounts.find((a) => a.code === "1000")!.creditBalance).toBe(
    "25.0000",
  );
});
it("refuses unbalanced, repeated/reserved accounts, missing amounts and extra result claims", () => {
  const p = manualJournal();
  for (const patch of [
    { lines: [p.lines[0], { ...p.lines[1], amount: "99.9999" }] },
    { lines: [p.lines[0], { ...p.lines[1], account: "1000" }] },
    { lines: [p.lines[0], { ...p.lines[1], account: "4000" }] },
    { lines: [{ ...p.lines[0], amount: "0" }, p.lines[1]] },
    { lines: [{ ...p.lines[0], amount: "1.00001" }, p.lines[1]] },
    { lines: [] },
    { currency: "ngn" },
    { date: "1899-12-31" },
    { profit: "100" },
  ])
    expect(journalData.safeParse({ ...p, ...patch }).success).toBe(false);
});
it("independently refuses corrupted unbalanced saved evidence rather than silently repairing a trial balance", () => {
  const e = journalEntry();
  e.lines[0].amount = "101.0000";
  expect(() => trialBalance([e])).toThrow("unbalanced");
});
it("exports complete immutable entries and readable canonical lines with formula-safe evidence", () => {
  const d = manualJournal();
  d.description = "=Synthetic literal accounting memo";
  d.evidence = "=Synthetic statement source";
  const e = journalEntry(d),
    r = {
      modelVersion: journalModel,
      chartVersion,
      organizationId: e.organization_id,
      asOf: "2024-02-01",
      throughPosition: e.position,
      accounts: chart,
      entries: [e],
      trialBalance: trialBalance([e]),
      evidenceSha256: "fixture",
    };
  const csv = journalCsv(r);
  expect(csv).toContain("'=Synthetic literal accounting memo");
  expect(csv).toContain("'=Synthetic statement source");
  expect(csv).toContain('"Complete entry and source"');
  expect(csv).toContain(e.created_by);
  expect(csv).toContain('"Journal lines"');
});
