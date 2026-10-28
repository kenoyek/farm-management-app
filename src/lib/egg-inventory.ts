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
    .object({
      ...common,
      kind: z.literal("transfer"),
      grade: eggGrade,
      quantity: eggCount.positive(),
      destinationStoreId: z.uuid(),
      destinationBatchId: z.uuid(),
      destinationBatchName: z.string().trim().min(2).max(100),
    })
    .strict()
    .refine(
      (v) => v.batchId !== v.destinationBatchId,
      "A transfer needs a new destination batch.",
    ),
  z
    .object({
      ...common,
      kind: z.literal("return"),
      saleId: z.uuid(),
      trayEggs: eggCount,
      looseEggs: eggCount,
      restockEggs: eggCount,
      expectedReturnPosition: z.string().regex(/^\d+$/),
      reference: z.string().trim().min(3).max(100),
    })
    .strict()
    .refine(
      (v) =>
        v.trayEggs + v.looseEggs > 0 &&
        v.trayEggs + v.looseEggs <= 100000000 &&
        v.restockEggs <= v.trayEggs + v.looseEggs,
      "Supply returned whole eggs and a saleable restock count no greater than the return.",
    ),
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
  source_kind: "opening" | "collection" | "transfer";
  parent_batch_id?: string | null;
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
  destination_batch_id?: string | null;
  return_of_id?: string | null;
  return_tray_eggs?: number | null;
  return_loose_eggs?: number | null;
  expected_return_position?: string | null;
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
export function eggReturnState(sale: EggEvent, events: EggEvent[]) {
  if (sale.kind !== "sale" || !sale.pricing)
    throw Error("Choose an original saved sale.");
  const reversed = new Set(events.map((e) => e.reverses_id));
  const active = events
    .filter(
      (e) =>
        e.kind === "return" &&
        e.return_of_id === sale.id &&
        !reversed.has(e.id),
    )
    .sort((a, b) => (BigInt(a.position) < BigInt(b.position) ? -1 : 1));
  const returnedTrayEggs = active.reduce(
      (n, e) => n + (e.return_tray_eggs ?? 0),
      0,
    ),
    returnedLooseEggs = active.reduce(
      (n, e) => n + (e.return_loose_eggs ?? 0),
      0,
    ),
    p = sale.pricing;
  const soldTrayEggs = p.mode === "per-egg" ? 0 : p.trays * p.traySize,
    soldLooseEggs = p.mode === "per-egg" ? p.eggs : p.looseEggs;
  const related = events.filter(
    (e) =>
      e.id === sale.id ||
      e.return_of_id === sale.id ||
      e.reverses_id === sale.id,
  );
  const expectedPosition = related.reduce(
    (n, e) => (BigInt(e.position) > BigInt(n) ? e.position : n),
    sale.position,
  );
  return {
    saleId: sale.id,
    batchId: sale.batch_id,
    grade: sale.grade,
    currency: sale.currency,
    customer: sale.customer,
    reference: sale.reference,
    pricing: p,
    soldTrayEggs,
    soldLooseEggs,
    returnedTrayEggs,
    returnedLooseEggs,
    remainingTrayEggs: reversed.has(sale.id)
      ? 0
      : soldTrayEggs - returnedTrayEggs,
    remainingLooseEggs: reversed.has(sale.id)
      ? 0
      : soldLooseEggs - returnedLooseEggs,
    restockedEggs: active.reduce((n, e) => n + e.quantity, 0),
    nonSaleableEggs: active.reduce(
      (n, e) =>
        n + (e.return_tray_eggs ?? 0) + (e.return_loose_eggs ?? 0) - e.quantity,
      0,
    ),
    creditedValue: active
      .reduce((n, e) => n.minus(e.amount ?? 0), new Money(0))
      .toFixed(4),
    expectedPosition,
    latestReturnId: active.at(-1)?.id ?? null,
    fullyReversed: reversed.has(sale.id),
  };
}
export type EggReturnState = ReturnType<typeof eggReturnState>;
export function eggReturnCredit(
  state: EggReturnState,
  trayEggs: number,
  looseEggs: number,
) {
  if (
    !Number.isInteger(trayEggs) ||
    !Number.isInteger(looseEggs) ||
    trayEggs < 0 ||
    looseEggs < 0 ||
    trayEggs + looseEggs < 1 ||
    trayEggs > state.remainingTrayEggs ||
    looseEggs > state.remainingLooseEggs ||
    state.fullyReversed
  )
    throw Error("Return quantities exceed the remaining original sale.");
  const p = state.pricing;
  const trayCredit =
    p.mode === "per-egg"
      ? new Money(0)
      : new Money(p.pricePerTray)
          .mul(state.returnedTrayEggs + trayEggs)
          .div(p.traySize)
          .toDecimalPlaces(4, Money.ROUND_HALF_UP)
          .minus(
            new Money(p.pricePerTray)
              .mul(state.returnedTrayEggs)
              .div(p.traySize)
              .toDecimalPlaces(4, Money.ROUND_HALF_UP),
          );
  return trayCredit.plus(new Money(p.pricePerEgg).mul(looseEggs)).toFixed(4);
}
export function eggReversible(event: EggEvent, events: EggEvent[]) {
  if (
    !["sale", "grade", "loss", "count", "transfer", "return"].includes(
      event.kind,
    ) ||
    events.some((e) => e.reverses_id === event.id)
  )
    return false;
  if (event.kind === "sale") {
    if (!event.pricing) return false;
    const s = eggReturnState(event, events);
    return s.returnedTrayEggs + s.returnedLooseEggs === 0;
  }
  if (event.kind === "return") {
    const sale = events.find((e) => e.id === event.return_of_id);
    return !!sale && eggReturnState(sale, events).latestReturnId === event.id;
  }
  return true;
}
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
    const add = (grade: EggEvent["grade"], n: number, batchId = e.batch_id) => {
      const k = batchId + ":" + grade;
      const row = balances.get(k) ?? { batchId, grade, eggs: 0 };
      row.eggs += n;
      if (!Number.isSafeInteger(row.eggs) || row.eggs < 0)
        throw Error("Inconsistent saved egg balance.");
      balances.set(k, row);
    };
    if (e.target_grade) {
      add(e.grade, -e.quantity);
      add(e.target_grade, e.quantity);
    } else add(e.grade, e.quantity);
    if (e.destination_batch_id) {
      add(e.grade, -e.quantity, e.destination_batch_id);
      last.set(e.destination_batch_id, e.position);
    }
    if (e.kind === "receipt") heads.set(e.batch_id, e);
    last.set(e.batch_id, e.position);
    if (e.amount !== null && e.currency) {
      const s = sales.get(e.currency) ?? {
        currency: e.currency,
        eggs: 0,
        value: new Money(0),
      };
      s.eggs += e.return_of_id
        ? (e.kind === "return" ? -1 : 1) *
          ((e.return_tray_eggs ?? 0) + (e.return_loose_eggs ?? 0))
        : -e.quantity;
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
    saleReturns: source.events
      .filter((e) => e.kind === "sale" && e.pricing !== null)
      .map((e) => eggReturnState(e, source.events)),
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
    {
      name: "Transfers and returns",
      headerRows: [1],
      rows: [
        [
          "Event UUID",
          "Kind",
          "Source batch UUID",
          "Destination batch UUID",
          "Original sale UUID",
          "Tray-priced eggs returned",
          "Individually-priced eggs returned",
          "Saleable stock movement",
          "Non-saleable returned eggs",
          "Original currency",
          "Recorded value",
          "Expected sale position",
        ],
        ...source.events
          .filter((e) => e.destination_batch_id || e.return_of_id)
          .map((e) => [
            e.id,
            e.kind,
            e.batch_id,
            e.destination_batch_id ?? null,
            e.return_of_id ?? null,
            e.return_tray_eggs ?? null,
            e.return_loose_eggs ?? null,
            e.quantity,
            e.kind === "return"
              ? (e.return_tray_eggs ?? 0) +
                (e.return_loose_eggs ?? 0) -
                e.quantity
              : null,
            e.currency,
            e.amount,
            e.expected_return_position ?? null,
          ]),
        [],
        ["Batch UUID", "Store UUID", "Source kind", "Parent batch UUID"],
        ...source.batches.map((b) => [
          b.id,
          b.store_id,
          b.source_kind,
          b.parent_batch_id ?? null,
        ]),
      ],
    },
    {
      name: "Customer return reconciliation",
      headerRows: [1],
      rows: [
        [
          "Original sale UUID",
          "Batch UUID",
          "Customer",
          "Original reference",
          "Currency",
          "Active tray-priced eggs returned",
          "Active individually-priced eggs returned",
          "Saleable restocked",
          "Non-saleable returned",
          "Recorded credit",
          "Remaining tray-priced eggs",
          "Remaining individually-priced eggs",
          "Latest sale activity position",
          "Latest active return UUID",
          "Sale fully reversed",
        ],
        ...summary.saleReturns.map((s) => [
          s.saleId,
          s.batchId,
          s.customer,
          s.reference,
          s.currency,
          s.returnedTrayEggs,
          s.returnedLooseEggs,
          s.restockedEggs,
          s.nonSaleableEggs,
          s.creditedValue,
          s.remainingTrayEggs,
          s.remainingLooseEggs,
          s.expectedPosition,
          s.latestReturnId,
          s.fullyReversed ? "yes" : "no",
        ]),
      ],
    },
  ];
}
