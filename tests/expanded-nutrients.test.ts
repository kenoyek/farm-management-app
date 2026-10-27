import { it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  recipeReport,
  recipeSheets,
  sheetsCsv,
  compareRecipes,
} from "../src/lib/recipe-reports";
import {
  calculateFormula,
  compliance,
  coreNutrientKeys,
  type Ingredient,
} from "../src/lib/feed";
import { optimize } from "../src/lib/optimizer";
import { nutrientDefinitions } from "../src/lib/nutrients";
import {
  suggestMapping,
  previewUpload,
  type Inspection,
} from "../src/lib/upload-model";

function legacyRecipe() {
  const ingredientId = "11111111-1111-4111-8111-111111111111";
  return {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Synthetic legacy recipe",
    status: "draft",
    batch_kg: "100",
    profile_id: null,
    created_at: "2026-10-01T12:00:00.000Z",
    lines: [{ ingredientId, percent: 100 }],
    ingredient_snapshot: [
      {
        id: ingredientId,
        name: "Synthetic legacy reference",
        source: "Test fixture only",
        price: "100",
        review_status: "unverified",
        basis: null,
        energy_system: null,
      },
    ],
    result: {
      totalPercent: 100,
      costPerKg: "100",
      batchCost: "10000",
      nutrients: {
        energy: 3000,
        protein: 20,
        dryMatter: 90,
        calcium: 1,
        phosphorus: 0.5,
        methionine: 0.5,
        lysine: 1,
      },
      compliance: [],
      issues: [],
      releaseEligible: false,
      modelVersion: 2,
    },
  };
}
it("retains the pre-expansion digest of a legacy saved recipe", () => {
  const digest = createHash("sha256")
    .update(JSON.stringify(recipeReport(legacyRecipe())))
    .digest("hex");
  expect(digest).toBe(
    "ccc19eff009524ea6aa7a3f63479884d17cf51fc145459786d6e43e3b2a13cc8",
  );
});
const reference = (
  id: string,
  price: number,
  crudeFat: number,
): Ingredient => ({
  id,
  name: id,
  price,
  source: "Synthetic test measurements only",
  review_status: "approved",
  basis: "as-fed",
  energy_system: "ME",
  species: "poultry",
  stages: ["starter"],
  phosphorus_basis: "total",
  nutrients: {
    energy: 3000,
    protein: 20,
    dryMatter: 90,
    calcium: 1,
    phosphorus: 0.5,
    methionine: 0.5,
    lysine: 1,
    crudeFat,
    crudeFibre: 4,
    moisture: 10,
    ash: 0,
  },
});
it("calculates all four measurements without inferring absent values or blocking legacy profiles", () => {
  const a = reference("a", 100, 2),
    b = reference("b", 300, 10);
  const lines = [
    { ingredientId: "a", percent: 75 },
    { ingredientId: "b", percent: 25 },
  ];
  const r = calculateFormula(lines, [a, b], 100);
  expect(r.nutrients).toMatchObject({
    crudeFat: 4,
    crudeFibre: 4,
    moisture: 10,
    ash: 0,
  });
  expect(r.releaseEligible).toBe(true);
  delete b.nutrients.moisture;
  delete b.nutrients.crudeFat;
  const missing = calculateFormula(lines, [a, b], 100);
  expect(missing.nutrients.moisture).toBeNull();
  expect(missing.nutrients.crudeFat).toBeNull();
  expect(missing.releaseEligible).toBe(true);
  const required = calculateFormula(lines, [a, b], 100, [
    ...coreNutrientKeys,
    "crudeFat",
  ]);
  expect(required.releaseEligible).toBe(false);
  expect(
    compliance(required.nutrients, { crudeFat: { min: 4 } })[0].status,
  ).toBe("unknown");
  expect(nutrientDefinitions.find((n) => n.key === "moisture")?.basis).toBe(
    "as-fed only",
  );
});
it("enforces genuine expanded nutrient constraints and independently checks all eleven rows", async () => {
  const selected = [reference("a", 100, 2), reference("b", 300, 10)];
  const lines = [
    { ingredientId: "a", percent: 50 },
    { ingredientId: "b", percent: 50 },
  ];
  const limits = {
    energy: { min: 2000 },
    protein: { min: 20 },
    dryMatter: { min: 80 },
    calcium: { min: 0 },
    phosphorus: { min: 0 },
    methionine: { min: 0 },
    lysine: { min: 0 },
    crudeFat: { min: 4 },
    crudeFibre: { max: 5 },
    moisture: { max: 15 },
    ash: { max: 5 },
  };
  const r = await optimize(selected, lines, limits, 100);
  expect(r.status).toBe("optimal");
  if ("lines" in r) {
    expect(r.lines[1].percent).toBeCloseTo(25);
    expect(r.calculation.costPerKg).toBe("150.0000");
    expect(r.calculation.nutrients.crudeFat).toBeCloseTo(4);
    expect(r.compliance).toHaveLength(11);
  }
  const bad = await optimize(
    selected,
    lines,
    { ...limits, crudeFat: { min: 11 } },
    100,
  );
  expect(bad.status).toBe("infeasible");
  expect(bad.fractions).toBeNull();
  delete selected[1].nutrients.crudeFat;
  await expect(optimize(selected, lines, limits, 100)).rejects.toThrow(
    /required crudeFat/,
  );
});
it("refuses moisture on dry-matter requirements and does not guess complementary moisture", async () => {
  const a = { ...reference("a", 100, 2), basis: "dry-matter" };
  delete a.nutrients.moisture;
  expect(
    calculateFormula([{ ingredientId: "a", percent: 100 }], [a], 100).nutrients
      .moisture,
  ).toBeNull();
  await expect(
    optimize(
      [a],
      [{ ingredientId: "a", percent: 100 }],
      { moisture: { max: 15 } },
      100,
    ),
  ).rejects.toThrow(/as-fed/);
});
it("maps explicit extended columns and converts g/kg while preserving zero and missing cells", () => {
  const book: Inspection = {
    sheets: [
      {
        name: "Fixture",
        rows: 2,
        columns: 5,
        cells: [
          ...["Ingredient", "Crude fat", "Crude fibre", "Moisture", "Ash"].map(
            (value, i) => ({
              cell: `${String.fromCharCode(65 + i)}1`,
              row: 1,
              column: i + 1,
              kind: "text" as const,
              value,
              format: "General",
            }),
          ),
          {
            cell: "A2",
            row: 2,
            column: 1,
            kind: "text",
            value: "Synthetic feed",
            format: "General",
          },
          ...[40, 30, 100, 0].map((value, i) => ({
            cell: `${String.fromCharCode(66 + i)}2`,
            row: 2,
            column: i + 2,
            kind: "number" as const,
            value,
            format: "General",
          })),
        ],
      },
    ],
  };
  const mapping = suggestMapping(book);
  mapping.concentrationUnit = "g/kg";
  expect(mapping.columns).toMatchObject({
    crudeFat: "B",
    crudeFibre: "C",
    moisture: "D",
    ash: "E",
  });
  const r = previewUpload(book, mapping);
  expect(r.errorCount).toBe(0);
  expect(r.rows[0].nutrients).toMatchObject({
    crudeFat: 4,
    crudeFibre: 3,
    moisture: 10,
    ash: 0,
    protein: null,
  });
  book.sheets[0].cells = book.sheets[0].cells.filter((c) => c.cell !== "D2");
  expect(previewUpload(book, mapping).rows[0].nutrients.moisture).toBeNull();
  const ambiguous = {
    sheets: [
      {
        ...book.sheets[0],
        cells: [
          {
            cell: "A1",
            row: 1,
            column: 1,
            kind: "text" as const,
            value: "Ingredient",
            format: "General",
          },
          {
            cell: "B1",
            row: 1,
            column: 2,
            kind: "text" as const,
            value: "Lipids",
            format: "General",
          },
          {
            cell: "C1",
            row: 1,
            column: 3,
            kind: "text" as const,
            value: "Cellulose",
            format: "General",
          },
        ],
      },
    ],
  };
  expect(suggestMapping(ambiguous).columns.crudeFat).toBe("");
  expect(suggestMapping(ambiguous).columns.crudeFibre).toBe("");
});
it("exports recorded expanded values but leaves legacy report rows and unknown comparisons unchanged", () => {
  const raw = legacyRecipe();
  const extended = {
    ...raw,
    id: "33333333-3333-4333-8333-333333333333",
    result: {
      ...raw.result,
      nutrients: {
        ...raw.result.nutrients,
        crudeFat: 4,
        crudeFibre: null,
        moisture: 10,
        ash: 0,
      },
    },
  };
  const old = recipeReport(raw),
    next = recipeReport(extended);
  const oldSheets = recipeSheets(old, "org", "digest"),
    sheets = recipeSheets(next, "org", "digest");
  expect(oldSheets[1].rows).toHaveLength(8);
  expect(sheets[1].rows).toHaveLength(12);
  expect(sheetsCsv(sheets)).toContain("Crude fat (%)");
  expect(sheets[1].rows.find((row) => row[0] === "Ash (%)")?.[1]).toBe(0);
  expect(
    sheets[1].rows.find((row) => row[0] === "Crude fibre (%)")?.[1],
  ).toBeNull();
  expect(
    compareRecipes([old, next], 100).versions[1].nutrientDeltas.crudeFat,
  ).toBeNull();
});
