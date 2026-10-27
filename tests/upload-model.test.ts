import { beforeAll, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { inspectUpload } from "../src/lib/workbook-upload-api";
import {
  previewUpload,
  suggestMapping,
  type Inspection,
  uploadMapping,
  columnName,
} from "../src/lib/upload-model";
let original: Inspection;
beforeAll(async () => {
  original = await inspectUpload(
    readFileSync("data/source/Feed Formula Calculator.xlsx"),
  );
});
it("suggests the actual source nutrient table and retains missing/zero and suspicious values", () => {
  const mapping = suggestMapping(original);
  expect(mapping).toMatchObject({
    sheet: "Nutritional Intake",
    firstRow: 7,
    lastRow: 38,
    columns: { name: "B", price: "J" },
  });
  const result = previewUpload(original, mapping);
  expect(result.validCount).toBe(32);
  expect(result.errorCount).toBe(0);
  expect(result.rows[0]).toMatchObject({
    name: "Maize",
    price: 230,
    nutrients: { protein: 9 },
    sourceCells: { protein: "D7" },
  });
  expect(
    result.rows.find((r) => r.name === "Defatted Soybean meal")?.nutrients
      .methionine,
  ).toBeNull();
  expect(
    result.rows.find((r) => r.name === "Bloodmeal")?.issues.join(" "),
  ).toMatch(/suspicious/);
  expect(result.rows.find((r) => r.name === "Maize bran")?.price).toBe(0);
});
it("rejects mapped formula cells without trusting cached values", () => {
  const mapping = suggestMapping(original);
  mapping.sheet = "Broiler Starter";
  mapping.firstRow = 8;
  mapping.lastRow = 8;
  mapping.columns = {
    name: "C",
    price: "L",
    energy: "E",
    protein: "F",
    dryMatter: "G",
    calcium: "H",
    phosphorus: "I",
    methionine: "J",
    lysine: "K",
  };
  const preview = previewUpload(original, mapping);
  expect(preview.errorCount).toBe(1);
  expect(preview.rows[0].issues.join(" ")).toMatch(/formula is not evaluated/);
});
const custom: Inspection = {
  sheets: [
    {
      name: "Custom",
      rows: 3,
      columns: 4,
      cells: [
        {
          cell: "A1",
          row: 1,
          column: 1,
          kind: "text",
          value: "Ingredient",
          format: "General",
        },
        {
          cell: "A2",
          row: 2,
          column: 1,
          kind: "text",
          value: "Soybean",
          format: "General",
        },
        {
          cell: "B2",
          row: 2,
          column: 2,
          kind: "number",
          value: 450,
          format: "General",
        },
        {
          cell: "C2",
          row: 2,
          column: 3,
          kind: "number",
          value: 12,
          format: "General",
        },
        {
          cell: "D2",
          row: 2,
          column: 4,
          kind: "number",
          value: 22500,
          format: "General",
        },
      ],
    },
  ],
};
it("normalizes explicitly selected concentration, energy and bag price units", () => {
  const mapping = suggestMapping(custom);
  Object.assign(mapping, {
    firstRow: 2,
    lastRow: 3,
    concentrationUnit: "g/kg",
    energyUnit: "MJ/kg",
    priceUnit: "NGN/bag",
    bagKg: 50,
  });
  mapping.columns = {
    ...mapping.columns,
    name: "A",
    protein: "B",
    energy: "C",
    price: "D",
  };
  const p = previewUpload(custom, mapping);
  expect(p.rows[0].nutrients.protein).toBe(45);
  expect(p.rows[0].nutrients.energy).toBeCloseTo(2868.06883365);
  expect(p.rows[0].price).toBe(450);
  expect(p.blankCount).toBe(1);
  mapping.concentrationUnit = "fraction";
  expect(previewUpload(custom, mapping).errorCount).toBe(1);
});
it("flags ambiguous numeric text, missing names, invalid ranges and duplicate columns", () => {
  const book = structuredClone(custom);
  book.sheets[0].cells.find((c) => c.cell === "B2")!.value = "1,000";
  const mapping = suggestMapping(book);
  mapping.firstRow = 2;
  mapping.lastRow = 2;
  mapping.columns.protein = "B";
  expect(previewUpload(book, mapping).errorCount).toBe(1);
  mapping.columns.protein = "A";
  expect(uploadMapping.safeParse(mapping).success).toBe(false);
  mapping.columns.protein = "B";
  mapping.lastRow = 1002;
  expect(uploadMapping.safeParse(mapping).success).toBe(false);
  expect(columnName(27)).toBe("AA");
});
it("rejects invalid files and the upload size limit before processing", async () => {
  await expect(inspectUpload(Buffer.from("invalid"))).rejects.toMatchObject({
    status: 422,
  });
  await expect(inspectUpload(Buffer.alloc(2097153))).rejects.toMatchObject({
    status: 413,
  });
});
it("does not interpret a lone header row as an ingredient automatically", () => {
  const onlyHeader = structuredClone(custom);
  onlyHeader.sheets[0].rows = 1;
  onlyHeader.sheets[0].cells = onlyHeader.sheets[0].cells.filter(
    (c) => c.row === 1,
  );
  const mapping = suggestMapping(onlyHeader);
  expect(mapping.firstRow).toBe(2);
  expect(() => previewUpload(onlyHeader, mapping)).toThrow(/exceed/);
});
it("requires explicit fraction mapping for Excel percentage-formatted concentrations", () => {
  const book = structuredClone(custom);
  const cell = book.sheets[0].cells.find((c) => c.cell === "B2")!;
  cell.value = 0.45;
  cell.format = "0.00%";
  const mapping = suggestMapping(book);
  mapping.firstRow = 2;
  mapping.lastRow = 2;
  mapping.columns.protein = "B";
  expect(previewUpload(book, mapping).errorCount).toBe(1);
  mapping.concentrationUnit = "fraction";
  expect(previewUpload(book, mapping).rows[0].nutrients.protein).toBe(45);
  expect(previewUpload(book, mapping).errorCount).toBe(0);
});
