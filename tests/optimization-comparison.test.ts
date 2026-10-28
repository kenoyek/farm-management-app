import { it, expect } from "vitest";
import {
  compareOptimizationRuns,
  optimizationComparisonSheets,
  type RunRecord,
} from "../src/lib/optimization-comparison";
import { nutrientDefinitions } from "../src/lib/nutrients";
import { sheetsCsv } from "../src/lib/recipe-reports";
const a = "00000000-0000-4000-8000-000000000001",
  b = "00000000-0000-4000-8000-000000000002",
  p = "00000000-0000-4000-8000-000000000003";
export function fixture(id = "run-a", percent = 75, batchKg = 100): RunRecord {
  const lines = [
      { ingredientId: a, percent: 50 },
      { ingredientId: b, percent: 50, availableKg: 100 },
    ],
    cost = (percent / 100) * 100 + (1 - percent / 100) * 300;
  return {
    id,
    created_at: "2026-10-28T00:00:00Z",
    request: {
      name: "=Synthetic scenario",
      batchKg,
      profileId: p,
      lines,
      modelVersion: 5,
      nutrientDefinitions,
      profileSnapshot: {
        id: p,
        name: "Synthetic profile",
        revision: 1,
        species: "poultry",
        stage: "starter",
        basis: "as-fed",
        energy_system: "ME",
        phosphorus_basis: "total",
        source: "Synthetic evidence only",
        limits: { protein: { min: 20 } },
        ingredient_rules: [],
        processing_rules: [],
      },
      ingredientSnapshot: [
        {
          id: a,
          name: "=Synthetic A",
          price: "100.0000",
          source: "Synthetic evidence only",
          revision: 1,
        },
        {
          id: b,
          name: "Synthetic B",
          price: "300.0000",
          source: "Synthetic evidence only",
          revision: 1,
        },
      ],
    },
    result: {
      status: "optimal",
      solver: "Synthetic fixture evidence, no solve performed",
      message: "Fixture for historical normalization",
      objective: cost,
      lines: [
        { ingredientId: a, percent },
        { ingredientId: b, percent: 100 - percent },
      ],
      calculation: {
        costPerKg: cost.toFixed(4),
        nutrients: {
          protein: (10 * percent) / 100 + 50 * (1 - percent / 100),
          ash: 0,
          moisture: null,
        },
      },
    },
  };
}
function request(r: RunRecord) {
  return r.request as ReturnType<typeof JSON.parse>;
}
function result(r: RunRecord) {
  return r.result as ReturnType<typeof JSON.parse>;
}
it("scales different original batches at exact historical costs and reverses the explicit baseline", () => {
  const a = fixture(),
    b = fixture("run-b", 60, 500),
    c = compareOptimizationRuns([a, b], 1000);
  expect(
    c.runs.map((r) => [
      r.costPerKg,
      r.batchCost,
      r.deltaCostPerKg,
      r.deltaBatchCost,
    ]),
  ).toEqual([
    ["150.0000", "150000.0000", "0.0000", "0.0000"],
    ["180.0000", "180000.0000", "30.0000", "30000.0000"],
  ]);
  expect(c.runs[1].allocations[0]).toMatchObject({
    originalKg: "300.000000",
    planningKg: "600.000000",
    deltaPercent: -15,
  });
  expect(compareOptimizationRuns([b, a], 1000).runs[1].deltaBatchCost).toBe(
    "-30000.0000",
  );
  expect(c.nutrients.find((n) => n.key === "ash")!.values[1]).toMatchObject({
    actual: 0,
    delta: 0,
    check: "unassessed",
  });
  expect(
    c.nutrients.find((n) => n.key === "moisture")!.values[1],
  ).toMatchObject({ actual: null, delta: null });
  expect(c.notice).toContain("does not re-solve stock");
});
it("withholds nutrient deltas across different or unknown contexts and absent/mismatched definitions while retaining each own limits", () => {
  const a = fixture(),
    b = fixture("b", 50);
  request(b).profileSnapshot.stage = "grower";
  request(b).profileSnapshot.limits.protein = { min: 35 };
  let c = compareOptimizationRuns([a, b], 100);
  expect(c.nutrients[0].values[1]).toMatchObject({
    actual: 30,
    delta: null,
    check: "fail",
  });
  request(b).profileSnapshot.stage = "starter";
  delete request(b).nutrientDefinitions;
  c = compareOptimizationRuns([a, b], 100);
  expect(c.nutrients[0].values[1].deltaReason).toContain("definitions");
  request(b).nutrientDefinitions = nutrientDefinitions.map((d) =>
    d.key === "protein" ? { ...d, unit: "g/kg" } : d,
  );
  expect(
    compareOptimizationRuns([a, b], 100).nutrients[0].values[1].delta,
  ).toBeNull();
});
it("shows infeasible and legacy runs without costs, solution quantities or invented zero nutrient values", () => {
  const a = fixture(),
    b = fixture("b");
  b.result = {
    status: "infeasible",
    solver: "Synthetic no solve",
    message: "Fixture failure",
    fractions: null,
    objective: null,
  };
  let c = compareOptimizationRuns([a, b], 100);
  expect(c.runs[1]).toMatchObject({
    status: "infeasible",
    costPerKg: null,
    batchCost: null,
    deltaCostPerKg: null,
  });
  expect(
    c.runs[1].allocations.every(
      (a) => a.percent === null && a.planningKg === null,
    ),
  ).toBe(true);
  a.result = b.result;
  c = compareOptimizationRuns([a, b], 100);
  expect(c.nutrients.find((n) => n.key === "protein")?.values[0]).toMatchObject(
    { actual: null, check: "unknown" },
  );
  delete request(b).ingredientSnapshot;
  expect(compareOptimizationRuns([a, b], 100).runs[1]).toMatchObject({
    evidenceIssue: "Incomplete historical reference/specification evidence.",
    allocations: [],
  });
});
it("rejects malformed optimal allocations and inconsistent historical costs without substituting evidence", () => {
  for (const mutate of [
    (r: RunRecord) => {
      result(r).lines[1].ingredientId = a;
    },
    (r: RunRecord) => {
      result(r).calculation.costPerKg = "1.0000";
    },
    (r: RunRecord) => {
      result(r).objective = 1;
    },
    (r: RunRecord) => {
      result(r).lines[0].percent = 1;
    },
    (r: RunRecord) => {
      request(r).ingredientSnapshot[0].price = null;
    },
  ]) {
    const b = fixture("b");
    mutate(b);
    const c = compareOptimizationRuns([fixture(), b], 100);
    expect(c.runs[1].costPerKg).toBeNull();
    expect(c.runs[1].allocations.every((a) => a.percent === null)).toBe(true);
  }
});
it("preserves exact reference identity, original availability, nulls and spreadsheet-safe evidence in five bounded worksheets", () => {
  const a = fixture(),
    b = fixture("b");
  const replacement = "00000000-0000-4000-8000-000000000004";
  request(b).lines[0].ingredientId = replacement;
  request(b).ingredientSnapshot[0].id = replacement;
  result(b).lines[0].ingredientId = replacement;
  const c = compareOptimizationRuns([a, b], 1000);
  expect(c.runs[1].allocations[0].deltaPercent).toBeNull();
  expect(c.runs[1].allocations[1].input.availableKg).toBe(100);
  const sheets = optimizationComparisonSheets(c, "synthetic-org", "digest");
  expect(sheets).toHaveLength(5);
  const csv = sheetsCsv(sheets);
  expect(csv).toContain("'=Synthetic scenario");
  expect(csv).toContain("'=Synthetic A");
  expect(csv).toContain("Historical price NGN/kg");
  expect(csv).toContain("Unknown or unavailable outcome");
  expect(() => compareOptimizationRuns([a, a], 100)).toThrow();
  expect(() => compareOptimizationRuns([a, b], 0)).toThrow();
});

it("retains different reviewed group constraints and all four scenarios without ranking them as approved", () => {
  const a = fixture(),
    b = fixture("b", 60),
    c = fixture("c", 50),
    d = fixture("d", 25);
  for (const r of [a, b, c, d])
    request(r).profileSnapshot.processing_rules = [
      {
        name: "Synthetic group cap",
        ingredientIds: [request(r).lines[0].ingredientId],
        minPercent: 0,
        maxPercent: r === a ? 75 : 60,
        requiredMethod: null,
        source: "Synthetic reviewed group evidence",
      },
    ];
  const compared = compareOptimizationRuns([a, b, c, d], 1000);
  expect(compared.runs).toHaveLength(4);
  expect(compared.runs[0].profile?.processing_rules[0].maxPercent).toBe(75);
  expect(compared.runs[1].profile?.processing_rules[0].maxPercent).toBe(60);
  expect(
    optimizationComparisonSheets(compared, "org", "digest")[3].rows,
  ).toContainEqual([
    "run-a",
    "Processing group",
    "Synthetic group cap",
    request(a).lines[0].ingredientId,
    0,
    75,
    null,
    "Not recorded",
    null,
    "Synthetic reviewed group evidence",
  ]);
  a.result = {
    status: "infeasible",
    solver: "Fixture",
    message: "Synthetic no solution",
  };
  const unavailable = compareOptimizationRuns([a, b], 100);
  expect(unavailable.runs[1].costPerKg).toBe("180.0000");
  expect(unavailable.runs[1].deltaCostPerKg).toBeNull();
});

it("exports a full-size processing conflict as separate bounded Excel cells without losing member or source evidence", () => {
  const a = fixture(),
    b = fixture("b");
  const ids = Array.from(
      { length: 100 },
      (_, i) => `00000000-0000-4000-8000-${String(i + 100).padStart(12, "0")}`,
    ),
    source = "x".repeat(2000);
  b.result = {
    status: "infeasible",
    solver: "Synthetic stored outcome fixture",
    message: "Synthetic conflict report fixture",
    conflict: {
      version: 1,
      status: "irreducible",
      termination: "complete",
      checks: 2,
      maxChecks: 48,
      candidateCount: 1,
      tolerance: 1e-7,
      constraints: [
        {
          id: "row:0:min",
          kind: "processing",
          label: "Synthetic large group",
          side: "min",
          value: 10,
          unit: "%",
          ingredientIds: ids,
          evidence: source,
        },
      ],
    },
  };
  const sheets = optimizationComparisonSheets(
    compareOptimizationRuns([a, b], 100),
    "org",
    "digest",
  );
  const row = sheets[3].rows.find((r) => r[1] === "Conflict processing")!;
  expect(row[3]).toBe(ids.join(", "));
  expect(row[9]).toBe(source);
  expect(
    sheets.every(
      (s) =>
        s.rows.length <= 2000 &&
        s.rows.every((r) =>
          r.every((c) => typeof c !== "string" || c.length <= 4000),
        ),
    ),
  ).toBe(true);
});
