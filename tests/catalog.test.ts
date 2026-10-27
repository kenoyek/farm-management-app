import { describe, it, expect } from "vitest";
import { parseSourceValue, workbookCatalog } from "../src/lib/workbook-catalog";
describe("source normalization preserves meaning", () => {
  it("normalizes comma decimals and spaced energy ranges", () => {
    expect(parseSourceValue("16,5-17")).toEqual({
      kind: "range",
      min: 16.5,
      max: 17,
    });
    expect(parseSourceValue("2 600-2 700")).toEqual({
      kind: "range",
      min: 2600,
      max: 2700,
    });
    expect(parseSourceValue("0 to 0,5")).toEqual({
      kind: "range",
      min: 0,
      max: 0.5,
    });
  });
  it("distinguishes absent, scalar, and unsupported values", () => {
    expect(parseSourceValue(null)).toEqual({ kind: "missing" });
    expect(parseSourceValue(0)).toEqual({ kind: "scalar", value: 0 });
    for (const v of [
      "1,000",
      "1.234,5",
      "=SUM(A1:A2)",
      "20-10",
      "9".repeat(400),
      NaN,
    ])
      expect(parseSourceValue(v).kind).toBe("unsupported");
  });
  it("stages all requirement, inclusion and broiler rows with source coordinates", () => {
    const rows = workbookCatalog();
    expect(rows.filter((r) => r.category === "requirement")).toHaveLength(32);
    expect(rows.filter((r) => r.category === "restriction")).toHaveLength(120);
    expect(rows.filter((r) => r.category === "recipe")).toHaveLength(68);
    expect(rows.every((r) => r.source_hash.length === 64)).toBe(true);
    const layers = rows.find(
      (r) => r.sheet === "Dietary Needs" && r.source_row === 10,
    )!;
    expect(layers.fields.protein).toMatchObject({
      cell: "C10",
      raw: "16,5-17",
      parsed: { min: 16.5, max: 17 },
    });
    expect(layers.issues).toContain(
      "phosphorus: scalar has no declared minimum/maximum meaning.",
    );
  });
  it("preserves suspicious values and warns about mismatched recipe aliases", () => {
    const rows = workbookCatalog();
    const geese = rows.find(
      (r) => r.sheet === "Dietary Needs" && r.source_row === 30,
    )!;
    expect(geese.fields.methionine.parsed).toEqual({
      kind: "scalar",
      value: 47,
    });
    expect(geese.issues.join(" ")).toMatch(/Suspicious methionine/);
    const limestone = rows.find(
      (r) => r.sheet === "Broiler Starter" && r.label === "Limestone",
    )!;
    expect(limestone.issues.join(" ")).toMatch(/Oyster Shell/);
    expect(limestone.issues.join(" ")).toMatch(/not an exact label match/);
  });
});
