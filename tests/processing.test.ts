import { it, expect } from "vitest";
import {
  processingRules,
  processingRuleIssues,
  processingCompliance,
  type ProcessingRule,
} from "../src/lib/processing";
import { optimize } from "../src/lib/optimizer";
import type { Ingredient } from "../src/lib/feed";
const source =
  "Synthetic processing constraint evidence; not agricultural guidance";
const reference = (id: string, price: number, protein: number): Ingredient => ({
  id,
  name: id,
  source,
  price,
  review_status: "approved",
  basis: "as-fed",
  energy_system: "ME",
  species: "poultry",
  stages: ["starter"],
  phosphorus_basis: "total",
  processing_method: "heat-treated",
  processing_evidence: source,
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
const A = "11111111-1111-4111-8111-111111111111",
  B = "22222222-2222-4222-8222-222222222222";
const ingredients = [reference(A, 100, 10), reference(B, 300, 50)];
const allowed = ingredients.map((i) => ({
  ingredientId: i.id,
  min: 0,
  max: 100,
  source,
}));
const group = (ids = [A], minPercent = 0, maxPercent = 60): ProcessingRule => ({
  name: "Synthetic processed group",
  ingredientIds: ids,
  minPercent,
  maxPercent,
  requiredMethod: "heat-treated",
  source,
});
const lines = [
  { ingredientId: A, percent: 75 },
  { ingredientId: B, percent: 25 },
];
it("requires explicit valid group bounds, identities, evidence and unique names", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const valid = { ...group([id]), name: "Reviewed group" };
  expect(processingRules.safeParse([valid]).success).toBe(true);
  for (const invalid of [
    { ...valid, maxPercent: -1 },
    { ...valid, minPercent: 80 },
    { ...valid, ingredientIds: [id, id] },
    { ...valid, ingredientIds: [] },
    { ...valid, requiredMethod: "steamed at 80" },
    { ...valid, source: "none" },
    { ...valid, override: true },
  ])
    expect(processingRules.safeParse([invalid]).success).toBe(false);
  expect(processingRules.safeParse([valid, valid]).success).toBe(false);
});
it("does not infer processing from notes or permit unknown methods and unlisted reference revisions", () => {
  expect(processingRuleIssues([group()], ingredients, []).join(" ")).toMatch(
    /closed ingredient allowed list/,
  );
  const unknown = ingredients.map((i) => ({
    ...i,
    processing_method: null,
    processing_evidence: null,
    processing_notes: "heat-treated",
  }));
  expect(processingRuleIssues([group()], unknown, [A, B]).join(" ")).toMatch(
    /requires recorded/,
  );
  expect(
    processingRuleIssues(
      [group(["33333333-3333-4333-8333-333333333333"])],
      ingredients,
      [A, B],
    ).join(" "),
  ).toMatch(/exact ingredient allowed list/);
  expect(processingCompliance(lines, [group()])[0]).toMatchObject({
    actualPercent: 75,
    status: "fail",
  });
});
it("enforces processing limits in genuine HiGHS and independently recomputes group totals", async () => {
  const result = await optimize(
    ingredients,
    lines,
    { protein: { min: 20 } },
    100,
    allowed,
    [group()],
  );
  expect(result.status).toBe("optimal");
  if (result.status === "optimal") {
    expect(result.lines[0].percent).toBeCloseTo(60);
    expect(result.calculation.costPerKg).toBe("180.0000");
    expect(result.processingGroups?.[0]).toMatchObject({
      actualPercent: 60,
      status: "pass",
      maxPercent: 60,
    });
    expect(result.bindingConstraints).toContain(
      "Synthetic processed group processing maximum",
    );
  }
});
it("keeps stock-derived limits and processing minima hard and produces no invented allocation", async () => {
  const result = await optimize(
    ingredients,
    [{ ...lines[0], availableKg: 50 }, lines[1]],
    { protein: { min: 20 } },
    100,
    allowed,
    [group([A], 60, 80)],
  );
  expect(result.status).toBe("infeasible");
  expect(result.fractions).toBeNull();
  expect(result.processingGroups?.[0]).toMatchObject({
    actualPercent: null,
    status: "not-solved",
    attainableMax: 50,
  });
});
it("solves combined group conflicts with unchanged constraints rather than assuming individual ranges prove feasibility", async () => {
  const groups = [
    { ...group([A], 0, 40), name: "Group A" },
    { ...group([B], 0, 40), name: "Group B" },
  ];
  const result = await optimize(
    ingredients,
    lines,
    { protein: { min: 20 } },
    100,
    allowed,
    groups,
  );
  expect(result.status).toBe("infeasible");
  expect(result.fractions).toBeNull();
  expect(result.solver).toContain("HiGHS");
});
