import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  recipeReport,
  compareRecipes,
  recipeSheets,
  sheetsCsv,
} from "../src/lib/recipe-reports";

const a = randomUUID(),
  b = randomUUID(),
  profileId = randomUUID();
function fixture() {
  const profile = {
    id: profileId,
    name: "Synthetic starter specification",
    revision: 1,
    species: "poultry",
    stage: "starter",
    basis: "as-fed",
    energy_system: "ME",
    phosphorus_basis: "total",
    source: "Test-only evidence, not agricultural guidance",
    reviewer_id: randomUUID(),
    created_at: "2026-10-01T12:00:00.000Z",
    limits: { protein: { min: 20 } },
    ingredient_rules: [],
  };
  return {
    id: randomUUID(),
    name: "Historical test recipe",
    status: "draft",
    batch_kg: "100.000000",
    created_at: new Date("2026-10-02T12:00:00Z"),
    profile_id: profile.id,
    lines: [
      { ingredientId: a, percent: 75, min: 0, max: 100, availableKg: 75 },
      { ingredientId: b, percent: 25, min: 0, max: 100 },
    ],
    ingredient_snapshot: [
      {
        id: a,
        name: "Cheap fixture",
        price: "100.0000",
        source: "Historical source A",
        review_status: "approved",
        basis: "as-fed",
        energy_system: "ME",
        quoted_on: "2026-10-01",
      },
      {
        id: b,
        name: "Rich fixture",
        price: "300.0000",
        source: "Historical source B",
        review_status: "approved",
        basis: "as-fed",
        energy_system: "ME",
      },
    ],
    result: {
      totalPercent: 100,
      costPerKg: "150.0000" as string | null,
      batchCost: "15000.00" as string | null,
      nutrients: {
        energy: 3000,
        protein: 20,
        dryMatter: null as number | null,
        calcium: 1 as number | null,
        phosphorus: 0.5,
        methionine: 0.5,
        lysine: 1,
      },
      issues: [] as string[],
      compliance: [{ nutrient: "protein", min: 20, status: "pass" }],
      releaseEligible: true,
      profileSnapshot: profile as unknown,
      modelVersion: 2,
    },
    profile_reference: profile as unknown,
  };
}
it("reports immutable saved prices, allocations, evidence and unknown nutrients", () => {
  const raw = fixture(),
    report = recipeReport(raw);
  expect(report.allocations.map((a) => a.kg)).toEqual([
    "75.000000",
    "25.000000",
  ]);
  expect(report.costPerKg).toBe("150.0000");
  expect(report.nutrients.dryMatter).toBeNull();
  expect(report.profileEvidence).toBe("embedded snapshot");
  expect(report.savedBy).toBeNull();
  expect(report.notice).toMatch(/DRAFT.*NOT APPROVED/);
  expect(raw.ingredient_snapshot[0].price).toBe("100.0000");
});
it("compares different batch sizes using exact decimal deltas and a chosen baseline", () => {
  const first = fixture(),
    second = fixture();
  second.batch_kg = "500.000000";
  second.result.costPerKg = "160.1250";
  second.result.batchCost = "80062.50";
  second.result.nutrients.calcium = 0;
  const result = compareRecipes(
    [recipeReport(first), recipeReport(second)],
    250,
  );
  expect(result.contextComparable).toBe(true);
  expect(result.versions[1]).toMatchObject({
    commonBatchCost: "40031.25",
    deltaPerKg: "10.1250",
    deltaCommonBatch: "2531.25",
  });
  expect(result.versions[1].nutrientDeltas.calcium).toBe(-1);
  expect(result.versions[1].nutrientDeltas.dryMatter).toBeNull();
  expect(result.versions[1].scaledAllocations[0].kg).toBe("187.500000");
  expect(
    compareRecipes([recipeReport(second), recipeReport(first)], 250).versions[1]
      .deltaPerKg,
  ).toBe("-10.1250");
  expect(second.batch_kg).toBe("500.000000");
});
it("preserves null and explicit zero costs without inventing a percentage saving", () => {
  const first = fixture(),
    second = fixture();
  first.result.costPerKg = null;
  first.result.batchCost = null;
  second.result.costPerKg = "0";
  second.result.batchCost = "0";
  const result = compareRecipes(
    [recipeReport(first), recipeReport(second)],
    1000,
  );
  expect(result.versions[0].commonBatchCost).toBeNull();
  expect(result.versions[1].commonBatchCost).toBe("0.00");
  expect(result.versions[1].deltaPerKg).toBeNull();
  expect(result.versions[1].deltaCommonBatch).toBeNull();
});
it("withholds all nutrient deltas across incompatible or absent scientific contexts", () => {
  for (const field of [
    "species",
    "stage",
    "basis",
    "energy_system",
    "phosphorus_basis",
  ]) {
    const first = fixture(),
      second = fixture();
    second.result.profileSnapshot = {
      ...(second.result.profileSnapshot as object),
      [field]: "different",
    };
    const result = compareRecipes(
      [recipeReport(first), recipeReport(second)],
      100,
    );
    expect(result.contextComparable).toBe(false);
    expect(
      Object.values(result.versions[1].nutrientDeltas).every((v) => v === null),
    ).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/not treat.*interchangeable/);
    expect(result.versions[1].deltaPerKg).toBe("0.0000");
  }
  const missing = {
    ...fixture(),
    profile_id: null,
    profile_reference: null,
    result: { ...fixture().result, profileSnapshot: null },
  };
  expect(
    compareRecipes([recipeReport(fixture()), recipeReport(missing)], 100)
      .contextComparable,
  ).toBe(false);
});
it("retains incomplete inclusion totals instead of scaling them to 100%", () => {
  const partial = fixture();
  partial.lines[0].percent = 60;
  partial.result.totalPercent = 85;
  partial.result.issues = ["Ingredient inclusion must total 100%."];
  const result = compareRecipes(
    [recipeReport(fixture()), recipeReport(partial)],
    1000,
  );
  expect(result.versions[1].scaledAllocations[0].kg).toBe("600.000000");
  expect(result.warnings.join(" ")).toMatch(/not been normalized/);
});
it("uses immutable profile references for older versions and refuses mismatched or missing evidence", () => {
  const raw = fixture();
  raw.result.profileSnapshot = undefined;
  expect(recipeReport(raw).profileEvidence).toBe("immutable profile reference");
  expect(
    recipeReport({
      ...raw,
      profile_reference: {
        ...(raw.profile_reference as object),
        processing_rules: [],
      },
    }),
  ).toEqual(recipeReport(raw));
  expect(() => recipeReport({ ...raw, profile_id: randomUUID() })).toThrow(
    /does not match/,
  );
  expect(() => recipeReport({ ...raw, ingredient_snapshot: [] })).toThrow(
    /evidence is missing/,
  );
  expect(() =>
    recipeReport({ ...raw, lines: [raw.lines[0], raw.lines[0]] }),
  ).toThrow(/Duplicate/);
  expect(() =>
    recipeReport({ ...raw, result: { ...raw.result, costPerKg: "1e999999" } }),
  ).toThrow();
});
it("exports saved identities, original batch, review issues and nullable evidence with safe CSV text", () => {
  const raw = fixture();
  raw.name = "=SUM(1,1)";
  raw.ingredient_snapshot[0].name = "  @danger";
  raw.result.issues = ['Preserve "quoted" evidence'];
  const sheets = recipeSheets(recipeReport(raw), randomUUID(), "a".repeat(64));
  expect(sheets.map((s) => s.name)).toEqual([
    "Mixing sheet",
    "Nutrients",
    "Reference audit",
    "Specification",
  ]);
  expect(sheets[0].rows[7]).toEqual(["Original batch kg", 100]);
  expect(sheets[1].rows.find((r) => r[0] === "Dry matter (%)")?.[1]).toBeNull();
  const csv = sheetsCsv(sheets);
  expect(csv).toContain('"\'=SUM(1,1)"');
  expect(csv).toContain('"\'  @danger"');
  expect(csv).toContain('"Preserve ""quoted"" evidence"');
  expect(csv).toContain(raw.id);
  expect(csv).toContain("NOT APPROVED");
  expect(csv).toContain("Historical source A");
});
it("refuses invalid selections, nonfinite scales and duplicate comparison versions", () => {
  const r = recipeReport(fixture());
  for (const batch of [0, -1, NaN, Infinity, 1e9])
    expect(() => compareRecipes([r, recipeReport(fixture())], batch)).toThrow();
  expect(() => compareRecipes([r], 100)).toThrow();
  expect(() => compareRecipes([r, r], 100)).toThrow();
});
