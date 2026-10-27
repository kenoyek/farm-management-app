import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { diagnoseConstraints } from "../src/lib/optimization-diagnostics";
import { optimize } from "../src/lib/optimizer";
import {
  historicalDraft,
  outcomeView,
  hasReferenceSnapshots,
} from "../src/lib/optimization-history";
import type { Ingredient } from "../src/lib/feed";

const ingredient = (
  id: string,
  protein: number,
  price: number,
): Ingredient => ({
  id,
  name: id,
  source: "Synthetic test evidence, not agricultural guidance",
  price,
  review_status: "approved",
  basis: "as-fed",
  energy_system: "ME",
  species: "poultry",
  stages: ["starter"],
  phosphorus_basis: "total",
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
const ingredients = [ingredient("a", 10, 100), ingredient("b", 50, 300)];
const lines = [
  { ingredientId: "a", percent: 50 },
  { ingredientId: "b", percent: 50 },
];
it("intersects and retains scenario, ingredient, profile and stock bound sources", () => {
  const bounded = ingredients.map((i) => ({
    ...i,
    inclusion_min: 10,
    inclusion_max: 80,
  }));
  const result = diagnoseConstraints(
    bounded,
    [{ ...lines[0], min: 20, max: 90, availableKg: 30 }, lines[1]],
    { protein: { min: 20 } },
    100,
    [
      { ingredientId: "a", min: 15, max: 70, source: "Test evidence" },
      { ingredientId: "b", min: 0, max: 100, source: "Test evidence" },
    ],
  );
  expect(result.effectiveBounds[0]).toMatchObject({ min: 20, max: 30 });
  expect(result.effectiveBounds[0].maximumSources.map((s) => s.source)).toEqual(
    ["scenario", "ingredient", "profile", "availability"],
  );
  expect(result.diagnostics).toEqual([]);
});
it("identifies named bound conflicts without changing or relaxing any inputs", () => {
  const input = [{ ...lines[0], min: 60, availableKg: 10 }, lines[1]],
    original = structuredClone(input);
  const result = diagnoseConstraints(
    ingredients,
    input,
    { protein: { min: 20 } },
    100,
  );
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({
      kind: "ingredient-bounds",
      ingredientId: "a",
      message: expect.stringContaining("minimum 60% exceeds maximum 10%"),
    }),
  );
  expect(result.reachability).toEqual([]);
  expect(input).toEqual(original);
});
it("explains minimum totals and capacity shortfalls against the full batch", () => {
  expect(
    diagnoseConstraints(
      ingredients,
      lines.map((l) => ({ ...l, min: 60 })),
      {},
      100,
    ).diagnostics[0],
  ).toMatchObject({
    kind: "minimum-total",
    message: expect.stringContaining("120%"),
  });
  expect(
    diagnoseConstraints(
      ingredients,
      lines.map((l) => ({ ...l, availableKg: 20 })),
      {},
      100,
    ).diagnostics[0],
  ).toMatchObject({
    kind: "maximum-total",
    message: expect.stringContaining("60.000000 percentage-point shortfall"),
  });
});
it("calculates attainable extrema using mass balance rather than independent ingredient maxima", () => {
  const input = [
    { ...lines[0], min: 20, max: 80 },
    { ...lines[1], min: 10, max: 70 },
  ];
  const result = diagnoseConstraints(
    ingredients,
    input,
    { protein: { min: 40, max: 45 } },
    100,
  );
  expect(result.reachability[0].attainableMin).toBeCloseTo(18, 7);
  expect(result.reachability[0].attainableMax).toBeCloseTo(38, 7);
  expect(result.diagnostics[0].kind).toBe("nutrient-minimum");
  expect(
    diagnoseConstraints(ingredients, input, { protein: { max: 15 } }, 100)
      .diagnostics[0].kind,
  ).toBe("nutrient-maximum");
});
it("keeps fixed inclusions fixed and scales available-kg bounds by the actual batch", () => {
  const fixed = diagnoseConstraints(
    ingredients,
    [
      { ...lines[0], min: 25, max: 25 },
      { ...lines[1], min: 75, max: 75 },
    ],
    { protein: { min: 40 } },
    100,
  );
  expect(fixed.reachability[0]).toMatchObject({
    attainableMin: 40,
    attainableMax: 40,
  });
  expect(fixed.diagnostics).toEqual([]);
  const stock = [{ ...lines[0] }, { ...lines[1], availableKg: 10 }];
  expect(
    diagnoseConstraints(ingredients, stock, { protein: { min: 20 } }, 100)
      .reachability[0].attainableMax,
  ).toBe(14);
  expect(
    diagnoseConstraints(ingredients, stock, { protein: { min: 20 } }, 25)
      .reachability[0].attainableMax,
  ).toBe(26);
});
it("refuses missing nutrients, nonfinite/negative bounds and duplicate candidates", () => {
  expect(() =>
    diagnoseConstraints(
      [
        {
          ...ingredients[0],
          nutrients: { ...ingredients[0].nutrients, protein: null },
        },
        ingredients[1],
      ],
      lines,
      { protein: { min: 20 } },
      100,
    ),
  ).toThrow(/missing/);
  expect(() =>
    diagnoseConstraints(
      ingredients,
      [{ ...lines[0], availableKg: -1 }, lines[1]],
      {},
      100,
    ),
  ).toThrow(/Availability/);
  expect(() =>
    diagnoseConstraints(
      ingredients,
      [{ ...lines[0], max: NaN }, lines[1]],
      {},
      100,
    ),
  ).toThrow(/finite/);
  expect(() =>
    diagnoseConstraints(ingredients, [lines[0], lines[0]], {}, 100),
  ).toThrow(/unique/);
});
it("uses HiGHS for jointly infeasible nutrient constraints whose individual ranges pass", async () => {
  const selected = [ingredient("a", 30, 100), ingredient("b", 10, 300)];
  selected[0].nutrients.energy = 1000;
  selected[1].nutrients.energy = 3000;
  const result = await optimize(
    selected,
    lines,
    { protein: { min: 25 }, energy: { min: 2500 } },
    100,
  );
  expect(result.status).toBe("infeasible");
  expect(result.solver).toContain("HiGHS");
  expect(result.diagnostics[0].kind).toBe("combined-constraints");
  expect(result.fractions).toBeNull();
});
it("reports a real optimum with independently recomputed primal and objective residuals", async () => {
  const result = await optimize(
    ingredients,
    lines,
    { protein: { min: 20 } },
    100,
  );
  expect(result.status).toBe("optimal");
  if (result.status === "optimal") {
    expect(result.objective).toBeCloseTo(150);
    expect(result.calculation.costPerKg).toBe("150.0000");
    expect(result.validation.totalPercentError).toBeLessThan(1e-6);
    expect(result.validation.maximumBoundViolationPercent).toBeLessThan(1e-6);
    expect(result.validation.objectiveError).toBeLessThan(
      result.validation.objectiveTolerance,
    );
    expect(result.bindingConstraints).toContain("protein minimum");
  }
});
it("restores solved percentages with original scenario bounds and no approval/result fields", () => {
  const a = randomUUID(),
    b = randomUUID(),
    profileId = randomUUID();
  const input = {
    name: "Historical scenario",
    batchKg: 100,
    profileId,
    lines: [
      { ingredientId: a, percent: 50, max: 100, availableKg: 90 },
      { ingredientId: b, percent: 50 },
    ],
    status: "approved",
  };
  const result = {
    status: "optimal",
    lines: [
      { ingredientId: a, percent: 75, max: 75 },
      { ingredientId: b, percent: 25 },
    ],
    releaseEligible: true,
  };
  const draft = historicalDraft(input, result)!;
  expect(draft.allocationSource).toBe("saved solution");
  expect(draft.content.lines[0]).toMatchObject({
    percent: 75,
    max: 100,
    availableKg: 90,
  });
  expect(draft.content).not.toHaveProperty("status");
  expect(draft.content).not.toHaveProperty("result");
  expect(
    historicalDraft(input, { status: "infeasible", fractions: null })!
      .allocationSource,
  ).toBe("original inputs");
  expect(
    historicalDraft(input, {
      status: "optimal",
      lines: [
        { ingredientId: a, percent: 100 },
        { ingredientId: a, percent: 0 },
      ],
    })!.allocationSource,
  ).toBe("original inputs");
  expect(historicalDraft({}, result)).toBeNull();
});
it("reads legacy outcomes without manufacturing absent diagnostic or reference evidence", () => {
  const legacy = outcomeView({
    status: "infeasible",
    solver: "Old solver",
    message: "No solution",
  })!;
  expect(legacy.effectiveBounds).toEqual([]);
  expect(legacy.validation).toBeUndefined();
  expect(legacy.costPerKg).toBeNull();
  expect(outcomeView({ status: "optimal", diagnostics: "invalid" })).toBeNull();
  expect(hasReferenceSnapshots({ name: "Missing snapshot" })).toBe(false);
});
