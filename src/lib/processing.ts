import { z } from "zod";
import Decimal from "decimal.js";
import type { FormulaLine, Ingredient } from "./feed";

export const processingMethod = z
  .string()
  .trim()
  .regex(
    /^[a-z][a-z0-9-]{0,49}$/,
    "Use a lowercase method identifier, e.g. heat-treated.",
  );
export const processingRule = z
  .object({
    name: z.string().trim().min(2).max(100),
    ingredientIds: z
      .array(z.uuid())
      .min(1)
      .max(100)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Select distinct exact references.",
      ),
    minPercent: z.number().finite().min(0).max(100),
    maxPercent: z.number().finite().min(0).max(100),
    requiredMethod: processingMethod.nullable(),
    source: z.string().trim().min(10).max(2000),
  })
  .strict()
  .refine(
    (r) => r.minPercent <= r.maxPercent,
    "Group minimum exceeds maximum.",
  );
export const processingRules = z
  .array(processingRule)
  .max(20)
  .refine(
    (rs) => new Set(rs.map((r) => r.name)).size === rs.length,
    "Processing group names must be unique.",
  );
export type ProcessingRule = z.infer<typeof processingRule>;
export type ProcessingCheck = ProcessingRule & {
  actualPercent: number | null;
  status: "pass" | "fail" | "not-solved";
  attainableMin?: number | null;
  attainableMax?: number | null;
};
export function processingRuleIssues(
  groups: ProcessingRule[],
  ingredients: Ingredient[],
  allowedIds: string[],
) {
  if (!groups.length) return [];
  const checked = processingRules.parse(groups);
  const issues: string[] = [];
  if (!allowedIds.length)
    issues.push("Processing groups require a closed ingredient allowed list.");
  for (const g of checked)
    for (const id of g.ingredientIds) {
      const i = ingredients.find((i) => i.id === id);
      if (!allowedIds.includes(id) || !i)
        issues.push(
          `${g.name}: every reference must be on the exact ingredient allowed list.`,
        );
      else if (i.review_status !== "approved")
        issues.push(
          `${g.name}: processing rules require approved ingredient references.`,
        );
      else if (
        g.requiredMethod &&
        (i.processing_method !== g.requiredMethod ||
          !i.processing_evidence ||
          i.processing_evidence.trim().length < 10)
      )
        issues.push(
          `${g.name}: ${i.name} requires recorded ${g.requiredMethod} processing and supporting evidence.`,
        );
    }
  return issues;
}
export function processingCompliance(
  lines: FormulaLine[],
  groups: ProcessingRule[],
): ProcessingCheck[] {
  return groups.map((g) => {
    const actual = lines
      .filter((l) => g.ingredientIds.includes(l.ingredientId))
      .reduce((sum, l) => sum.plus(l.percent), new Decimal(0))
      .toNumber();
    return {
      ...g,
      actualPercent: actual,
      status:
        actual < g.minPercent - 1e-7 || actual > g.maxPercent + 1e-7
          ? "fail"
          : "pass",
    };
  });
}
