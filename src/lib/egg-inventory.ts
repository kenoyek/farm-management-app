import { z } from "zod";
import Decimal from "decimal.js";
import type { ReportSheet } from "./recipe-reports";
const Money = Decimal.clone({ precision: 40 });
export const eggGrades = [
  "ungraded",
  "small",
  "medium",
  "large",
  "extra-large",
  "other",
] as const;
export const eggGrade = z.enum(eggGrades);
export const eggCount = z.number().int().min(0).max(100000000);
const price = z
  .string()
  .regex(/^\d{1,9}(?:\.\d{1,4})?$/)
  .refine((v) => new Money(v).lte(100000000))
  .transform((v) => new Money(v).toFixed(4));
export const eggPricing = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("per-egg"),
      eggs: eggCount.positive(),
      pricePerEgg: price,
    })
    .strict(),
  z
    .object({
      mode: z.literal("tray-and-loose"),
      trays: eggCount,
      looseEggs: eggCount,
      traySize: z.number().int().min(1).max(1000),
      pricePerTray: price,
      pricePerEgg: price,
    })
    .strict()
    .refine(
      (p) => p.looseEggs < p.traySize,
      "Loose eggs must be fewer than a complete tray.",
    ),
]);
export function eggSale(pricing: z.infer<typeof eggPricing>) {
  const p = eggPricing.parse(pricing),
    quantity =
      p.mode === "per-egg" ? p.eggs : p.trays * p.traySize + p.looseEggs;
  if (quantity < 1 || quantity > 100000000)
    throw Error("Sell between 1 and 100,000,000 whole eggs.");
  const total =
    p.mode === "per-egg"
      ? new Money(p.pricePerEgg).mul(p.eggs)
      : new Money(p.pricePerTray)
          .mul(p.trays)
          .plus(new Money(p.pricePerEgg).mul(p.looseEggs));
  if (total.gte("10000000000000000"))
    throw Error("Sale value exceeds the supported monetary range.");
  return { quantity, total: total.toFixed(4), pricing: p };
}
const common = {
  organizationId: z.uuid(),
  eventId: z.uuid(),
  batchId: z.uuid(),
  date: z.iso.date(),
  reason: z.string().trim().min(10).max(2000),
  evidence: z.string().trim().min(3).max(2000),
};
export const eggStoreInput = z
  .object({
    organizationId: z.uuid(),
    storeId: z.uuid(),
    farmId: z.uuid(),
    name: z.string().trim().min(2).max(100),
  })
  .strict();
export const eggEventInput = z.discriminatedUnion("kind", [
  z
    .object({
      ...common,
      kind: z.literal("opening"),
      storeId: z.uuid(),
      batchName: z.string().trim().min(2).max(100),
      grade: eggGrade,
      quantity: eggCount.positive(),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("receipt"),
      storeId: z.uuid(),
      batchName: z.string().trim().min(2).max(100),
      unitId: z.uuid(),
      collectionDate: z.iso.date(),
      expectedRecordId: z.uuid(),
      expectedAdjustmentId: z.uuid().nullable(),
      previousId: z.uuid().nullable(),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("grade"),
      grade: eggGrade,
      targetGrade: eggGrade,
      quantity: eggCount.positive(),
    })
    .strict()
    .refine((v) => v.grade !== v.targetGrade, "Choose different grades."),
  z
    .object({
      ...common,
      kind: z.literal("loss"),
      grade: eggGrade,
      quantity: eggCount.positive(),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("count"),
      grade: eggGrade,
      counted: eggCount,
      expectedPosition: z.string().regex(/^\d+$/),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("sale"),
      grade: eggGrade,
      currency: z.string().regex(/^[A-Z]{3}$/),
      customer: z.string().trim().min(1).max(200),
      reference: z.string().trim().min(3).max(100),
      pricing: eggPricing,
    })
    .strict(),
  z
    .object({ ...common, kind: z.literal("reversal"), reversesId: z.uuid() })
    .strict(),
]);
export type EggEventInput = z.infer<typeof eggEventInput>;
export type EggStore = {
  id: string;
  organization_id: string;
  farm_id: string;
  name: string;
  created_by: string;
  created_at: string;
};
export type EggBatch = {
  id: string;
  organization_id: string;
  store_id: string;
  name: string;
  source_kind: "opening" | "collection";
  unit_id: string | null;
  collected_on: string | null;
  received_on: string;
};
export type EggEvent = {
  id: string;
  position: string;
  organization_id: string;
  batch_id: string;
  kind: EggEventInput["kind"];
  occurred_on: string;
  grade: (typeof eggGrades)[number];
  target_grade: (typeof eggGrades)[number] | null;
  quantity: number;
  previous_id: string | null;
  reverses_id: string | null;
  source_snapshot: Record<string, unknown> | null;
  source_quantity: number | null;
  stock_count: number | null;
  expected_position: string | null;
  pricing: z.infer<typeof eggPricing> | null;
  amount: string | null;
  currency: string | null;
  customer: string | null;
  reference: string | null;
  reason: string;
  evidence: string;
  created_by: string;
  created_at: string;
};
export type EggCollection = {
  id: string;
  organization_id: string;
  unit_id: string;
  recorded_on: string;
  eggs: number;
  cracked: number;
  adjustment_id: string | null;
  unit_name: string;
  farm_id: string;
  [key: string]: unknown;
};
export type EggSource = {
  organization: {
    id: string;
    name: string;
    currency: string;
    timezone: string;
    today: string;
  };
  stores: EggStore[];
  batches: EggBatch[];
  events: EggEvent[];
  collections: EggCollection[];
};
export function eggSummary(source: EggSource) {
  const balances = new Map<
      string,
      { batchId: string; grade: EggEvent["grade"]; eggs: number }
    >(),
    heads = new Map<string, EggEvent>(),
    last = new Map<string, string>(),
    sales = new Map<
      string,
      { currency: string; eggs: number; value: Decimal }
    >();
  const events = [...source.events].sort((a, b) =>
    BigInt(a.position) < BigInt(b.position) ? -1 : 1,
  );
  for (const e of events) {
    const add = (grade: EggEvent["grade"], n: number) => {
      const k = e.batch_id + ":" + grade;
      const row = balances.get(k) ?? { batchId: e.batch_id, grade, eggs: 0 };
      row.eggs += n;
      if (!Number.isSafeInteger(row.eggs) || row.eggs < 0)
        throw Error("Inconsistent saved egg balance.");
      balances.set(k, row);
    };
    if (e.target_grade) {
      add(e.grade, -e.quantity);
      add(e.target_grade, e.quantity);
    } else add(e.grade, e.quantity);
    if (e.kind === "receipt") heads.set(e.batch_id, e);
    last.set(e.batch_id, e.position);
    if (e.amount !== null && e.currency) {
      const s = sales.get(e.currency) ?? {
        currency: e.currency,
        eggs: 0,
        value: new Money(0),
      };
      s.eggs -= e.quantity;
      s.value = s.value.plus(e.amount);
      sales.set(e.currency, s);
    }
  }
  const reconciliation = source.collections.map((c) => {
    const b = source.batches.find(
        (b) => b.unit_id === c.unit_id && b.collected_on === c.recorded_on,
      ),
      h = b ? heads.get(b.id) : undefined;
    return {
      unitId: c.unit_id,
      date: c.recorded_on,
      recordId: c.id,
      adjustmentId: c.adjustment_id,
      batchId: b?.id ?? null,
      previousId: h?.id ?? null,
      saleable: c.eggs - c.cracked,
      received: h?.source_quantity ?? null,
      difference: c.eggs - c.cracked - (h?.source_quantity ?? 0),
      status: !h
        ? "not-received"
        : h.source_snapshot?.id !== c.id ||
            (h.source_snapshot?.adjustment_id ?? null) !==
              (c.adjustment_id ?? null)
          ? "source-changed"
          : "reconciled",
    };
  });
  return {
    balances: [...balances.values()],
    totalEggs: [...balances.values()].reduce((n, b) => n + b.eggs, 0),
    sales: [...sales.values()].map((s) => ({
      currency: s.currency,
      netEggs: s.eggs,
      netValue: s.value.toFixed(4),
    })),
    lastPositions: Object.fromEntries(last),
    reconciliation,
  };
}
export type EggSummary = ReturnType<typeof eggSummary>;
export type EggSnapshot = EggSource & {
  modelVersion: string;
  summary: EggSummary;
  evidenceSha256: string;
  generatedAt: string;
};
export function eggSheets(
  source: EggSource,
  summary: EggSummary,
  digest: string,
): ReportSheet[] {
  return [
    {
      name: "Egg inventory",
      headerRows: [1],
      rows: [
        [
          "Physical saleable eggs",
          "Whole eggs; explicit receipts and movements",
        ],
        ["Organization", source.organization.id],
        ["Timezone", source.organization.timezone],
        ["Snapshot SHA-256", digest],
        [
          "Scope",
          "Recorded stock and sale values only. No cash, receivable, cost, tax or profit journal.",
        ],
        ["Total eggs", summary.totalEggs],
        [],
        ["Currency", "Net eggs sold", "Net recorded sale value"],
        ...summary.sales.map((s) => [s.currency, s.netEggs, s.netValue]),
      ],
    },
    {
      name: "Stock by batch and grade",
      headerRows: [1],
      rows: [
        [
          "Batch UUID",
          "Batch",
          "Store UUID",
          "Store",
          "Source",
          "Unit UUID",
          "Collected on",
          "Received on",
          "Grade",
          "Eggs",
        ],
        ...summary.balances.map((r) => {
          const b = source.batches.find((b) => b.id === r.batchId)!,
            s = source.stores.find((s) => s.id === b.store_id);
          return [
            b.id,
            b.name,
            b.store_id,
            s?.name ?? null,
            b.source_kind,
            b.unit_id,
            b.collected_on,
            b.received_on,
            r.grade,
            r.eggs,
          ];
        }),
      ],
    },
    {
      name: "Collection reconciliation",
      headerRows: [1],
      rows: [
        [
          "Unit UUID",
          "Date",
          "Current original UUID",
          "Current review UUID",
          "Batch UUID",
          "Last receipt UUID",
          "Current saleable",
          "Receipted source count",
          "Difference",
          "Status",
        ],
        ...summary.reconciliation.map((r) => [
          r.unitId,
          r.date,
          r.recordId,
          r.adjustmentId,
          r.batchId,
          r.previousId,
          r.saleable,
          r.received,
          r.difference,
          r.status,
        ]),
      ],
    },
    {
      name: "Immutable movements",
      headerRows: [1],
      rows: [
        [
          "Position",
          "Event UUID",
          "Batch UUID",
          "Date",
          "Kind",
          "Grade",
          "Target grade",
          "Signed quantity (grading transfers quantity)",
          "Source count",
          "Previous receipt",
          "Reversed event",
          "Currency",
          "Recorded amount",
          "Customer",
          "Sale reference",
          "Pricing mode",
          "Eggs priced",
          "Trays",
          "Loose eggs",
          "Tray size",
          "Price per tray",
          "Price per egg",
          "Physical count",
          "Expected position",
          "Reason",
          "Evidence",
          "Reviewer UUID",
          "Recorded at",
        ],
        ...source.events.map((e) => {
          const p = e.pricing;
          return [
            e.position,
            e.id,
            e.batch_id,
            e.occurred_on,
            e.kind,
            e.grade,
            e.target_grade,
            e.quantity,
            e.source_quantity,
            e.previous_id,
            e.reverses_id,
            e.currency,
            e.amount,
            e.customer,
            e.reference,
            p?.mode ?? null,
            p?.mode === "per-egg" ? p.eggs : null,
            p?.mode === "tray-and-loose" ? p.trays : null,
            p?.mode === "tray-and-loose" ? p.looseEggs : null,
            p?.mode === "tray-and-loose" ? p.traySize : null,
            p?.mode === "tray-and-loose" ? p.pricePerTray : null,
            p?.pricePerEgg ?? null,
            e.stock_count,
            e.expected_position,
            e.reason,
            e.evidence,
            e.created_by,
            e.created_at,
          ];
        }),
      ],
    },
    {
      name: "Receipt source evidence",
      headerRows: [1],
      rows: [
        [
          "Receipt UUID",
          "Batch UUID",
          "Source record UUID",
          "Source review UUID",
          "Complete immutable actual source JSON",
        ],
        ...source.events
          .filter((e) => e.kind === "receipt")
          .map((e) => [
            e.id,
            e.batch_id,
            e.source_snapshot?.id === undefined
              ? null
              : String(e.source_snapshot.id),
            e.source_snapshot?.adjustment_id === undefined ||
            e.source_snapshot?.adjustment_id === null
              ? null
              : String(e.source_snapshot.adjustment_id),
            JSON.stringify(e.source_snapshot),
          ]),
      ],
    },
  ];
}
