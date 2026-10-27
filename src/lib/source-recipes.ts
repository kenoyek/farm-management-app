import Decimal from "decimal.js";
import { z } from "zod";
import type { CatalogRow } from "./workbook-catalog";
import type { AliasReview } from "./catalog-review";
import { calculateFormula, type FormulaLine, type Ingredient } from "./feed";

export type SourceRecipeRow = CatalogRow & {
  id: string;
  alias_review: AliasReview | null;
};
export type SourceRecipeEvidence = {
  modelVersion: 1;
  previewDigest: string;
  sourceHash: string;
  sheet: string;
  omittedUnspecifiedConfirmed: true;
  rows: SourceRecipeRow[];
};
const reviewedAlias = z
  .object({
    id: z.uuid(),
    source_row_id: z.uuid(),
    ingredient_id: z.uuid().nullable(),
    decision: z.enum(["mapped", "rejected", "unresolved"]),
    evidence: z.string().max(2000),
    reviewer_id: z.uuid(),
    revision: z.number().int().positive(),
    parent_id: z.uuid().nullable(),
    created_at: z.string(),
  })
  .passthrough();
export const sourceRecipeEvidence = z.object({
  modelVersion: z.literal(1),
  previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  sheet: z.enum(["Broiler Starter", "Broiler Finisher"]),
  omittedUnspecifiedConfirmed: z.literal(true),
  rows: z
    .array(
      z
        .object({
          id: z.uuid(),
          category: z.literal("recipe"),
          source_hash: z.string().regex(/^[a-f0-9]{64}$/),
          sheet: z.string(),
          source_row: z.number().int().positive(),
          label: z.string().max(200),
          context: z.string().max(200),
          issues: z.array(z.string().max(4000)),
          alias_review: reviewedAlias.nullable(),
          fields: z.object({
            inclusion: z.object({
              cell: z.string().max(12),
              raw: z.union([z.string(), z.number().finite(), z.null()]),
              unit: z.literal("%"),
              parsed: z.object({
                kind: z.enum(["missing", "scalar", "range", "unsupported"]),
                value: z.number().finite().optional(),
                min: z.number().finite().optional(),
                max: z.number().finite().optional(),
              }),
            }),
          }),
        })
        .passthrough(),
    )
    .length(34),
});
export function sourceRecipePlan(
  rows: SourceRecipeRow[],
  ingredients: Ingredient[],
) {
  const blockers: string[] = [];
  const lines: FormulaLine[] = [];
  let total = new Decimal(0),
    unspecified = 0;
  for (const row of rows) {
    const inclusion = row.fields.inclusion?.parsed;
    if (inclusion?.kind === "missing") {
      unspecified++;
      continue;
    }
    if (
      inclusion?.kind !== "scalar" ||
      inclusion.value === undefined ||
      !Number.isFinite(inclusion.value) ||
      inclusion.value < 0 ||
      inclusion.value > 100
    ) {
      blockers.push(`${row.label}: source inclusion needs interpretation.`);
      continue;
    }
    total = total.plus(inclusion.value);
    if (inclusion.value === 0) continue;
    const review = row.alias_review;
    if (review?.decision !== "mapped" || !review.ingredient_id) {
      blockers.push(
        `${row.label}: an explicit mapped identity review is required.`,
      );
      continue;
    }
    if (!ingredients.some((i) => i.id === review.ingredient_id)) {
      blockers.push(
        `${row.label}: mapped ingredient reference is unavailable.`,
      );
      continue;
    }
    if (lines.some((l) => l.ingredientId === review.ingredient_id)) {
      blockers.push(
        `${row.label}: multiple populated rows map to one reference. Resolve the mapping; rows are not merged.`,
      );
      continue;
    }
    lines.push({
      ingredientId: review.ingredient_id,
      percent: inclusion.value,
    });
  }
  if (!lines.length)
    blockers.push("No mapped, explicitly populated allocations are available.");
  if (total.minus(100).abs().gt(0.000001))
    blockers.push(
      "Explicit source allocations must total 100%; values are never normalized.",
    );
  return {
    lines,
    totalPercent: total.toNumber(),
    unspecifiedCount: unspecified,
    blockers,
  };
}
export function sourceRecipeCalculation(
  plan: ReturnType<typeof sourceRecipePlan>,
  ingredients: Ingredient[],
  batchKg: number,
) {
  if (plan.blockers.length) return null;
  const calculation = calculateFormula(plan.lines, ingredients, batchKg);
  return {
    ...calculation,
    releaseEligible: false,
    issues: [
      ...calculation.issues,
      "Source recipe import is an unapproved draft. Select and check a reviewed specification before saving a new reviewed version.",
    ],
  };
}
