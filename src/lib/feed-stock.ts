import { z } from "zod";
import DecimalBase from "decimal.js";
const D = DecimalBase.clone({
  precision: 40,
  rounding: DecimalBase.ROUND_HALF_UP,
});
export const feedStockModel = "specific-feed-lot-stock-v1";
export const feedValuePolicy = "specific-lot-remaining-cost-v1";
const uuid = z.uuid().transform((v) => v.toLowerCase());
export const feedStockDay = z.iso.date().refine((v) => v >= "1900-01-01");
const decimal = (places: number, zero = false) =>
  z
    .string()
    .refine(
      (v) =>
        new RegExp(`^(?:0|[1-9]\\d{0,8})(?:\\.\\d{1,${places}})?$`).test(v) &&
        new D(v).lte(1e8) &&
        (zero ? new D(v).gte(0) : new D(v).gt(0)),
      `Enter ${zero ? "a nonnegative" : "a positive"} amount up to 100,000,000, at most ${places} decimals.`,
    )
    .transform((v) => new D(v).toFixed(places));
const evidence = {
  reason: z.string().trim().min(10).max(2000),
  evidence: z.string().trim().min(3).max(2000),
};
export const feedStockData = z.discriminatedUnion("kind", [
  z
    .strictObject({
      kind: z.literal("receipt"),
      feedName: z.string().trim().min(2).max(200),
      supplier: z.string().trim().min(2).max(200),
      reference: z.string().trim().min(3).max(100),
      location: z.string().trim().min(2).max(100),
      weightKg: decimal(6),
      currency: z.string().regex(/^[A-Z]{3}$/),
      totalCost: decimal(4, true).nullable(),
      costEvidence: z.string().trim().max(2000).nullable(),
      scope: z.literal("actual-owned-purchase-receipt"),
      ...evidence,
    })
    .superRefine((p, c) => {
      if (
        p.totalCost === null
          ? p.costEvidence !== null
          : (p.costEvidence?.length ?? 0) < 3
      )
        c.addIssue({
          code: "custom",
          message:
            "Known total cost, including zero, requires cost evidence. Unknown cost must have null cost evidence.",
        });
    }),
  z.strictObject({
    kind: z.literal("consume"),
    lotId: uuid,
    unitId: uuid,
    weightKg: decimal(6),
    expectedSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    scope: z.literal("actual-recorded-feed-consumption"),
    ...evidence,
  }),
  z.strictObject({
    kind: z.literal("loss"),
    lotId: uuid,
    weightKg: decimal(6),
    ...evidence,
  }),
  z.strictObject({ kind: z.literal("void"), voidOfId: uuid, ...evidence }),
]);
export const feedStockInput = z.strictObject({
  organizationId: uuid,
  eventId: uuid,
  date: feedStockDay,
  expectedPosition: z.string().regex(/^(0|[1-9]\d{0,18})$/),
  data: feedStockData,
});
export type FeedStockInput = z.infer<typeof feedStockInput>;
export type FeedStockData = z.infer<typeof feedStockData>;
export type FeedStockEvent = {
  id: string;
  organization_id: string;
  model_version: string;
  policy: string;
  kind: FeedStockData["kind"];
  position: string;
  expected_position: string;
  recorded_on: string;
  lot_id: string;
  unit_id: string | null;
  weight_kg: string;
  amount: string | null;
  currency: string;
  void_of_id: string | null;
  source_snapshot: Record<string, unknown> | null;
  source_sha256: string | null;
  input: FeedStockData;
  submission: FeedStockInput;
  created_by: string;
  created_at: string;
};
export function feedWithdrawalValue(
  remainingKg: string,
  remainingCost: string | null,
  weightKg: string,
) {
  const kg = new D(weightKg),
    balance = new D(remainingKg);
  if (kg.lte(0) || kg.gt(balance))
    throw Error("Withdrawal exceeds positive available kg.");
  if (remainingCost === null) return null;
  const value = new D(remainingCost);
  if (value.isNegative()) throw Error("Negative saved remaining cost.");
  return (kg.eq(balance) ? value : value.times(kg).div(balance)).toFixed(4);
}
export function feedStockResults(events: FeedStockEvent[]) {
  const voided = new Set(
      events.filter((e) => e.kind === "void").map((e) => e.void_of_id),
    ),
    active = events.filter((e) => e.kind !== "void" && !voided.has(e.id));
  const lots = events
    .filter((e) => e.kind === "receipt")
    .map((receipt) => {
      if (receipt.input.kind !== "receipt")
        throw Error("Invalid saved feed receipt.");
      const out = active.filter(
          (e) =>
            e.lot_id === receipt.id && ["consume", "loss"].includes(e.kind),
        ),
        isActive = !voided.has(receipt.id);
      const qty = (kind: string) =>
        out
          .filter((e) => e.kind === kind)
          .reduce((n, e) => n.plus(e.weight_kg), new D(0));
      const value = (kind: string) =>
        receipt.amount === null
          ? null
          : out
              .filter((e) => e.kind === kind)
              .reduce((n, e) => {
                if (e.amount === null)
                  throw Error("Known lot has unknown withdrawal value.");
                return n.plus(e.amount);
              }, new D(0))
              .toFixed(4);
      const consumedKg = qty("consume"),
        lostKg = qty("loss"),
        balance = new D(receipt.weight_kg).minus(consumedKg).minus(lostKg),
        consumedValue = value("consume"),
        lostValue = value("loss"),
        remainingValue =
          receipt.amount === null
            ? null
            : new D(receipt.amount)
                .minus(consumedValue!)
                .minus(lostValue!)
                .toFixed(4);
      if (
        balance.isNegative() ||
        (remainingValue !== null && new D(remainingValue).isNegative())
      )
        throw Error("Saved feed lot balance is negative.");
      return {
        receipt,
        active: isActive,
        feedName: receipt.input.feedName,
        location: receipt.input.location,
        currency: receipt.currency,
        receivedKg: receipt.weight_kg,
        receivedValue: receipt.amount,
        consumedKg: consumedKg.toFixed(6),
        lostKg: lostKg.toFixed(6),
        balanceKg: (isActive ? balance : new D(0)).toFixed(6),
        consumedValue,
        lostValue,
        remainingValue: isActive
          ? remainingValue
          : receipt.amount === null
            ? null
            : "0.0000",
      };
    });
  const currencies = [
    ...new Set(lots.filter((l) => l.active).map((l) => l.currency)),
  ]
    .sort()
    .map((currency) => {
      const list = lots.filter((l) => l.active && l.currency === currency),
        sum = (
          key:
            "receivedValue" | "consumedValue" | "lostValue" | "remainingValue",
        ) => list.reduce((n, l) => n.plus(l[key] ?? 0), new D(0)).toFixed(4);
      return {
        currency,
        knownReceivedValue: sum("receivedValue"),
        knownConsumedValue: sum("consumedValue"),
        knownLostValue: sum("lostValue"),
        knownRemainingValue: sum("remainingValue"),
        unknownValueLots: list.filter((l) => l.receivedValue === null).length,
        unknownConsumedKg: list
          .filter((l) => l.receivedValue === null)
          .reduce((n, l) => n.plus(l.consumedKg), new D(0))
          .toFixed(6),
        unknownRemainingKg: list
          .filter((l) => l.receivedValue === null)
          .reduce((n, l) => n.plus(l.balanceKg), new D(0))
          .toFixed(6),
      };
    });
  const consumption = active
    .filter((e) => e.kind === "consume")
    .map((e) => ({
      eventId: e.id,
      unitId: e.unit_id!,
      date: e.recorded_on,
      lotId: e.lot_id,
      weightKg: e.weight_kg,
      amount: e.amount,
      currency: e.currency,
      sourceSha256: e.source_sha256,
    }));
  const batchKeys = [
    ...new Set(consumption.map((e) => e.unitId + ":" + e.currency)),
  ].sort();
  const batches = batchKeys.map((key) => {
    const [unitId, currency] = key.split(":"),
      rows = active.filter(
        (e) =>
          e.kind === "consume" &&
          e.unit_id === unitId &&
          e.currency === currency,
      ),
      last = rows.at(-1)!,
      unit = last.source_snapshot?.unit as { name?: string } | undefined;
    return {
      unitId,
      unitName: unit?.name ?? unitId,
      currency,
      consumedKg: rows
        .reduce((n, e) => n.plus(e.weight_kg), new D(0))
        .toFixed(6),
      knownConsumedValue: rows
        .reduce((n, e) => n.plus(e.amount ?? 0), new D(0))
        .toFixed(4),
      unknownCostKg: rows
        .filter((e) => e.amount === null)
        .reduce((n, e) => n.plus(e.weight_kg), new D(0))
        .toFixed(6),
    };
  });
  return { lots, currencies, consumption, batches };
}
export type FeedStockReport = {
  modelVersion: string;
  policy: string;
  organizationId: string;
  asOf: string;
  throughPosition: string;
  events: FeedStockEvent[];
  results: ReturnType<typeof feedStockResults>;
  evidenceSha256: string;
};
export type FeedConsumptionSource = {
  unitId: string;
  unitName: string;
  date: string;
  feedKg: string;
  sourceSha256: string;
  issuedKg: string;
  unlinkedKg: string;
  overlinkedKg: string;
  sourceChanged: boolean;
};
export type FeedStockWorkspace = {
  today: string;
  expectedPosition: string;
  report: FeedStockReport;
  units: { id: string; name: string }[];
  sources: FeedConsumptionSource[];
  sourceMatches: number;
  changedSources: FeedConsumptionSource[];
  currentLots: ReturnType<typeof feedStockResults>["lots"];
  reversible: FeedStockEvent[];
};
export function feedStockCsv(r: FeedStockReport) {
  const rows: unknown[][] = [
    ["Feed purchases, stock and consumed-feed valuation", r.modelVersion],
    ["Policy", r.policy],
    ["Evidence SHA-256", r.evidenceSha256],
    ["Organization", r.organizationId],
    ["As of", r.asOf],
    ["Append position cutoff", r.throughPosition],
    [
      "Specific identified lots. Supplied purchase costs only; no currency conversion, journal posting, verified nutrition or profit.",
    ],
    [],
    [
      "Lot",
      "Feed",
      "Location",
      "Currency",
      "Active",
      "Received kg",
      "Consumed kg",
      "Lost kg",
      "Remaining kg",
      "Received value",
      "Consumed value",
      "Lost value",
      "Remaining value",
    ],
  ];
  for (const l of r.results.lots)
    rows.push([
      l.receipt.id,
      l.feedName,
      l.location,
      l.currency,
      l.active,
      l.receivedKg,
      l.consumedKg,
      l.lostKg,
      l.balanceKg,
      l.receivedValue,
      l.consumedValue,
      l.lostValue,
      l.remainingValue,
    ]);
  rows.push(
    [],
    ["Linked actual feed by batch"],
    [
      "Batch",
      "Original batch name",
      "Currency",
      "Consumed kg",
      "Known consumed value",
      "Unknown-cost kg",
    ],
  );
  for (const b of r.results.batches)
    rows.push([
      b.unitId,
      b.unitName,
      b.currency,
      b.consumedKg,
      b.knownConsumedValue,
      b.unknownCostKg,
    ]);
  rows.push(
    [],
    ["Complete immutable events"],
    [
      "Event",
      "Position",
      "Date",
      "Kind",
      "Lot",
      "Batch",
      "Kg",
      "Currency",
      "Value",
      "Reason",
      "Evidence",
      "Complete event and source",
    ],
  );
  for (const e of r.events)
    rows.push([
      e.id,
      e.position,
      e.recorded_on,
      e.kind,
      e.lot_id,
      e.unit_id,
      e.weight_kg,
      e.currency,
      e.amount,
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
