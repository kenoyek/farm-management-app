import { randomUUID } from "node:crypto";
import {
  journalInput,
  journalModel,
  chartVersion,
  type JournalData,
  type JournalEntry,
} from "../src/lib/financial-journal";
export function manualJournal(): Extract<JournalData, { kind: "manual" }> {
  return {
    kind: "manual",
    date: "2024-02-01",
    currency: "NGN",
    unitId: null,
    purpose: "opening_balance",
    reference: "SYNTHETIC-" + randomUUID(),
    description: "Synthetic evidenced opening book balance",
    lines: [
      { account: "1000", side: "debit", amount: "100" },
      { account: "3000", side: "credit", amount: "100" },
    ],
    scope: "evidenced-manual-book-entry",
    reason: "Synthetic reviewed original opening balance",
    evidence: "Synthetic original bank/equity statement",
  };
}
export function journalEntry(
  data = manualJournal(),
  position = "1",
): JournalEntry {
  const p = journalInput.parse({
    organizationId: randomUUID(),
    entryId: randomUUID(),
    expectedPosition: "0",
    data,
  });
  if (p.data.kind !== "manual") throw Error();
  return {
    id: p.entryId,
    organization_id: p.organizationId,
    model_version: journalModel,
    chart_version: chartVersion,
    unit_id: p.data.unitId,
    kind: "manual",
    position,
    expected_position: "0",
    posted_on: p.data.date,
    currency: p.data.currency,
    reference: p.data.reference,
    description: p.data.description,
    lines: p.data.lines,
    input: p.data,
    source_kind: null,
    source_id: null,
    source_snapshot: null,
    reversal_of_id: null,
    submission: p,
    created_by: randomUUID(),
    created_at: "2024-02-01T00:00:00Z",
  };
}
