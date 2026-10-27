import Decimal from "decimal.js";
import { z } from "zod";
import { nutrientKeys, type Nutrient, type Nutrients } from "./feed";
import { coreNutrientKeys, nutrientLabels } from "./nutrients";
export { nutrientLabels } from "./nutrients";

const amount = z
  .union([z.string().min(1).max(100), z.number().finite()])
  .refine((v) => {
    try {
      return (
        new Decimal(v).isFinite() &&
        new Decimal(v).gte(0) &&
        new Decimal(v).lte("1e22")
      );
    } catch {
      return false;
    }
  }, "Invalid saved amount.");
const nullableAmount = amount.nullable();
const reference = z.object({
  id: z.uuid(),
  name: z.string(),
  source: z.string(),
  price: nullableAmount,
  revision: z.number().int().positive().default(1),
  parent_id: z.uuid().nullable().optional(),
  review_status: z.string(),
  basis: z.string().nullable(),
  energy_system: z.string().nullable(),
  species: z.string().optional(),
  stages: z.array(z.string()).optional(),
  phosphorus_basis: z.string().optional(),
  quoted_on: z.string().nullable().optional(),
  reviewer_id: z.uuid().nullable().optional(),
  verified_at: z.string().nullable().optional(),
  inclusion_min: amount.optional(),
  inclusion_max: amount.optional(),
  upload_id: z.uuid().nullable().optional(),
  upload_row: z.number().nullable().optional(),
});
const range = z.object({
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
});
const profileSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  revision: z.number().int().positive().default(1),
  species: z.string(),
  stage: z.string(),
  basis: z.string(),
  energy_system: z.string(),
  phosphorus_basis: z.string().default("unknown"),
  source: z.string(),
  reviewer_id: z.uuid().nullable(),
  created_at: z.string(),
  limits: z.object(
    Object.fromEntries(
      nutrientKeys.map((k) => [k, range.optional()]),
    ) as Record<Nutrient, z.ZodOptional<typeof range>>,
  ),
  ingredient_rules: z
    .array(
      z.object({
        ingredientId: z.uuid(),
        min: z.number().finite(),
        max: z.number().finite(),
        source: z.string(),
      }),
    )
    .default([]),
});
const recipeSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: z.enum(["draft", "pending-review", "approved", "rejected"]),
  batch_kg: amount.refine((v) => new Decimal(v).gt(0)),
  profile_id: z.uuid().nullable(),
  created_at: z
    .union([z.date(), z.iso.datetime({ offset: true })])
    .transform((v) => new Date(v).toISOString()),
  lines: z
    .array(
      z.object({
        ingredientId: z.uuid(),
        percent: z.number().finite().min(0).max(100),
        min: z.number().optional(),
        max: z.number().optional(),
        availableKg: z.number().optional(),
      }),
    )
    .min(1)
    .max(100),
  ingredient_snapshot: z.array(reference).max(100),
  result: z.object({
    totalPercent: z.number().finite(),
    costPerKg: nullableAmount,
    batchCost: nullableAmount,
    nutrients: z.object(
      Object.fromEntries(
        nutrientKeys.map((k) => [k, z.number().finite().nullable().optional()]),
      ) as Record<Nutrient, z.ZodOptional<z.ZodNullable<z.ZodNumber>>>,
    ),
    compliance: z
      .array(
        z.object({
          nutrient: z.enum(nutrientKeys),
          min: z.number().optional(),
          max: z.number().optional(),
          status: z.enum(["pass", "fail", "unknown"]),
        }),
      )
      .default([]),
    issues: z.array(z.string()),
    releaseEligible: z.boolean(),
    profileSnapshot: z.unknown().optional(),
    savedBy: z.uuid().optional(),
    modelVersion: z.number().optional(),
  }),
  profile_reference: z.unknown().optional(),
});
export type RecipeReport = ReturnType<typeof recipeReport>;

// Consume only saved allocations, prices and results. No current ingredient or
// quotation is consulted and incomplete inclusion totals are never normalized.
export function recipeReport(raw: unknown) {
  const recipe = recipeSchema.parse(raw);
  if (
    new Set(recipe.lines.map((l) => l.ingredientId)).size !==
    recipe.lines.length
  )
    throw Error("Duplicate saved allocations.");
  const profileRaw = recipe.result.profileSnapshot ?? recipe.profile_reference;
  const profile = profileRaw ? profileSchema.parse(profileRaw) : null;
  if (profile && profile.id !== recipe.profile_id)
    throw Error("Saved specification does not match the recipe.");
  const allocations = recipe.lines.map((l) => {
    const ingredient = recipe.ingredient_snapshot.find(
      (i) => i.id === l.ingredientId,
    );
    if (!ingredient) throw Error("Saved ingredient evidence is missing.");
    return {
      ...l,
      kg: new Decimal(l.percent).div(100).mul(recipe.batch_kg).toFixed(6),
      reference: ingredient,
    };
  });
  return {
    id: recipe.id,
    name: recipe.name,
    status: recipe.status,
    createdAt: recipe.created_at,
    batchKg: new Decimal(recipe.batch_kg).toFixed(6),
    totalPercent: recipe.result.totalPercent,
    costPerKg:
      recipe.result.costPerKg === null
        ? null
        : new Decimal(recipe.result.costPerKg).toFixed(4),
    batchCost:
      recipe.result.batchCost === null
        ? null
        : new Decimal(recipe.result.batchCost).toFixed(2),
    nutrients: Object.fromEntries(
      nutrientKeys
        .filter(
          (k) =>
            (coreNutrientKeys as readonly string[]).includes(k) ||
            Object.hasOwn(recipe.result.nutrients, k),
        )
        .map((k) => [k, recipe.result.nutrients[k] ?? null]),
    ) as Nutrients,
    compliance: recipe.result.compliance,
    issues: recipe.result.issues,
    eligibleAtSave: recipe.result.releaseEligible,
    savedBy: recipe.result.savedBy ?? null,
    modelVersion: recipe.result.modelVersion ?? 1,
    profile,
    profileEvidence: recipe.result.profileSnapshot
      ? "embedded snapshot"
      : profile
        ? "immutable profile reference"
        : "not recorded",
    allocations,
    notice:
      recipe.status === "approved"
        ? "APPROVED SAVED VERSION — historical review only. No current stock reservation or manufacturing release."
        : `${recipe.status.toUpperCase()} — NOT APPROVED. Do not use as a released production formula.`,
  };
}
const subtract = (value: string | null, base: string | null, places: number) =>
  value === null || base === null
    ? null
    : new Decimal(value).minus(base).toFixed(places);
const contextKeys = [
  "species",
  "stage",
  "basis",
  "energy_system",
  "phosphorus_basis",
] as const;
export function compareRecipes(reports: RecipeReport[], batchKg: number) {
  if (
    reports.length < 2 ||
    reports.length > 4 ||
    new Set(reports.map((r) => r.id)).size !== reports.length
  )
    throw Error("Choose two to four distinct saved versions.");
  if (!Number.isFinite(batchKg) || batchKg <= 0 || batchKg > 1e8)
    throw Error("Choose a comparison batch between zero and 100,000,000 kg.");
  const baseline = reports[0];
  const contextComparable = reports.every(
    (r) =>
      r.profile &&
      contextKeys.every(
        (k) =>
          r.profile![k] &&
          r.profile![k] !== "unknown" &&
          r.profile![k] === baseline.profile?.[k],
      ),
  );
  const warnings: string[] = [];
  if (!contextComparable)
    warnings.push(
      "Scientific contexts differ or are missing. Nutrient deltas are unavailable; do not treat these recipes as interchangeable.",
    );
  if (new Set(reports.map((r) => r.profile?.id ?? null)).size > 1)
    warnings.push(
      "Specifications differ. Each compliance result belongs to that recipe's own saved specification.",
    );
  if (reports.some((r) => r.status !== "approved"))
    warnings.push("At least one selected version is not approved.");
  if (reports.some((r) => Math.abs(r.totalPercent - 100) > 1e-6))
    warnings.push(
      "At least one allocation total is incomplete. Weights and costs have not been normalized to 100%.",
    );
  return {
    baselineId: baseline.id,
    batchKg,
    contextComparable,
    warnings,
    versions: reports.map((r) => ({
      ...r,
      commonBatchCost:
        r.costPerKg === null
          ? null
          : new Decimal(r.costPerKg).mul(batchKg).toFixed(2),
      deltaPerKg: subtract(r.costPerKg, baseline.costPerKg, 4),
      deltaCommonBatch:
        r.costPerKg === null || baseline.costPerKg === null
          ? null
          : new Decimal(r.costPerKg)
              .minus(baseline.costPerKg)
              .mul(batchKg)
              .toFixed(2),
      nutrientDeltas: Object.fromEntries(
        nutrientKeys.map((k) => [
          k,
          contextComparable &&
          r.nutrients[k] != null &&
          baseline.nutrients[k] != null
            ? new Decimal(r.nutrients[k]!)
                .minus(baseline.nutrients[k]!)
                .toNumber()
            : null,
        ]),
      ) as Record<Nutrient, number | null>,
      scaledAllocations: r.allocations.map((l) => ({
        ingredientId: l.ingredientId,
        kg: new Decimal(l.percent).div(100).mul(batchKg).toFixed(6),
      })),
    })),
  };
}
export type RecipeComparison = ReturnType<typeof compareRecipes>;
export type ReportCell = string | number | null;
export type ReportSheet = {
  name: string;
  rows: ReportCell[][];
  headerRows: number[];
};

export function recipeSheets(
  report: RecipeReport,
  organizationId: string,
  digest: string,
): ReportSheet[] {
  const p = report.profile;
  const mixing: ReportCell[][] = [
    ["Farmstead saved mixing sheet", report.notice],
    ["Recipe", report.name],
    ["Version UUID", report.id],
    ["Organization UUID", organizationId],
    ["Saved at (UTC)", report.createdAt],
    ["Saved by UUID", report.savedBy ?? "Not recorded in this version"],
    ["Saved status", report.status],
    ["Original batch kg", Number(report.batchKg)],
    ["Total inclusion %", report.totalPercent],
    ["Saved NGN/kg (decimal text)", report.costPerKg],
    ["Saved batch NGN (decimal text)", report.batchCost],
    ["Report model / calculation model", `1 / ${report.modelVersion}`],
    ["Snapshot SHA-256", digest],
    [
      "Scope",
      "Saved values only. No current price conversion, stock issue or manufacturing release. Money is decimal text; unknown values are blank.",
    ],
    [],
    [
      "Ingredient",
      "Reference UUID",
      "Reference revision",
      "Inclusion %",
      "Original batch kg",
      "Saved NGN/kg",
      "Scenario min %",
      "Scenario max %",
      "Available kg at save",
    ],
    ...report.allocations.map(
      (l) =>
        [
          l.reference.name,
          l.ingredientId,
          l.reference.revision,
          l.percent,
          Number(l.kg),
          l.reference.price === null
            ? null
            : new Decimal(l.reference.price).toFixed(4),
          l.min ?? null,
          l.max ?? null,
          l.availableKg ?? null,
        ] as ReportCell[],
    ),
    [],
    ["Saved review issues"],
    ...report.issues.map((issue) => [issue]),
  ];
  return [
    { name: "Mixing sheet", rows: mixing, headerRows: [1, 16] },
    {
      name: "Nutrients",
      headerRows: [1],
      rows: [
        [
          "Nutrient / unit",
          "Saved actual",
          "Own minimum",
          "Own maximum",
          "Saved check",
        ],
        ...nutrientKeys
          .filter((k) => Object.hasOwn(report.nutrients, k))
          .map((k) => {
            const c = report.compliance.find((c) => c.nutrient === k);
            return [
              nutrientLabels[k],
              report.nutrients[k] ?? null,
              p?.limits[k]?.min ?? null,
              p?.limits[k]?.max ?? null,
              c?.status ?? "No saved check",
            ];
          }),
      ],
    },
    {
      name: "Reference audit",
      headerRows: [1],
      rows: [
        [
          "Ingredient",
          "UUID",
          "Revision",
          "Parent UUID",
          "Review status at save",
          "Species",
          "Stages",
          "Nutrient basis",
          "Energy system",
          "Phosphorus basis",
          "Quoted on",
          "Reviewer UUID",
          "Reviewed at",
          "Ingredient min %",
          "Ingredient max %",
          "Upload UUID",
          "Upload row",
          "Source evidence",
        ],
        ...report.allocations.map(({ reference: i }) => [
          i.name,
          i.id,
          i.revision,
          i.parent_id ?? null,
          i.review_status,
          i.species ?? null,
          i.stages?.join(", ") ?? null,
          i.basis,
          i.energy_system,
          i.phosphorus_basis ?? null,
          i.quoted_on ?? null,
          i.reviewer_id ?? null,
          i.verified_at ?? null,
          i.inclusion_min ?? null,
          i.inclusion_max ?? null,
          i.upload_id ?? null,
          i.upload_row ?? null,
          i.source,
        ]),
      ],
    },
    {
      name: "Specification",
      headerRows: [1, 14],
      rows: [
        ["Specification field", "Saved reference"],
        ["Evidence", report.profileEvidence],
        ["Profile UUID", p?.id ?? null],
        ["Name", p?.name ?? null],
        ["Revision", p?.revision ?? null],
        ["Species / stage", p ? `${p.species} / ${p.stage}` : null],
        ["Nutrient basis", p?.basis ?? null],
        ["Energy system", p?.energy_system ?? null],
        ["Phosphorus basis", p?.phosphorus_basis ?? null],
        ["Reviewer UUID", p?.reviewer_id ?? null],
        ["Reviewed at", p?.created_at ?? null],
        ["Source evidence", p?.source ?? null],
        [],
        [
          "Allowed ingredient UUID",
          "Minimum %",
          "Maximum %",
          "Review evidence",
        ],
        ...(p?.ingredient_rules ?? []).map((r) => [
          r.ingredientId,
          r.min,
          r.max,
          r.source,
        ]),
      ],
    },
  ];
}
export function sheetsCsv(sheets: ReportSheet[]) {
  return sheets
    .flatMap((s) => [[s.name], ...s.rows, []])
    .map((row) =>
      row
        .map((v) => {
          let text = v === null ? "" : String(v);
          if (/^(?:\s*[=+\-@]|[\t\r\n])/.test(text)) text = "'" + text;
          return `"${text.replaceAll('"', '""')}"`;
        })
        .join(","),
    )
    .join("\r\n");
}
