import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  profileRuleIssues,
  applyProfileBounds,
  type IngredientRule,
} from "../src/lib/profile-rules";
import { profileInput } from "../src/lib/profile-api";
import { optimize } from "../src/lib/optimizer";
import type { Ingredient } from "../src/lib/feed";

const ingredient = (id: string, price: number): Ingredient => ({
  id,
  name: id,
  source: "Test fixture only, not agricultural guidance",
  review_status: "approved",
  price,
  species: "poultry",
  stages: ["starter"],
  basis: "as-fed",
  energy_system: "ME",
  phosphorus_basis: "total",
  nutrients: {
    energy: 3000,
    protein: 20,
    dryMatter: 90,
    calcium: 1,
    phosphorus: 0.5,
    methionine: 0.5,
    lysine: 1,
  },
});
const ingredients = [
  ingredient("a", 100),
  ingredient("b", 300),
  ingredient("c", 1),
];
const rule = (ingredientId: string, min = 0, max = 100): IngredientRule => ({
  ingredientId,
  min,
  max,
  source: "Test-only qualified review evidence",
});

it("checks mandatory omitted/zero ingredients, maximums, exclusions and exact revisions", () => {
  const rules = [rule("a", 10, 50), rule("b", 20), rule("c", 0, 0)];
  expect(
    profileRuleIssues(
      [{ ingredientId: "a", percent: 100 }],
      ingredients,
      rules,
    ),
  ).toEqual([
    expect.stringContaining("a: profile requires 10–50%"),
    expect.stringContaining("b: profile requires 20–100%"),
  ]);
  expect(
    profileRuleIssues(
      [
        { ingredientId: "a", percent: 40 },
        { ingredientId: "b", percent: 50 },
        { ingredientId: "c", percent: 10 },
      ],
      ingredients,
      rules,
    ),
  ).toEqual([expect.stringContaining("c: profile requires 0–0%")]);
  expect(
    profileRuleIssues([{ ingredientId: "new-a", percent: 100 }], ingredients, [
      rule("a"),
    ]),
  ).toEqual([expect.stringContaining("not allowed")]);
  expect(
    profileRuleIssues([{ ingredientId: "a", percent: 0 }], ingredients, [
      rule("a", 10),
    ]),
  ).toHaveLength(1);
});
it("keeps legacy profiles open and intersects scenario rules without relaxing them", () => {
  const lines = [{ ingredientId: "a", percent: 50, min: 20, max: 80 }];
  expect(applyProfileBounds(lines, [])).toEqual(lines);
  expect(profileRuleIssues(lines, ingredients, [])).toEqual([]);
  expect(applyProfileBounds(lines, [rule("a", 10, 50)])[0]).toMatchObject({
    min: 20,
    max: 50,
  });
  expect(() => applyProfileBounds(lines, [rule("b", 1)])).toThrow(/required/);
  expect(() => applyProfileBounds(lines, [rule("b")])).toThrow(/not allowed/);
});
it("uses real HiGHS with mandatory, capped, fixed and excluded ingredient rules", async () => {
  const result = await optimize(
    ingredients,
    ingredients.map((i) => ({ ingredientId: i.id, percent: 0 })),
    { protein: { min: 20 } },
    100,
    [rule("a", 0, 60), rule("b", 40, 40), rule("c", 0, 0)],
  );
  expect(result.status).toBe("optimal");
  if ("lines" in result) {
    expect(result.lines.map((l) => l.percent)).toEqual([60, 40, 0]);
    expect(result.calculation.costPerKg).toBe("180.0000");
    expect(result.calculation.releaseEligible).toBe(true);
  }
});
it("never relaxes profile rules to satisfy stock or scenario conflicts", async () => {
  const ingredientCapped = await optimize(
    ingredients.map((i) => (i.id === "a" ? { ...i, inclusion_max: 30 } : i)),
    [
      { ingredientId: "a", percent: 50 },
      { ingredientId: "b", percent: 50 },
    ],
    { protein: { min: 20 } },
    100,
    [rule("a", 0, 60), rule("b", 40)],
  );
  expect(ingredientCapped.status).toBe("optimal");
  if ("lines" in ingredientCapped)
    expect(ingredientCapped.lines[0].percent).toBeCloseTo(30);
  const lines = [
    { ingredientId: "a", percent: 50 },
    { ingredientId: "b", percent: 50, availableKg: 10 },
  ];
  expect(
    (
      await optimize(ingredients, lines, { protein: { min: 20 } }, 100, [
        rule("a"),
        rule("b", 20),
      ])
    ).status,
  ).toBe("infeasible");
  expect(
    (
      await optimize(
        ingredients,
        [{ ...lines[0], min: 90 }, lines[1]],
        { protein: { min: 20 } },
        100,
        [rule("a", 0, 50), rule("b")],
      )
    ).status,
  ).toBe("infeasible");
  await expect(
    optimize(ingredients, [lines[0]], { protein: { min: 20 } }, 100, [
      rule("a"),
      rule("b", 1),
    ]),
  ).rejects.toThrow(/required/);
  await expect(
    optimize(ingredients, [lines[0]], { protein: { min: 20 } }, 100, [
      rule("b"),
    ]),
  ).rejects.toThrow(/not allowed/);
});
it("rejects duplicate, ambiguous, inverted and undocumented review rules", () => {
  const ingredientId = randomUUID();
  const input = {
    organizationId: randomUUID(),
    name: "Test profile",
    species: "poultry",
    stage: "starter",
    source: "Fixture source evidence",
    basis: "as-fed",
    energySystem: "ME",
    phosphorusBasis: "total",
    limits: {},
    ingredientRules: [rule(ingredientId)],
  };
  expect(profileInput.parse(input).ingredientRules).toHaveLength(1);
  for (const ingredientRules of [
    [rule(ingredientId), rule(ingredientId)],
    [rule(ingredientId, 80, 50)],
    [{ ...rule(ingredientId), source: "" }],
    [{ ...rule(ingredientId), min: null }],
    [{ ...rule(ingredientId), alias: "guess" }],
    [rule("not-uuid")],
  ])
    expect(profileInput.safeParse({ ...input, ingredientRules }).success).toBe(
      false,
    );
});
