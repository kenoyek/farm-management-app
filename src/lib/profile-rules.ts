import type { FormulaLine, Ingredient, Limits } from "./feed";

export type IngredientRule = {
  ingredientId: string;
  min: number;
  max: number;
  source: string;
};
export type RequirementProfile = {
  id: string;
  parent_id: string | null;
  revision: number;
  name: string;
  species: string;
  stage: string;
  source: string;
  basis: string;
  energy_system: string;
  phosphorus_basis: string;
  limits: Limits;
  ingredient_rules: IngredientRule[];
  reviewer_id: string;
  created_at: string;
};

// A nonempty reviewed list is closed: a different quotation/revision must be
// explicitly reviewed in a new profile, never substituted by name or lineage.
export function profileRuleIssues(
  lines: FormulaLine[],
  ingredients: Ingredient[],
  rules: IngredientRule[],
) {
  if (!rules.length) return [];
  const name = (id: string) => ingredients.find((i) => i.id === id)?.name ?? id;
  return [
    ...lines
      .filter(
        (l) =>
          l.percent > 0 &&
          !rules.some((r) => r.ingredientId === l.ingredientId),
      )
      .map(
        (l) =>
          `${name(l.ingredientId)}: this reference is not allowed by the selected profile.`,
      ),
    ...rules.flatMap((r) => {
      const percent =
        lines.find((l) => l.ingredientId === r.ingredientId)?.percent ?? 0;
      return percent < r.min - 1e-7 || percent > r.max + 1e-7
        ? [
            `${name(r.ingredientId)}: profile requires ${r.min}–${r.max}% inclusion (actual ${percent}%).`,
          ]
        : [];
    }),
  ];
}

export function applyProfileBounds(
  lines: FormulaLine[],
  rules: IngredientRule[],
) {
  if (!rules.length) return lines;
  const missing = rules.filter(
    (r) => r.min > 0 && !lines.some((l) => l.ingredientId === r.ingredientId),
  );
  if (missing.length)
    throw Error(
      "Add every required ingredient reference from the selected profile before optimizing.",
    );
  return lines.map((line) => {
    const rule = rules.find((r) => r.ingredientId === line.ingredientId);
    if (!rule)
      throw Error(
        "A selected ingredient reference is not allowed by the profile. Use the exact reviewed revision.",
      );
    return {
      ...line,
      min: Math.max(line.min ?? 0, rule.min),
      max: Math.min(line.max ?? 100, rule.max),
    };
  });
}
