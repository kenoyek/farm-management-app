import Decimal from "decimal.js";
export const nutrientKeys = [
  "energy",
  "protein",
  "dryMatter",
  "calcium",
  "phosphorus",
  "methionine",
  "lysine",
] as const;
export type Nutrient = (typeof nutrientKeys)[number];
export type Nutrients = Record<Nutrient, number | null>;
export type Ingredient = {
  id: string;
  parent_id?: string | null;
  revision?: number;
  name: string;
  nutrients: Nutrients;
  price: string | number | null;
  review_status: string;
  source: string;
  basis: string | null;
  energy_system: string | null;
  species?: string;
  stages?: string[];
  phosphorus_basis?: string;
  quoted_on?: string;
  inclusion_min?: string | number;
  inclusion_max?: string | number;
};
export type FormulaLine = {
  ingredientId: string;
  percent: number;
  min?: number;
  max?: number;
  availableKg?: number;
};
export function calculateFormula(
  lines: FormulaLine[],
  ingredients: Ingredient[],
  batchKg: number,
) {
  if (!Number.isFinite(batchKg) || batchKg <= 0)
    throw Error("Batch weight must be greater than zero.");
  if (
    !lines.length ||
    new Set(lines.map((l) => l.ingredientId)).size !== lines.length
  )
    throw Error("Select unique ingredients.");
  let total = new Decimal(0),
    cost: Decimal | null = new Decimal(0);
  const values = Object.fromEntries(
    nutrientKeys.map((k) => [k, new Decimal(0)]),
  ) as Record<Nutrient, Decimal | null>;
  const issues: string[] = [];
  const quantities = lines.map((line) => {
    if (
      !Number.isFinite(line.percent) ||
      line.percent < 0 ||
      line.percent > 100
    )
      throw Error("Inclusion must be between 0 and 100.");
    const ingredient = ingredients.find((i) => i.id === line.ingredientId);
    if (!ingredient) throw Error("Ingredient not found in this organization.");
    const fraction = new Decimal(line.percent).div(100);
    total = total.plus(line.percent);
    if (
      line.percent <
        Math.max(line.min ?? 0, Number(ingredient.inclusion_min ?? 0)) - 1e-7 ||
      line.percent >
        Math.min(line.max ?? 100, Number(ingredient.inclusion_max ?? 100)) +
          1e-7
    )
      issues.push(
        `${ingredient.name}: inclusion is outside the specified bounds.`,
      );
    if (
      line.availableKg !== undefined &&
      fraction.mul(batchKg).gt(new Decimal(line.availableKg).plus(1e-7))
    )
      issues.push(
        `${ingredient.name}: batch quantity exceeds available stock.`,
      );
    if (line.percent > 0) {
      if (ingredient.review_status !== "approved")
        issues.push(`${ingredient.name}: nutrient data has not been approved.`);
      if (
        !ingredient.species ||
        ingredient.species === "unknown" ||
        !ingredient.stages?.length ||
        !ingredient.phosphorus_basis ||
        ingredient.phosphorus_basis === "unknown"
      )
        issues.push(
          `${ingredient.name}: species, stage or phosphorus basis is unverified.`,
        );
      if (!ingredient.basis || !ingredient.energy_system)
        issues.push(
          `${ingredient.name}: reference basis or energy system is missing.`,
        );
      if (ingredient.price === null || new Decimal(ingredient.price).lte(0)) {
        cost = null;
        issues.push(
          `${ingredient.name}: a current, reviewed positive price is required.`,
        );
      } else if (cost !== null)
        cost = cost.plus(fraction.mul(ingredient.price));
      for (const k of nutrientKeys) {
        const value = ingredient.nutrients[k];
        if (value === null || value === undefined) {
          values[k] = null;
          issues.push(`${ingredient.name}: ${k} is missing.`);
        } else if (values[k] !== null)
          values[k] = values[k]!.plus(fraction.mul(value));
      }
    }
    return {
      ingredientId: ingredient.id,
      name: ingredient.name,
      percent: line.percent,
      kg: fraction.mul(batchKg).toNumber(),
    };
  });
  if (total.minus(100).abs().gt(0.000001))
    issues.unshift(
      "Ingredient inclusion must total 100%. Results are partial, not a complete feed.",
    );
  const used = ingredients.filter((i) =>
    lines.some((l) => l.ingredientId === i.id && l.percent > 0),
  );
  if (
    new Set(used.map((i) => i.basis)).size > 1 ||
    new Set(used.map((i) => i.energy_system)).size > 1
  )
    issues.push(
      "Ingredients have incompatible nutrient bases or energy systems.",
    );
  const nutrients = Object.fromEntries(
    nutrientKeys.map((k) => [k, values[k]?.toNumber() ?? null]),
  ) as Nutrients;
  return {
    totalPercent: total.toNumber(),
    nutrients,
    costPerKg: cost?.toFixed(4) ?? null,
    batchCost: cost?.mul(batchKg).toFixed(2) ?? null,
    bag25: cost?.mul(25).toFixed(2) ?? null,
    bag50: cost?.mul(50).toFixed(2) ?? null,
    quantities,
    issues,
    releaseEligible: issues.length === 0,
  };
}
export type Limits = Partial<Record<Nutrient, { min?: number; max?: number }>>;
export function compliance(nutrients: Nutrients, limits: Limits) {
  return nutrientKeys
    .filter((k) => limits[k])
    .map((k) => {
      const actual = nutrients[k],
        range = limits[k]!;
      return {
        nutrient: k,
        actual,
        ...range,
        status:
          actual === null
            ? "unknown"
            : (range.min !== undefined && actual < range.min - 1e-7) ||
                (range.max !== undefined && actual > range.max + 1e-7)
              ? "fail"
              : "pass",
      };
    });
}
