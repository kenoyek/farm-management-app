import { z } from "zod";
import DecimalBase from "decimal.js";
import {
  broilerEvidence,
  broilerSummary,
  type BroilerSource,
} from "./broiler-lifecycle";
import {
  productWorkspace,
  type ProductEvent,
  type ProductReport,
} from "./broiler-products";
const D = DecimalBase.clone({
  precision: 40,
  rounding: DecimalBase.ROUND_HALF_UP,
});
const uuid = z.uuid().transform((v) => v.toLowerCase());
const money = z
  .string()
  .refine(
    (v) => /^(?:0|[1-9]\d{0,8})(?:\.\d{1,4})?$/.test(v) && new D(v).lte(1e8),
    "Enter a nonnegative amount up to 100,000,000 with at most four decimals.",
  )
  .transform((v) => new D(v).toFixed(4));
export const actualCostCategories = [
  "chicks",
  "feed",
  "health",
  "litter",
  "labour",
  "utilities",
  "transport",
  "processing",
  "overhead",
  "other",
] as const;
export const actualCostLabels: Record<
  (typeof actualCostCategories)[number],
  string
> = {
  chicks: "Placed chicks · actual attributed cost",
  feed: "Feed consumed · actual valuation, not purchases",
  health: "Medication and vaccination",
  litter: "Litter and housing",
  labour: "Labour",
  utilities: "Utilities",
  transport: "Transport and selling",
  processing: "Processing and packaging",
  overhead: "Attributed overhead, depreciation, finance and taxes",
  other: "Other incurred batch costs",
};
export const actualCostModel =
  "broiler-incurred-cost-explicit-lot-allocation-v1";
export const actualCostData = z
  .strictObject({
    currency: z
      .string()
      .regex(
        /^[A-Z]{3}$/,
        "Enter the original three-letter cost currency; no conversion occurs.",
      ),
    costs: z
      .array(
        z.strictObject({
          category: z.enum(actualCostCategories),
          amount: money.nullable(),
          evidence: z.string().trim().max(1000),
        }),
      )
      .length(10),
    allocations: z
      .array(
        z.strictObject({
          lotId: uuid,
          amount: money,
          evidence: z.string().trim().min(3).max(1000),
        }),
      )
      .max(40),
    completeCosts: z.boolean(),
    policy: z.literal("explicit-lot-totals-uniform-kg-v1"),
    scope: z.literal("actual-incurred-batch-category-totals"),
    reason: z.string().trim().min(10).max(2000),
    evidence: z.string().trim().min(3).max(2000),
  })
  .superRefine((p, c) => {
    if (new Set(p.costs.map((x) => x.category)).size !== 10)
      c.addIssue({
        code: "custom",
        message: "Provide each actual cost category exactly once.",
      });
    if (
      new Set(p.allocations.map((x) => x.lotId)).size !== p.allocations.length
    )
      c.addIssue({
        code: "custom",
        message: "Allocate each receipt lot at most once.",
      });
    if (p.costs.some((x) => x.amount !== null && x.evidence.length < 3))
      c.addIssue({
        code: "custom",
        message:
          "Every known cost, including zero, needs source/valuation evidence.",
      });
    const known = p.costs.reduce((n, x) => n.plus(x.amount ?? 0), new D(0)),
      allocated = p.allocations.reduce((n, x) => n.plus(x.amount), new D(0));
    if (allocated.gt(known))
      c.addIssue({
        code: "custom",
        message:
          "Lot allocations cannot exceed the known incurred-cost subtotal.",
      });
  });
export const actualCostInput = z.strictObject({
  organizationId: uuid,
  unitId: uuid,
  reviewId: uuid,
  previousId: uuid.nullable(),
  expectedPosition: z.string().regex(/^(0|[1-9]\d{0,18})$/),
  expectedSourcePosition: z.string().regex(/^(0|[1-9]\d{0,18})$/),
  expectedDailyId: uuid.nullable(),
  expectedSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  data: actualCostData,
});
export type ActualCostData = z.infer<typeof actualCostData>;
export type ActualCostInput = z.infer<typeof actualCostInput>;
export type ActualCostSnapshot = {
  source: ReturnType<typeof broilerEvidence>;
  events: ProductEvent[];
};
export type ActualCostReview = {
  id: string;
  organization_id: string;
  unit_id: string;
  previous_id: string | null;
  revision: number;
  model_version: string;
  input: ActualCostData;
  source_snapshot: ActualCostSnapshot;
  expected_position: string;
  expected_source_position: string;
  expected_daily_id: string | null;
  expected_source_sha256: string;
  submission: ActualCostInput;
  created_by: string;
  created_at: string;
};
// Normalize stored JSONB and freshly loaded evidence into the same existing source order.
export function costSnapshot(
  p: Pick<ProductReport, "source" | "events">,
): ActualCostSnapshot {
  return {
    source: broilerEvidence({ ...p.source, today: "" }),
    events: p.events,
  };
}
export function allocateActualCosts(
  raw: ActualCostData,
  snapshot: ActualCostSnapshot,
) {
  const p = actualCostData.parse(raw),
    s: BroilerSource = { ...snapshot.source, today: "" },
    workspace = productWorkspace(s, snapshot.events),
    active = snapshot.events.filter(
      (e) =>
        e.kind !== "void" &&
        !snapshot.events.some((v) => v.void_of_id === e.id),
    );
  const known = p.costs.reduce((n, x) => n.plus(x.amount ?? 0), new D(0)),
    allocated = p.allocations.reduce((n, x) => n.plus(x.amount), new D(0));
  const lots = p.allocations.map((a) => {
    const lot = workspace.lots.find(
      (l) => l.receipt.id === a.lotId && l.active,
    );
    if (!lot)
      throw Error(
        "Choose an active receipt lot from this batch, including fully dispatched lots. Reload the source if it changed.",
      );
    const received = new D(lot.receipt.weight_kg),
      sold = new D(lot.soldKg),
      lost = new D(lot.lostKg),
      remaining = new D(lot.balanceKg),
      amount = new D(a.amount);
    if (received.lte(0) || !sold.plus(lost).plus(remaining).eq(received))
      throw Error(
        "The source lot does not reconcile to its original received kg.",
      );
    const soldCost = amount.mul(sold).div(received).toDecimalPlaces(4),
      soldAndLost = amount
        .mul(sold.plus(lost))
        .div(received)
        .toDecimalPlaces(4),
      lossCost = soldAndLost.minus(soldCost),
      remainingCost = amount.minus(soldAndLost),
      input = lot.receipt.source_snapshot!.input;
    const recordedSales: Record<string, string> = {};
    for (const e of active.filter(
      (e) => e.kind === "sale" && e.lot_id === a.lotId,
    ))
      recordedSales[e.currency!] = new D(recordedSales[e.currency!] ?? 0)
        .plus(e.amount!)
        .toFixed(4);
    return {
      lotId: a.lotId,
      name:
        input.kind === "record"
          ? input.products[lot.receipt.output_index!].name
          : "",
      location:
        lot.receipt.input.kind === "receipt" ? lot.receipt.input.location : "",
      receivedKg: received.toFixed(6),
      soldKg: sold.toFixed(6),
      lostKg: lost.toFixed(6),
      remainingKg: remaining.toFixed(6),
      allocatedCost: amount.toFixed(4),
      allocatedCostPerKg: amount.div(received).toFixed(8),
      soldKgCost: soldCost.toFixed(4),
      lostKgCost: lossCost.toFixed(4),
      remainingKgCost: remainingCost.toFixed(4),
      recordedSales,
      concerns: lot.concerns,
      evidence: a.evidence,
    };
  });
  const sum = (key: "soldKgCost" | "lostKgCost" | "remainingKgCost") =>
    lots.reduce((n, l) => n.plus(l[key]), new D(0)).toFixed(4);
  return {
    currency: p.currency,
    throughDate: [
      broilerSummary(s).asOf,
      ...snapshot.events.map((e) => e.recorded_on),
    ]
      .sort()
      .at(-1)!,
    knownCostSubtotal: known.toFixed(4),
    totalDeclaredIncurredCost:
      p.completeCosts && p.costs.every((x) => x.amount !== null)
        ? known.toFixed(4)
        : null,
    unknownCategories: p.costs
      .filter((x) => x.amount === null)
      .map((x) => x.category),
    completeCostsAsserted: p.completeCosts,
    allocatedCost: allocated.toFixed(4),
    unallocatedKnownCost: known.minus(allocated).toFixed(4),
    soldKgCost: sum("soldKgCost"),
    lostKgCost: sum("lostKgCost"),
    remainingKgCost: sum("remainingKgCost"),
    lots,
    unallocatedReceiptIds: workspace.lots
      .filter(
        (l) => l.active && !p.allocations.some((a) => a.lotId === l.receipt.id),
      )
      .map((l) => l.receipt.id),
    recordedLiveSaleValues: broilerSummary(s).sales,
    recordedProductSaleValues: workspace.salesByCurrency,
  };
}
export type ActualCostReport = {
  modelVersion: string;
  source: ActualCostReview;
  results: ReturnType<typeof allocateActualCosts>;
  evidenceSha256: string;
};
export type ActualCostWorkspace = {
  current: ProductReport | null;
  sourceToken: string | null;
  currentError: string | null;
  history: {
    id: string;
    revision: number;
    currency: string;
    created_at: string;
  }[];
  latestId: string | null;
  report: ActualCostReport | null;
  sourceCurrent: boolean | null;
};
export function actualCostCsv(r: ActualCostReport) {
  const rows: unknown[][] = [
    ["Reviewed broiler incurred costs", r.modelVersion],
    ["Evidence SHA-256", r.evidenceSha256],
    ["Saved cost review", r.source.id, r.source.revision],
    ["Original cost currency", r.results.currency],
    ["Actual source through", r.results.throughDate],
    [
      "Explicit category totals and lot allocations; no purchase, cash, financial journal, COGS or profit posting.",
    ],
    ["Complete immutable source", JSON.stringify(r.source)],
    [],
    ["Cost category", "Batch-attributed incurred amount", "Evidence"],
  ];
  for (const c of r.source.input.costs)
    rows.push([c.category, c.amount, c.evidence]);
  rows.push(
    [],
    ["Reconciliation"],
    ["Known cost subtotal", r.results.knownCostSubtotal],
    ["Declared complete incurred cost", r.results.totalDeclaredIncurredCost],
    ["Allocated sold kg cost", r.results.soldKgCost],
    ["Allocated lost kg cost", r.results.lostKgCost],
    ["Allocated remaining kg cost", r.results.remainingKgCost],
    ["Unallocated known batch cost", r.results.unallocatedKnownCost],
    [],
    [
      "Lot",
      "Output",
      "Location",
      "Received kg",
      "Sold kg",
      "Lost kg",
      "Remaining kg",
      "Explicit allocated cost",
      "Allocated cost per kg",
      "Sold kg cost",
      "Lost kg cost",
      "Remaining kg cost",
      "Original-currency recorded sale values",
      "Evidence",
    ],
  );
  for (const l of r.results.lots)
    rows.push([
      l.lotId,
      l.name,
      l.location,
      l.receivedKg,
      l.soldKg,
      l.lostKg,
      l.remainingKg,
      l.allocatedCost,
      l.allocatedCostPerKg,
      l.soldKgCost,
      l.lostKgCost,
      l.remainingKgCost,
      JSON.stringify(l.recordedSales),
      l.evidence,
    ]);
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
