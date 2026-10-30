import { z } from "zod";
import DecimalBase from "decimal.js";
import {
  broilerSummary,
  type BroilerSource,
  type BroilerUnit,
  type BroilerEvent,
} from "./broiler-lifecycle";
const D = DecimalBase.clone({ precision: 40 });
const uuid = z.uuid().transform((v) => v.toLowerCase());
const kg = (zero: boolean) =>
  z
    .string()
    .refine(
      (v) =>
        /^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/.test(v) &&
        new D(v).lte(1e8) &&
        (zero || new D(v).gt(0)),
      "Enter measured kg within range and six decimal places, or explicitly unknown.",
    )
    .transform((v) => new D(v).toFixed(6));
const evidence = {
  reason: z.string().trim().min(10).max(2000),
  evidence: z.string().trim().min(3).max(2000),
};
export const processingData = z.discriminatedUnion("kind", [
  // The v1 scope attests the whole group's ownership/unsold status at processing,
  // distinct outputs and no added mass. An unpriced source is not that proof.
  z
    .strictObject({
      kind: z.literal("record"),
      processedOn: z.iso.date(),
      productForm: z.enum(["dressed_whole", "cut_parts", "other"]),
      products: z
        .array(
          z.strictObject({
            name: z.string().trim().min(2).max(100),
            role: z.enum(["primary", "by_product", "other"]),
            disposition: z.enum(["intended", "not_intended", "unassessed"]),
            weightKg: kg(false).nullable(),
          }),
        )
        .min(1)
        .max(12),
      residualKg: kg(true).nullable(),
      scope: z.literal("whole-harvest-no-added-mass"),
      ...evidence,
    })
    .superRefine((v, c) => {
      if (new Set(v.products.map((p) => p.name)).size !== v.products.length)
        c.addIssue({
          code: "custom",
          message: "Use distinct output names within this harvest.",
        });
      if (!v.products.some((p) => p.role === "primary"))
        c.addIssue({
          code: "custom",
          message: "Identify at least one primary output.",
        });
    }),
  z.strictObject({ kind: z.literal("withdraw"), ...evidence }),
]);
export const processingInput = z.strictObject({
  organizationId: uuid,
  unitId: uuid,
  reviewId: uuid,
  harvestId: uuid,
  previousId: uuid.nullable(),
  expectedPosition: z.string().regex(/^(0|[1-9]\d{0,18})$/),
  expectedDailyId: uuid.nullable(),
  data: processingData,
});
export type ProcessingData = z.infer<typeof processingData>;
export type ProcessingRecord = Extract<ProcessingData, { kind: "record" }>;
export type ProcessingInput = z.infer<typeof processingInput>;
export type ProcessingReview = {
  id: string;
  organization_id: string;
  unit_id: string;
  harvest_id: string;
  previous_id: string | null;
  revision: number;
  position: string;
  expected_position: string;
  expected_daily_id: string | null;
  input: ProcessingData;
  harvest_snapshot: BroilerEvent;
  unit_snapshot: BroilerUnit;
  timezone: string;
  submission: ProcessingInput;
  created_by: string;
  created_at: string;
};
export const processingModel = "broiler-whole-harvest-measured-yields-v1";
export function processingHeads(rows: ProcessingReview[]) {
  const replaced = new Set(rows.map((r) => r.previous_id));
  return rows.filter((r) => !replaced.has(r.id));
}
export function measuredProcessing(raw: ProcessingData, source: BroilerEvent) {
  const p = processingData.parse(raw);
  if (p.kind === "withdraw") return null;
  if (
    source.kind !== "harvest" ||
    source.price_basis !== "unpriced" ||
    source.weight_kg === null ||
    new D(source.weight_kg).lte(0)
  )
    throw Error("Choose an unsold measured whole harvest.");
  if (p.processedOn < source.recorded_on)
    throw Error("Processing date cannot precede its source harvest.");
  const input = new D(source.weight_kg),
    sum = (rows: typeof p.products) =>
      rows.reduce((n, p) => n.plus(p.weightKg ?? 0), new D(0));
  const known = sum(p.products),
    total = p.products.some((p) => p.weightKg === null) ? null : known,
    primaryRows = p.products.filter((p) => p.role === "primary"),
    primary = primaryRows.some((p) => p.weightKg === null)
      ? null
      : sum(primaryRows),
    intendedRows = p.products.filter((p) => p.disposition === "intended"),
    knownIntended = sum(intendedRows);
  const intended =
      p.products.some((p) => p.disposition === "unassessed") ||
      intendedRows.some((p) => p.weightKg === null)
        ? null
        : knownIntended,
    residual = p.residualKg === null ? null : new D(p.residualKg),
    accounted = known.plus(residual ?? 0);
  if (accounted.gt(input))
    throw Error(
      "Known output and residual mass exceeds the original live input.",
    );
  const difference =
    total !== null && residual !== null
      ? input.minus(total).minus(residual)
      : null;
  return {
    inputBirds: source.quantity,
    inputLiveKg: input.toFixed(6),
    knownOutputKg: known.toFixed(6),
    totalOutputKg: total?.toFixed(6) ?? null,
    primaryOutputKg: primary?.toFixed(6) ?? null,
    primaryYieldFraction: primary?.div(input).toFixed(8) ?? null,
    dressingYieldFraction:
      p.productForm === "dressed_whole"
        ? (primary?.div(input).toFixed(8) ?? null)
        : null,
    knownIntendedSaleKg: knownIntended.toFixed(6),
    intendedSaleKg: intended?.toFixed(6) ?? null,
    intendedYieldFraction: intended?.div(input).toFixed(8) ?? null,
    measuredResidualKg: residual?.toFixed(6) ?? null,
    knownAccountedKg: accounted.toFixed(6),
    unreconciledKg: difference?.toFixed(6) ?? null,
    massState:
      difference === null
        ? "incomplete"
        : difference.isZero()
          ? "balanced"
          : "unreconciled",
  };
}
export function processingWorkspace(s: BroilerSource) {
  const voids = new Set(s.events.map((e) => e.void_of_id)),
    heads = processingHeads(s.processingReviews ?? []),
    guidance = broilerSummary(s).harvestGuidance;
  const harvests = s.events.filter(
    (e) =>
      e.kind === "harvest" && e.price_basis === "unpriced" && !voids.has(e.id),
  );
  const lots = heads.map((r) => ({
    review: r,
    sourceState: voids.has(r.harvest_id)
      ? "inactive"
      : r.input.kind === "withdraw"
        ? "withdrawn"
        : "recorded",
    metrics: measuredProcessing(r.input, r.harvest_snapshot),
    guidance: guidance.find((h) => h.harvestId === r.harvest_id) ?? null,
  }));
  return { harvests, lots };
}
export type ProcessingReport = {
  modelVersion: string;
  source: ReturnType<typeof import("./broiler-lifecycle").broilerEvidence>;
  results: ReturnType<typeof processingWorkspace>;
  evidenceSha256: string;
};
export function processingCsv(r: ProcessingReport) {
  const rows: unknown[][] = [
    ["Measured broiler processing", r.modelVersion],
    ["Evidence SHA-256", r.evidenceSha256],
    [
      "Whole unsold harvest measurements only. No extra animal, product inventory, sale, cash or cost posting.",
    ],
    ["Complete lifecycle source", JSON.stringify(r.source)],
    [],
    ["Current processing measurements"],
    [
      "Review",
      "Harvest",
      "Revision",
      "State",
      "Full metrics",
      "Current harvest guidance concerns",
    ],
  ];
  for (const lot of r.results.lots)
    rows.push([
      lot.review.id,
      lot.review.harvest_id,
      lot.review.revision,
      lot.sourceState,
      JSON.stringify(lot.metrics),
      JSON.stringify(lot.guidance),
    ]);
  rows.push(
    [],
    ["Measured output lines"],
    [
      "Review",
      "Harvest",
      "State",
      "Output name",
      "Role",
      "Intended use",
      "Measured kg",
    ],
  );
  for (const lot of r.results.lots)
    if (lot.review.input.kind === "record")
      for (const p of lot.review.input.products)
        rows.push([
          lot.review.id,
          lot.review.harvest_id,
          lot.sourceState,
          p.name,
          p.role,
          p.disposition,
          p.weightKg,
        ]);
  rows.push(
    [],
    ["Immutable processing review history"],
    [
      "Review",
      "Harvest",
      "Revision",
      "Kind",
      "Reason",
      "Evidence",
      "Complete original harvest",
      "Complete immutable review",
    ],
  );
  for (const row of r.source.processingReviews ?? [])
    rows.push([
      row.id,
      row.harvest_id,
      row.revision,
      row.input.kind,
      row.input.reason,
      row.input.evidence,
      JSON.stringify(row.harvest_snapshot),
      JSON.stringify(row),
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
