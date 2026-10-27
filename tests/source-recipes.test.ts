import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { workbookCatalog } from "../src/lib/workbook-catalog";
import {
  sourceRecipePlan,
  sourceRecipeCalculation,
  type SourceRecipeRow,
} from "../src/lib/source-recipes";
import type { Ingredient } from "../src/lib/feed";

function fixture() {
  const ingredients: Ingredient[] = [];
  const rows: SourceRecipeRow[] = workbookCatalog()
    .filter((r) => r.category === "recipe" && r.sheet === "Broiler Starter")
    .map((row) => {
      const id = randomUUID();
      const positive = (row.fields.inclusion.parsed.value ?? 0) > 0;
      const ingredientId = randomUUID();
      if (positive)
        ingredients.push({
          id: ingredientId,
          name: row.label,
          source: "Synthetic mapped reference only",
          price: 100,
          nutrients: {
            energy: 3000,
            protein: 20,
            dryMatter: null,
            calcium: 1,
            phosphorus: 0.5,
            methionine: null,
            lysine: 1,
          },
          review_status: "unverified",
          basis: null,
          energy_system: null,
        });
      return {
        ...structuredClone(row),
        id,
        alias_review: positive
          ? {
              id: randomUUID(),
              source_row_id: id,
              ingredient_id: ingredientId,
              decision: "mapped",
              revision: 1,
              parent_id: null,
              evidence: "Synthetic identity review only",
              reviewer_id: randomUUID(),
              created_at: new Date().toISOString(),
            }
          : null,
      };
    });
  return { rows, ingredients };
}
it("imports only the four specified percentages without interpreting thirty blanks as zero", () => {
  const { rows, ingredients } = fixture();
  const plan = sourceRecipePlan(rows, ingredients);
  expect(plan.blockers).toEqual([]);
  expect(plan.unspecifiedCount).toBe(30);
  expect(plan.lines.map((l) => l.percent)).toEqual([55, 10, 30, 5]);
  expect(plan.totalPercent).toBe(100);
  expect(
    rows.filter((r) => r.fields.inclusion.parsed.kind === "missing"),
  ).toHaveLength(30);
  const result = sourceRecipeCalculation(plan, ingredients, 1000)!;
  expect(result.releaseEligible).toBe(false);
  expect(result.nutrients.methionine).toBeNull();
  expect(result.quantities.map((q) => q.kg)).toEqual([550, 100, 300, 50]);
});
it("requires explicit mapping decisions even when names match and refuses merging duplicate targets", () => {
  const { rows, ingredients } = fixture();
  const positive = rows.filter((r) => r.alias_review);
  positive[0].alias_review = null;
  expect(sourceRecipePlan(rows, ingredients).blockers.join(" ")).toMatch(
    /explicit mapped/,
  );
  const other = fixture();
  const mapped = other.rows.filter((r) => r.alias_review);
  mapped[1].alias_review!.ingredient_id = mapped[0].alias_review!.ingredient_id;
  expect(
    sourceRecipePlan(other.rows, other.ingredients).blockers.join(" "),
  ).toMatch(/not merged/);
});
it("does not normalize incomplete totals or infer values from ranges and rejects unresolved/rejected aliases", () => {
  const { rows, ingredients } = fixture();
  rows.find(
    (r) => r.fields.inclusion.parsed.value === 55,
  )!.fields.inclusion.parsed.value = 54;
  const plan = sourceRecipePlan(rows, ingredients);
  expect(plan.totalPercent).toBe(99);
  expect(plan.blockers.join(" ")).toMatch(/never normalized/);
  expect(sourceRecipeCalculation(plan, ingredients, 100)).toBeNull();
  const f = fixture();
  f.rows.find((r) => r.alias_review)!.alias_review!.decision = "rejected";
  expect(
    sourceRecipePlan(f.rows, f.ingredients).blockers.length,
  ).toBeGreaterThan(0);
  f.rows[0].fields.inclusion.parsed = { kind: "range", min: 50, max: 60 };
  expect(sourceRecipePlan(f.rows, f.ingredients).blockers.join(" ")).toMatch(
    /needs interpretation/,
  );
});
