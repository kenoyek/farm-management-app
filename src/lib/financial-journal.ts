import { z } from "zod";
import DecimalBase from "decimal.js";
const D = DecimalBase.clone({
  precision: 40,
  rounding: DecimalBase.ROUND_HALF_UP,
});
export const chartVersion = "farm-chart-v1";
export const journalModel = "balanced-financial-journal-v1";
export const chart = [
  { code: "1000", name: "Cash and bank", type: "asset" },
  { code: "1100", name: "Trade receivables", type: "asset" },
  { code: "1200", name: "Feed inventory", type: "asset" },
  { code: "1300", name: "Production work in progress", type: "asset" },
  { code: "1400", name: "Finished goods", type: "asset" },
  { code: "2000", name: "Trade payables", type: "liability" },
  { code: "3000", name: "Equity and opening balances", type: "equity" },
  { code: "4000", name: "Live broiler sales", type: "income" },
  { code: "4100", name: "Processed broiler sales", type: "income" },
  { code: "4200", name: "Other income", type: "income" },
  { code: "5000", name: "Production expenses", type: "expense" },
  { code: "5100", name: "Cost of sales", type: "expense" },
  { code: "5200", name: "Stock losses", type: "expense" },
  { code: "5900", name: "Other expenses", type: "expense" },
] as const;
export type AccountCode = (typeof chart)[number]["code"];
const account = z.enum(
  chart.map((a) => a.code) as [AccountCode, ...AccountCode[]],
);
const uuid = z.uuid().transform((v) => v.toLowerCase());
export const journalDay = z.iso
  .date()
  .refine((v) => v >= "1900-01-01", "Enter a date from 1900 onward.");
const amount = z
  .string()
  .refine(
    (v) =>
      /^(?:0|[1-9]\d{0,8})(?:\.\d{1,4})?$/.test(v) &&
      new D(v).gt(0) &&
      new D(v).lte(1e8),
    "Enter a positive amount up to 100,000,000 with at most four decimals.",
  )
  .transform((v) => new D(v).toFixed(4));
const evidence = {
  reason: z.string().trim().min(10).max(2000),
  evidence: z.string().trim().min(3).max(2000),
};
export const journalPurposes = [
  "opening_balance",
  "purchase",
  "consumption",
  "expense",
  "cost_transfer",
  "cash_record",
  "adjustment",
] as const;
export const journalData = z.discriminatedUnion("kind", [
  z
    .strictObject({
      kind: z.literal("manual"),
      date: journalDay,
      currency: z.string().regex(/^[A-Z]{3}$/),
      unitId: uuid.nullable(),
      purpose: z.enum(journalPurposes),
      reference: z.string().trim().min(3).max(100),
      description: z.string().trim().min(3).max(1000),
      lines: z
        .array(
          z.strictObject({
            account,
            side: z.enum(["debit", "credit"]),
            amount,
          }),
        )
        .min(2)
        .max(20),
      scope: z.literal("evidenced-manual-book-entry"),
      ...evidence,
    })
    .superRefine((p, c) => {
      if (new Set(p.lines.map((l) => l.account)).size !== p.lines.length)
        c.addIssue({
          code: "custom",
          message:
            "Use each account once per entry; combine same-account amounts.",
        });
      if (p.lines.some((l) => ["4000", "4100"].includes(l.account)))
        c.addIssue({
          code: "custom",
          message:
            "Broiler sale accounts require an explicit recorded-sale source.",
        });
      const d = p.lines
          .filter((l) => l.side === "debit")
          .reduce((n, l) => n.plus(l.amount), new D(0)),
        cr = p.lines
          .filter((l) => l.side === "credit")
          .reduce((n, l) => n.plus(l.amount), new D(0));
      if (!d.eq(cr) || d.lte(0))
        c.addIssue({
          code: "custom",
          message: "Positive total debits must equal total credits exactly.",
        });
    }),
  z
    .strictObject({
      kind: z.literal("recognize_sale"),
      sourceKind: z.enum(["live", "product"]),
      sourceId: uuid,
      settlement: z.enum(["receivables", "cash_bank"]),
      cashEvidence: z.string().trim().max(1000).nullable(),
      policy: z.literal("recorded-dispatch-value-v1"),
      ...evidence,
    })
    .superRefine((p, c) => {
      if (
        p.settlement === "cash_bank"
          ? (p.cashEvidence?.length ?? 0) < 3
          : p.cashEvidence !== null
      )
        c.addIssue({
          code: "custom",
          message:
            "Cash recognition requires receipt evidence; receivable recognition must not claim cash received.",
        });
    }),
  z.strictObject({
    kind: z.literal("reverse"),
    originalId: uuid,
    date: journalDay,
    ...evidence,
  }),
]);
export const journalInput = z.strictObject({
  organizationId: uuid,
  entryId: uuid,
  expectedPosition: z.string().regex(/^(0|[1-9]\d{0,18})$/),
  data: journalData,
});
export type JournalInput = z.infer<typeof journalInput>;
export type JournalData = z.infer<typeof journalData>;
export type JournalLine = {
  account: AccountCode;
  side: "debit" | "credit";
  amount: string;
};
export type JournalEntry = {
  id: string;
  organization_id: string;
  model_version: string;
  chart_version: string;
  unit_id: string | null;
  kind: JournalData["kind"];
  position: string;
  expected_position: string;
  posted_on: string;
  currency: string;
  reference: string;
  description: string;
  lines: JournalLine[];
  input: JournalData;
  source_kind: "live" | "product" | null;
  source_id: string | null;
  source_snapshot: Record<string, unknown> | null;
  reversal_of_id: string | null;
  submission: JournalInput;
  created_by: string;
  created_at: string;
};
export type FinancialSource = {
  source_kind: "live" | "product";
  source_id: string;
  unit_id: string;
  unit_name: string;
  recorded_on: string;
  currency: string;
  amount: string;
  reference: string;
  customer: string;
  recognized_id: string | null;
};
export type JournalReport = {
  modelVersion: string;
  chartVersion: string;
  organizationId: string;
  asOf: string;
  throughPosition: string;
  accounts: typeof chart;
  entries: JournalEntry[];
  trialBalance: ReturnType<typeof trialBalance>;
  evidenceSha256: string;
};
export type JournalWorkspace = {
  today: string;
  expectedPosition: string;
  report: JournalReport;
  sources: FinancialSource[];
  sourceMatches: number;
  unrecognizedSales: number;
  activeSales: number;
  units: { id: string; name: string }[];
  reversible: Pick<
    JournalEntry,
    "id" | "posted_on" | "currency" | "reference" | "unit_id" | "lines" | "kind"
  >[];
};
export function recognitionLines(
  amount: string,
  kind: "live" | "product",
  settlement: "receivables" | "cash_bank",
): JournalLine[] {
  return [
    {
      account: settlement === "cash_bank" ? "1000" : "1100",
      side: "debit",
      amount: new D(amount).toFixed(4),
    },
    {
      account: kind === "live" ? "4000" : "4100",
      side: "credit",
      amount: new D(amount).toFixed(4),
    },
  ];
}
export function reverseLines(lines: JournalLine[]): JournalLine[] {
  return lines.map((l) => ({
    ...l,
    side: l.side === "debit" ? "credit" : "debit",
  }));
}
export function trialBalance(entries: JournalEntry[]) {
  const currencies = [...new Set(entries.map((e) => e.currency))].sort();
  return currencies.map((currency) => {
    const totals = new Map<
      AccountCode,
      { debit: InstanceType<typeof D>; credit: InstanceType<typeof D> }
    >();
    let debits = new D(0),
      credits = new D(0);
    for (const e of entries.filter((e) => e.currency === currency)) {
      let ed = new D(0),
        ec = new D(0);
      for (const l of e.lines) {
        if (
          !chart.some((a) => a.code === l.account) ||
          new D(l.amount).isNegative() ||
          !new D(l.amount).isFinite()
        )
          throw Error("Invalid saved account/amount evidence.");
        const old = totals.get(l.account) ?? {
          debit: new D(0),
          credit: new D(0),
        };
        old[l.side] = old[l.side].plus(l.amount);
        totals.set(l.account, old);
        if (l.side === "debit") ed = ed.plus(l.amount);
        else ec = ec.plus(l.amount);
      }
      if (!ed.eq(ec)) throw Error("A saved journal entry is unbalanced.");
      debits = debits.plus(ed);
      credits = credits.plus(ec);
    }
    const accounts = chart
      .filter((a) => totals.has(a.code))
      .map((a) => {
        const t = totals.get(a.code)!,
          net = t.debit.minus(t.credit);
        return {
          ...a,
          debits: t.debit.toFixed(4),
          credits: t.credit.toFixed(4),
          debitBalance: D.max(net, 0).toFixed(4),
          creditBalance: D.max(net.negated(), 0).toFixed(4),
        };
      });
    return {
      currency,
      debits: debits.toFixed(4),
      credits: credits.toFixed(4),
      debitBalances: accounts
        .reduce((n, a) => n.plus(a.debitBalance), new D(0))
        .toFixed(4),
      creditBalances: accounts
        .reduce((n, a) => n.plus(a.creditBalance), new D(0))
        .toFixed(4),
      accounts,
    };
  });
}
export function journalCsv(r: JournalReport) {
  const rows: unknown[][] = [
    ["Financial journal and trial balance", r.modelVersion],
    ["Chart", r.chartVersion],
    ["Evidence SHA-256", r.evidenceSha256],
    ["Organization", r.organizationId],
    ["Posted through date", r.asOf],
    ["Append position limit", r.throughPosition],
    [
      "Posted entries only. Balanced totals do not establish complete books, verified cash or profit.",
    ],
    [],
    [
      "Currency",
      "Account",
      "Account name",
      "Type",
      "Debit movements",
      "Credit movements",
      "Debit balance",
      "Credit balance",
    ],
  ];
  for (const c of r.trialBalance)
    for (const a of c.accounts)
      rows.push([
        c.currency,
        a.code,
        a.name,
        a.type,
        a.debits,
        a.credits,
        a.debitBalance,
        a.creditBalance,
      ]);
  rows.push(
    [],
    ["Immutable journal entries"],
    [
      "Entry",
      "Position",
      "Date",
      "Kind",
      "Currency",
      "Reference",
      "Description",
      "Reason",
      "Evidence",
      "Complete entry and source",
    ],
  );
  for (const e of r.entries)
    rows.push([
      e.id,
      e.position,
      e.posted_on,
      e.kind,
      e.currency,
      e.reference,
      e.description,
      e.input.reason,
      e.input.evidence,
      JSON.stringify(e),
    ]);
  rows.push(
    [],
    ["Journal lines"],
    ["Entry", "Currency", "Account", "Side", "Amount"],
  );
  for (const e of r.entries)
    for (const l of e.lines)
      rows.push([e.id, e.currency, l.account, l.side, l.amount]);
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
