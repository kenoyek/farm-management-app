import { it, expect } from "vitest";
import { optimize } from "../src/lib/optimizer";
import { outcomeView } from "../src/lib/optimization-history";
import {
  workerConflict,
  describeConflict,
} from "../src/lib/optimization-conflict";
import type { Ingredient } from "../src/lib/feed";
const ingredient = (
  id: string,
  protein: number,
  energy = 3000,
): Ingredient => ({
  id,
  name: "Synthetic " + id,
  source: "Synthetic evidence only",
  price: id === "a" ? 100 : 300,
  review_status: "approved",
  basis: "as-fed",
  energy_system: "ME",
  species: "poultry",
  stages: ["starter"],
  phosphorus_basis: "total",
  nutrients: {
    energy,
    protein,
    dryMatter: 90,
    calcium: 1,
    phosphorus: 0.5,
    methionine: 0.5,
    lysine: 1,
  },
});
const lines = [
  { ingredientId: "a", percent: 50 },
  { ingredientId: "b", percent: 50 },
];
it("names stock and nutrient conflict members with exact source limits and no replacement allocation", async () => {
  const input = [lines[0], { ...lines[1], availableKg: 10 }],
    before = structuredClone(input);
  const r = await optimize(
    [ingredient("a", 10), ingredient("b", 50)],
    input,
    { protein: { min: 20 } },
    100,
  );
  expect(r).toMatchObject({
    status: "infeasible",
    fractions: null,
    objective: null,
    diagnosticModelVersion: 3,
    conflict: {
      status: "irreducible",
      termination: "complete",
      candidateCount: 2,
      checks: 3,
    },
  });
  expect(r.conflict?.constraints).toEqual([
    expect.objectContaining({
      kind: "bound",
      ingredientId: "b",
      value: 10,
      side: "max",
      origins: [{ source: "availability", percent: 10 }],
    }),
    expect.objectContaining({
      kind: "nutrient",
      label: "Crude protein (%)",
      value: 20,
      unit: "%",
      side: "min",
    }),
  ]);
  expect(input).toEqual(before);
  expect(r).not.toHaveProperty("lines");
  expect(outcomeView(r)?.conflict).toEqual(r.conflict);
});
it("explains coupled energy/protein conflicts even though each individual reachable range passes", async () => {
  const r = await optimize(
    [ingredient("a", 30, 1000), ingredient("b", 10, 3000)],
    lines,
    { protein: { min: 25 }, energy: { min: 2500 } },
    100,
  );
  expect(r.conflict?.status).toBe("irreducible");
  expect(
    r.conflict?.constraints.map((c) => [c.label, c.value, c.unit]),
  ).toEqual([
    ["Energy (kcal/kg)", 2500, "kcal/kg"],
    ["Crude protein (%)", 25, "%"],
  ]);
  expect(r.reachability).toHaveLength(2);
  expect(r.conflict?.constraints.every((c) => c.kind === "nutrient")).toBe(
    true,
  );
});
it("keeps numerical optima unchanged and does not retrofit conflict metadata into legacy history", async () => {
  const r = await optimize(
    [ingredient("a", 10), ingredient("b", 50)],
    lines,
    { protein: { min: 20 } },
    100,
  );
  expect(r.status).toBe("optimal");
  expect(r.conflict).toBeNull();
  if (r.status === "optimal") expect(r.calculation.costPerKg).toBe("150.0000");
  expect(
    outcomeView({
      status: "infeasible",
      solver: "Legacy",
      message: "No solution",
    })?.conflict,
  ).toBeUndefined();
});
it("rejects duplicate, inconsistent or foreign-index worker conflict evidence", () => {
  const valid = {
    version: 1 as const,
    status: "irreducible" as const,
    termination: "complete" as const,
    members: [{ kind: "row" as const, index: 0, side: "min" as const }],
    checks: 2,
    maxChecks: 48 as const,
    candidateCount: 1,
    tolerance: 1e-7 as const,
  };
  expect(workerConflict.safeParse(valid).success).toBe(true);
  for (const value of [
    { ...valid, members: [valid.members[0], valid.members[0]] },
    { ...valid, termination: "check-budget" },
    { ...valid, checks: 49 },
    { ...valid, members: [] },
  ])
    expect(workerConflict.safeParse(value).success).toBe(false);
  expect(() => describeConflict(valid, [], [])).toThrow(
    "Invalid conflict constraint",
  );
});
