import { z } from "zod";
import DecimalBase from "decimal.js";
import {
  broilerEvidence,
  broilerSummary,
  type BroilerSource,
} from "./broiler-lifecycle";
import { processingHeads, type ProcessingReview } from "./broiler-processing";
const D = DecimalBase.clone({
  precision: 40,
  rounding: DecimalBase.ROUND_HALF_UP,
});
const uuid = z.uuid().transform((v) => v.toLowerCase());
const decimal = (places: number, zero: boolean) =>
  z
    .string()
    .refine(
      (v) =>
        new RegExp(`^(?:0|[1-9]\\d{0,8})(?:\\.\\d{1,${places}})?$`).test(v) &&
        new D(v).lte(1e8) &&
        (zero || new D(v).gt(0)),
      "Enter a quantity within range and the stated decimal precision.",
    )
    .transform((v) => new D(v).toFixed(places));
const evidence = {
  reason: z.string().trim().min(10).max(2000),
  evidence: z.string().trim().min(3).max(2000),
};
export const productData = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("receipt"),
    sourceReviewId: uuid,
    outputIndex: z.number().int().min(0).max(11),
    location: z.string().trim().min(2).max(100),
    scope: z.literal("whole-output-owned-available"),
    ...evidence,
  }),
  z.strictObject({
    kind: z.literal("sale"),
    lotId: uuid,
    weightKg: decimal(6, false),
    pricePerKg: decimal(4, true),
    reference: z.string().trim().min(3).max(100),
    customer: z.string().trim().min(2).max(200),
    ...evidence,
  }),
  z.strictObject({
    kind: z.literal("loss"),
    lotId: uuid,
    weightKg: decimal(6, false),
    ...evidence,
  }),
  z.strictObject({ kind: z.literal("void"), voidOfId: uuid, ...evidence }),
]);
export const productInput = z.strictObject({
  organizationId: uuid,
  unitId: uuid,
  eventId: uuid,
  date: z.iso.date(),
  expectedPosition: z.string().regex(/^(0|[1-9]\d{0,18})$/),
  expectedSourcePosition: z.string().regex(/^(0|[1-9]\d{0,18})$/),
  expectedDailyId: uuid.nullable(),
  data: productData,
});
export type ProductInput = z.infer<typeof productInput>;
export type ProductEvent = {
  id: string;
  organization_id: string;
  unit_id: string;
  lot_id: string;
  kind: ProductInput["data"]["kind"];
  recorded_on: string;
  position: string;
  expected_position: string;
  expected_source_position: string;
  expected_daily_id: string | null;
  input: ProductInput["data"];
  source_review_id: string | null;
  output_index: number | null;
  weight_kg: string;
  price_per_kg: string | null;
  amount: string | null;
  currency: string | null;
  reference: string | null;
  void_of_id: string | null;
  source_snapshot: ProcessingReview | null;
  submission: ProductInput;
  created_by: string;
  created_at: string;
};
export const productModel = "broiler-source-linked-product-stock-v1";
export function productAmount(kg: string, price: string) {
  return new D(kg).mul(price).toFixed(4);
}
export function productWorkspace(s: BroilerSource, events: ProductEvent[]) {
  const concerns = broilerSummary(s).harvestGuidance;
  const voided = new Set(events.map((e) => e.void_of_id)),
    active = events.filter((e) => e.kind !== "void" && !voided.has(e.id));
  const lots = events
    .filter((e) => e.kind === "receipt")
    .map((receipt) => {
      const movements = active.filter((e) => e.lot_id === receipt.id);
      const total = (kind: string) =>
        movements
          .filter((e) => e.kind === kind)
          .reduce((n, e) => n.plus(e.weight_kg), new D(0));
      return {
        receipt,
        active: !voided.has(receipt.id),
        concerns:
          concerns.find(
            (h) => h.harvestId === receipt.source_snapshot?.harvest_id,
          )?.currentConcerns ?? [],
        balanceKg: total("receipt")
          .minus(total("sale"))
          .minus(total("loss"))
          .toFixed(6),
        soldKg: total("sale").toFixed(6),
        lostKg: total("loss").toFixed(6),
      };
    });
  const harvests = new Set(
    s.events
      .filter(
        (e) =>
          e.kind === "harvest" && !s.events.some((v) => v.void_of_id === e.id),
      )
      .map((e) => e.id),
  );
  const outputs = processingHeads(s.processingReviews ?? []).flatMap((r) =>
    r.input.kind === "record" && harvests.has(r.harvest_id)
      ? r.input.products.flatMap((p, index) =>
          p.disposition === "intended" &&
          p.weightKg !== null &&
          !lots.some(
            (l) =>
              l.active &&
              l.receipt.source_snapshot?.harvest_id === r.harvest_id &&
              l.receipt.output_index === index,
          )
            ? [
                {
                  reviewId: r.id,
                  harvestId: r.harvest_id,
                  index,
                  name: p.name,
                  weightKg: p.weightKg,
                  processedOn:
                    r.input.kind === "record" ? r.input.processedOn : "",
                  concerns:
                    concerns.find((h) => h.harvestId === r.harvest_id)
                      ?.currentConcerns ?? [],
                },
              ]
            : [],
        )
      : [],
  );
  const salesByCurrency: Record<string, string> = {};
  for (const e of active.filter((e) => e.kind === "sale"))
    salesByCurrency[e.currency!] = new D(salesByCurrency[e.currency!] ?? 0)
      .plus(e.amount!)
      .toFixed(4);
  return {
    expectedPosition: events.reduce(
      (n, e) => (BigInt(e.position) > BigInt(n) ? e.position : n),
      "0",
    ),
    lots,
    outputs,
    salesByCurrency,
  };
}
export function productEvidence(s: BroilerSource, events: ProductEvent[]) {
  return {
    modelVersion: productModel,
    source: broilerEvidence(s),
    events,
    results: productWorkspace(s, events),
  };
}
export type ProductReport = ReturnType<typeof productEvidence> & {
  evidenceSha256: string;
  today: string;
  expectedSourcePosition: string;
  expectedDailyId: string | null;
};
export function productCsv(r: ProductReport) {
  const rows: unknown[][] = [
    ["Broiler product stock", r.modelVersion],
    ["Evidence SHA-256", r.evidenceSha256],
    [
      "Stock and recorded sale values only; no costs, cash, profit or release certification.",
    ],
    ["Complete source", JSON.stringify(r.source)],
    [],
    ["Lots"],
    [
      "Lot",
      "Location",
      "Active",
      "Received kg",
      "Available kg",
      "Sold kg",
      "Lost kg",
      "Current source harvest concerns",
      "Original processing source",
    ],
  ];
  for (const l of r.results.lots)
    rows.push([
      l.receipt.id,
      l.receipt.input.kind === "receipt" ? l.receipt.input.location : "",
      l.active,
      l.receipt.weight_kg,
      l.balanceKg,
      l.soldKg,
      l.lostKg,
      JSON.stringify(l.concerns),
      JSON.stringify(l.receipt.source_snapshot),
    ]);
  rows.push(
    [],
    ["Immutable movements"],
    [
      "Event",
      "Lot",
      "Kind",
      "Date",
      "kg",
      "Price per kg",
      "Amount",
      "Currency",
      "Reference",
      "Reason",
      "Evidence",
      "Complete event",
    ],
  );
  for (const e of r.events)
    rows.push([
      e.id,
      e.lot_id,
      e.kind,
      e.recorded_on,
      e.weight_kg,
      e.price_per_kg,
      e.amount,
      e.currency,
      e.reference,
      e.input.reason,
      e.input.evidence,
      JSON.stringify(e),
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
