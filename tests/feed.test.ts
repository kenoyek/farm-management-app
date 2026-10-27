import { describe, it, expect } from "vitest";
import {
  calculateFormula,
  compliance,
  type Ingredient,
  type FormulaLine,
} from "../src/lib/feed";
import { optimize } from "../src/lib/optimizer";
import source from "../data/ingredients.json";
const ingredients: Ingredient[] = source.map((i) => ({
  ...i,
  review_status: "unverified",
  basis: null,
  energy_system: null,
}));
const recipe = (p: number[]): FormulaLine[] =>
  ["wb-7", "wb-9", "wb-17", "wb-32"].map((id, i) => ({
    ingredientId: id,
    percent: p[i],
  }));
const verified = (id: string, price: number, protein: number): Ingredient => ({
  id,
  name: id,
  source: "Test fixture only; not agricultural guidance",
  price,
  review_status: "approved",
  basis: "as-fed",
  energy_system: "ME",
  nutrients: {
    energy: 3000,
    protein,
    dryMatter: 90,
    calcium: 1,
    phosphorus: 0.5,
    methionine: 0.5,
    lysine: 1,
  },
});
describe("source recipe regression and missing-aware calculations", () => {
  it("reproduces starter energy/protein/cost without accepting missing methionine as zero", () => {
    const r = calculateFormula(recipe([55, 10, 30, 5]), ingredients, 1000);
    expect(r.nutrients.energy).toBe(2957);
    expect(r.nutrients.protein).toBe(21.4);
    expect(r.costPerKg).toBe("291.0000");
    expect(r.bag25).toBe("7275.00");
    expect(r.nutrients.methionine).toBe(null);
    expect(r.nutrients.dryMatter).toBe(null);
    expect(r.releaseEligible).toBe(false);
  });
  it("reproduces finisher and scales bags/batch exactly", () => {
    const r = calculateFormula(recipe([52, 23, 20, 5]), ingredients, 500);
    expect(r.nutrients.energy).toBe(2834.3);
    expect(r.nutrients.protein).toBe(18.61);
    expect(r.costPerKg).toBe("271.9000");
    expect(r.batchCost).toBe("135950.00");
    expect(r.quantities[0].kg).toBe(260);
  });
  it("never normalizes an invalid total or labels it releasable", () => {
    const r = calculateFormula(recipe([40, 10, 30, 5]), ingredients, 100);
    expect(r.totalPercent).toBe(85);
    expect(r.issues[0]).toMatch(/100%/);
    expect(r.releaseEligible).toBe(false);
  });
  it("distinguishes unpriced and unknown nutrient data from zero", () => {
    const r = calculateFormula(
      [{ ingredientId: "wb-8", percent: 100 }],
      ingredients,
      50,
    );
    expect(r.costPerKg).toBe(null);
    const zero = calculateFormula(
      [{ ingredientId: "wb-10", percent: 100 }],
      ingredients,
      50,
    );
    expect(zero.costPerKg).toBe(null);
  });
  it("rejects duplicates, nonfinite values, negative inclusions and zero batches", () => {
    expect(() =>
      calculateFormula(recipe([NaN, 10, 30, 5]), ingredients, 100),
    ).toThrow();
    expect(() =>
      calculateFormula(recipe([-1, 10, 30, 5]), ingredients, 100),
    ).toThrow();
    expect(() =>
      calculateFormula(
        [recipe([55, 10, 30, 5])[0], recipe([55, 10, 30, 5])[0]],
        ingredients,
        100,
      ),
    ).toThrow();
    expect(() =>
      calculateFormula(recipe([55, 10, 30, 5]), ingredients, 0),
    ).toThrow();
  });
  it("reports pass/fail/unknown separately with explicit bounds", () => {
    const r = calculateFormula(recipe([55, 10, 30, 5]), ingredients, 100);
    expect(
      compliance(r.nutrients, {
        protein: { min: 21, max: 23 },
        calcium: { min: 1 },
        methionine: { min: 0.34 },
      }).map((c) => c.status),
    ).toEqual(["pass", "fail", "unknown"]);
  });
});
describe("real SciPy HiGHS optimization", () => {
  const selected = [verified("a", 100, 10), verified("b", 300, 50)];
  it("finds a known optimum and independently validates constraints", async () => {
    const r = await optimize(
      selected,
      [
        { ingredientId: "a", percent: 50 },
        { ingredientId: "b", percent: 50 },
      ],
      { protein: { min: 20 } },
      1000,
    );
    expect(r.status).toBe("optimal");
    if ("lines" in r) {
      expect(r.lines[0].percent).toBeCloseTo(75);
      expect(r.calculation.costPerKg).toBe("150.0000");
    }
  });
  it("respects bounds and fixed inclusions", async () => {
    const r = await optimize(
      selected,
      [
        { ingredientId: "a", percent: 50, max: 50 },
        { ingredientId: "b", percent: 50, min: 50, max: 50 },
      ],
      { protein: { min: 20 } },
      100,
    );
    expect(r.status).toBe("optimal");
    if ("lines" in r) expect(r.lines[0].percent).toBeCloseTo(50);
  });
  it("cannot relax reviewed inclusion limits or available stock", async () => {
    const limited = selected.map((i) => ({ ...i, inclusion_max: 50 }));
    const fixed = await optimize(
      limited,
      [
        { ingredientId: "a", percent: 50, max: 100 },
        { ingredientId: "b", percent: 50, max: 100 },
      ],
      { protein: { min: 20 } },
      100,
    );
    expect(fixed.status).toBe("optimal");
    if ("lines" in fixed) expect(fixed.lines[0].percent).toBeCloseTo(50);
    const unavailable = await optimize(
      selected,
      [
        { ingredientId: "a", percent: 50, availableKg: 10 },
        { ingredientId: "b", percent: 50, availableKg: 10 },
      ],
      { protein: { min: 20 } },
      100,
    );
    expect(unavailable.status).toBe("infeasible");
  });
  it("reports infeasible without inventing a result", async () => {
    const r = await optimize(
      selected,
      [
        { ingredientId: "a", percent: 50, max: 20 },
        { ingredientId: "b", percent: 50, max: 20 },
      ],
      { protein: { min: 20 } },
      100,
    );
    expect(r.status).toBe("infeasible");
    expect(r.fractions).toBe(null);
  });
  it("rejects unreviewed workbook data", async () => {
    await expect(
      optimize(
        ingredients,
        recipe([55, 10, 30, 5]),
        { protein: { min: 20 } },
        100,
      ),
    ).rejects.toThrow(/reviewed/);
  });
});
