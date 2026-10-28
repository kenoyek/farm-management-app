import type { ConflictAnalysis } from "./optimization-conflict";
import {
  nutrientKeys,
  type Ingredient,
  type FormulaLine,
  type Limits,
  type Nutrient,
  type calculateFormula,
  type compliance,
} from "./feed";
import { applyProfileBounds, type IngredientRule } from "./profile-rules";
import {
  processingRuleIssues,
  type ProcessingRule,
  type ProcessingCheck,
} from "./processing";

export type BoundSource = {
  source: "scenario" | "ingredient" | "profile" | "availability";
  percent: number;
};
export type EffectiveBound = {
  ingredientId: string;
  name: string;
  min: number;
  max: number;
  minimumSources: BoundSource[];
  maximumSources: BoundSource[];
};
export type Reachability = {
  nutrient: Nutrient;
  attainableMin: number;
  attainableMax: number;
  requiredMin?: number;
  requiredMax?: number;
};
export type Diagnostic = {
  kind:
    | "ingredient-bounds"
    | "minimum-total"
    | "maximum-total"
    | "nutrient-minimum"
    | "nutrient-maximum"
    | "combined-constraints";
  // Processing bounds are aggregate limits, not individual ingredient caps.
  message: string;
  ingredientId?: string;
  nutrient?: Nutrient;
};
export type PrimalValidation = {
  totalPercentError: number;
  maximumBoundViolationPercent: number;
  objectiveError: number;
  objectiveTolerance: number;
  nutrientTolerance: number;
  boundTolerancePercent: number;
};
export type OptimizationResult = {
  solver: string;
  message: string;
  diagnosticModelVersion: number;
  effectiveBounds: EffectiveBound[];
  reachability: Reachability[];
  diagnostics: Diagnostic[];
  runId?: string;
  conflict?: ConflictAnalysis | null;
  processingGroups?: ProcessingCheck[];
} & (
  | {
      status: "optimal";
      fractions: number[];
      objective: number;
      lines: FormulaLine[];
      calculation: ReturnType<typeof calculateFormula>;
      compliance: ReturnType<typeof compliance>;
      bindingConstraints: string[];
      validation: PrimalValidation;
    }
  | {
      status: "infeasible" | "limit" | "unbounded" | "solver-error";
      fractions: null;
      objective: null;
    }
);

// Exact extrema for one linear nutrient under the unchanged inclusion bounds
// and sum(x)=1. Other nutrient constraints are deliberately not used here; these
// ranges are necessary conditions, never a joint feasibility or safety proof.
function extreme(
  values: number[],
  bounds: EffectiveBound[],
  maximize: boolean,
) {
  let result = 0,
    remaining = 1;
  bounds.forEach((b, i) => {
    remaining -= b.min / 100;
    result += (b.min / 100) * values[i];
  });
  const order = values
    .map((value, i) => ({ value, i }))
    .sort((a, b) => (maximize ? b.value - a.value : a.value - b.value));
  for (const { value, i } of order) {
    const addition = Math.min(
      Math.max(0, remaining),
      (bounds[i].max - bounds[i].min) / 100,
    );
    result += addition * value;
    remaining -= addition;
  }
  return result;
}
export function diagnoseConstraints(
  ingredients: Ingredient[],
  lines: FormulaLine[],
  limits: Limits,
  batchKg: number,
  rules: IngredientRule[] = [],
  processingRules: ProcessingRule[] = [],
) {
  if (!Number.isFinite(batchKg) || batchKg <= 0)
    throw Error("Batch weight must be greater than zero.");
  if (
    !lines.length ||
    lines.length > 100 ||
    new Set(lines.map((l) => l.ingredientId)).size !== lines.length
  )
    throw Error("Choose one to 100 unique ingredient references.");
  applyProfileBounds(lines, rules); // Required references and the closed allowed list.
  const processingIssues = processingRuleIssues(
    processingRules,
    ingredients,
    rules.map((r) => r.ingredientId),
  );
  if (processingIssues.length) throw Error(processingIssues.join(" "));
  const effectiveBounds: EffectiveBound[] = lines.map((l) => {
    const i = ingredients.find((i) => i.id === l.ingredientId);
    if (!i) throw Error("Ingredient not found.");
    const r = rules.find((r) => r.ingredientId === l.ingredientId);
    const minimumSources: BoundSource[] = [
      { source: "scenario", percent: l.min ?? 0 },
      { source: "ingredient", percent: Number(i.inclusion_min ?? 0) },
      ...(r ? [{ source: "profile" as const, percent: r.min }] : []),
    ];
    const maximumSources: BoundSource[] = [
      { source: "scenario", percent: l.max ?? 100 },
      { source: "ingredient", percent: Number(i.inclusion_max ?? 100) },
      ...(r ? [{ source: "profile" as const, percent: r.max }] : []),
    ];
    if (
      [...minimumSources, ...maximumSources].some(
        (b) => !Number.isFinite(b.percent) || b.percent < 0 || b.percent > 100,
      )
    )
      throw Error("Inclusion bounds must be finite percentages from 0 to 100.");
    if (l.availableKg !== undefined) {
      if (!Number.isFinite(l.availableKg) || l.availableKg < 0)
        throw Error("Availability must be a finite nonnegative weight.");
      maximumSources.push({
        source: "availability",
        percent: Math.min(100, (l.availableKg / batchKg) * 100),
      });
    }
    return {
      ingredientId: i.id,
      name: i.name,
      min: Math.max(...minimumSources.map((b) => b.percent)),
      max: Math.min(...maximumSources.map((b) => b.percent)),
      minimumSources,
      maximumSources,
    };
  });
  const diagnostics: Diagnostic[] = effectiveBounds
    .filter((b) => b.min > b.max)
    .map((b) => ({
      kind: "ingredient-bounds",
      ingredientId: b.ingredientId,
      message: `${b.name}: effective minimum ${b.min}% exceeds maximum ${b.max}%. Scenario, ingredient, profile and available-quantity limits are intersected.`,
    }));
  const minTotal = effectiveBounds.reduce((s, b) => s + b.min, 0),
    maxTotal = effectiveBounds.reduce((s, b) => s + b.max, 0);
  if (minTotal > 100 + 1e-7)
    diagnostics.push({
      kind: "minimum-total",
      message: `Effective ingredient minima total ${minTotal}%, above the 100% batch total.`,
    });
  if (maxTotal < 100 - 1e-7)
    diagnostics.push({
      kind: "maximum-total",
      message: `Effective ingredient maxima total ${maxTotal}%, leaving a ${(100 - maxTotal).toFixed(6)} percentage-point shortfall.`,
    });
  const baseBoundsValid = diagnostics.length === 0;
  const processingGroups: ProcessingCheck[] = processingRules.map((rule) => {
    const values = lines.map((l) =>
      rule.ingredientIds.includes(l.ingredientId) ? 100 : 0,
    );
    const attainableMin = baseBoundsValid
      ? extreme(values, effectiveBounds, false)
      : null;
    const attainableMax = baseBoundsValid
      ? extreme(values, effectiveBounds, true)
      : null;
    if (
      attainableMin !== null &&
      attainableMax !== null &&
      (rule.minPercent > attainableMax + 1e-7 ||
        rule.maxPercent < attainableMin - 1e-7)
    )
      diagnostics.push({
        kind: "combined-constraints",
        message: `${rule.name}: processing group requires ${rule.minPercent}–${rule.maxPercent}% but can reach only ${attainableMin.toFixed(6)}–${attainableMax.toFixed(6)}% under the ingredient bounds and 100% total.`,
      });
    return {
      ...rule,
      actualPercent: null,
      status: "not-solved",
      attainableMin,
      attainableMax,
    };
  });
  const reachability: Reachability[] = [];
  if (!diagnostics.length)
    for (const n of nutrientKeys.filter((n) => limits[n])) {
      const values = lines.map(
        (l) => ingredients.find((i) => i.id === l.ingredientId)!.nutrients[n],
      );
      if (
        values.some(
          (v) =>
            typeof v !== "number" ||
            !Number.isFinite(v) ||
            v < 0 ||
            (n !== "energy" && v > 100),
        )
      )
        throw Error(`Required ${n} data is missing or invalid.`);
      const range = limits[n]!;
      if (
        [range.min, range.max].some(
          (v) =>
            v !== undefined &&
            (!Number.isFinite(v) || v < 0 || (n !== "energy" && v > 100)),
        ) ||
        (range.min ?? 0) > (range.max ?? Infinity)
      )
        throw Error(`Invalid ${n} requirement bounds.`);
      const attainableMin = extreme(values as number[], effectiveBounds, false),
        attainableMax = extreme(values as number[], effectiveBounds, true);
      reachability.push({
        nutrient: n,
        attainableMin,
        attainableMax,
        requiredMin: range.min,
        requiredMax: range.max,
      });
      if (range.min !== undefined && range.min > attainableMax + 1e-7)
        diagnostics.push({
          kind: "nutrient-minimum",
          nutrient: n,
          message: `${n}: required minimum ${range.min} exceeds the attainable maximum ${attainableMax.toFixed(6)} under the ingredient bounds and 100% total.`,
        });
      if (range.max !== undefined && range.max < attainableMin - 1e-7)
        diagnostics.push({
          kind: "nutrient-maximum",
          nutrient: n,
          message: `${n}: required maximum ${range.max} is below the attainable minimum ${attainableMin.toFixed(6)} under the ingredient bounds and 100% total.`,
        });
    }
  return {
    diagnosticModelVersion: processingRules.length ? 2 : 1,
    effectiveBounds,
    reachability,
    diagnostics,
    processingGroups,
  };
}
