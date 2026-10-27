import { z } from "zod";
import Decimal from "decimal.js";
import { nutrientKeys, type Nutrients } from "./feed";
export const importFields = ["name", "price", ...nutrientKeys] as const;
export type ImportField = (typeof importFields)[number];
export const inspectionSchema = z.object({
  sheets: z
    .array(
      z.object({
        name: z.string().max(100),
        rows: z.number().int().min(1).max(5000),
        columns: z.number().int().min(1).max(64),
        cells: z
          .array(
            z.object({
              cell: z.string().max(12),
              row: z.number().int().positive(),
              column: z.number().int().positive(),
              kind: z.enum(["number", "text", "formula", "date", "boolean"]),
              value: z.union([
                z.string().max(2000),
                z.number().finite(),
                z.boolean(),
              ]),
              format: z.string().max(2000),
            }),
          )
          .max(20000),
      }),
    )
    .min(1)
    .max(12),
});
export type Inspection = z.infer<typeof inspectionSchema>;
const column = z.string().regex(/^(?:[A-Z]{1,2})?$/);
export const uploadMapping = z
  .object({
    sheet: z.string().min(1).max(100),
    firstRow: z.number().int().min(1).max(5000),
    lastRow: z.number().int().min(1).max(5000),
    columns: z
      .object({
        name: column.refine(Boolean, "Choose a name column."),
        price: column,
        energy: column,
        protein: column,
        dryMatter: column,
        calcium: column,
        phosphorus: column,
        methionine: column,
        lysine: column,
        crudeFat: column.optional(),
        crudeFibre: column.optional(),
        moisture: column.optional(),
        ash: column.optional(),
      })
      .strict(),
    concentrationUnit: z.enum(["percent", "g/kg", "fraction"]),
    energyUnit: z.enum(["kcal/kg", "MJ/kg"]),
    priceUnit: z.enum(["NGN/kg", "NGN/bag"]),
    bagKg: z.number().positive().max(10000),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.lastRow < v.firstRow || v.lastRow - v.firstRow >= 1000)
      ctx.addIssue({
        code: "custom",
        message: "Select between 1 and 1,000 data rows.",
      });
    const columns = Object.values(v.columns).filter(Boolean);
    if (new Set(columns).size !== columns.length)
      ctx.addIssue({
        code: "custom",
        message: "Each mapped field must use a different column.",
      });
  });
export type UploadMapping = z.infer<typeof uploadMapping>;
export type ImportRow = {
  row: number;
  name: string;
  status: "valid" | "error" | "blank";
  nutrients: Nutrients;
  price: number | null;
  issues: string[];
  sourceCells: Record<string, string>;
};
export type ImportPreview = {
  rows: ImportRow[];
  validCount: number;
  errorCount: number;
  blankCount: number;
  warningCount: number;
};
export function columnName(index: number): string {
  return index <= 26
    ? String.fromCharCode(64 + index)
    : String.fromCharCode(64 + Math.floor((index - 1) / 26)) +
        String.fromCharCode(65 + ((index - 1) % 26));
}
function columnIndex(name: string) {
  return [...name].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
}
export function suggestMapping(book: Inspection): UploadMapping {
  const sheet =
    book.sheets.find((s) => s.name === "Nutritional Intake") ?? book.sheets[0];
  const columns = Object.fromEntries(
    importFields.map((k) => [k, ""]),
  ) as UploadMapping["columns"];
  columns.name = "A";
  let firstRow = 1;
  if (sheet.name === "Nutritional Intake" && sheet.columns >= 10) {
    Object.assign(columns, {
      name: "B",
      price: "J",
      energy: "C",
      protein: "D",
      dryMatter: "E",
      calcium: "F",
      phosphorus: "G",
      methionine: "H",
      lysine: "I",
    });
    firstRow = 7;
  } else {
    const aliases: Record<string, ImportField> = {
      name: "name",
      ingredient: "name",
      ingredientname: "name",
      rawmaterial: "name",
      price: "price",
      pricengnkg: "price",
      priceperkg: "price",
      energy: "energy",
      energykcalkg: "energy",
      protein: "protein",
      crudeprotein: "protein",
      drymatter: "dryMatter",
      calcium: "calcium",
      phosphorus: "phosphorus",
      methionine: "methionine",
      lysine: "lysine",
      crudefat: "crudeFat",
      crudefibre: "crudeFibre",
      crudefiber: "crudeFibre",
      moisture: "moisture",
      ash: "ash",
    };
    for (let r = 1; r <= Math.min(20, sheet.rows); r++) {
      const found: Partial<Record<ImportField, string>> = {};
      for (const c of sheet.cells.filter(
        (c) => c.row === r && c.kind === "text",
      )) {
        const key = String(c.value)
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-z]/g, "");
        if (aliases[key] && !found[aliases[key]])
          found[aliases[key]] = columnName(c.column);
      }
      if (found.name) {
        Object.assign(columns, found);
        firstRow = r + 1;
        break;
      }
    }
  }
  return {
    sheet: sheet.name,
    firstRow,
    lastRow: Math.max(firstRow, Math.min(sheet.rows, firstRow + 999)),
    columns,
    concentrationUnit: "percent",
    energyUnit: "kcal/kg",
    priceUnit: "NGN/kg",
    bagKg: 50,
  };
}
function numeric(value: string | number | boolean): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim().replaceAll("\u00a0", " ");
  if (/\s/.test(text) && !/^\d{1,3}(?: \d{3})+(?:[.,]\d+)?$/.test(text))
    return null;
  const normalized = text.replaceAll(" ", "");
  if (
    (normalized.includes(",") && normalized.includes(".")) ||
    /\d,\d{3}(?!\d)/.test(normalized)
  )
    return null;
  return /^\d+(?:[.,]\d+)?$/.test(normalized)
    ? Number(normalized.replace(",", "."))
    : null;
}
export function previewUpload(book: Inspection, raw: unknown): ImportPreview {
  const mapping = uploadMapping.parse(raw),
    sheet = book.sheets.find((s) => s.name === mapping.sheet);
  if (!sheet) throw Error("Choose a worksheet from this upload.");
  if (
    mapping.lastRow > sheet.rows ||
    Object.values(mapping.columns).some(
      (c) => c && columnIndex(c) > sheet.columns,
    )
  )
    throw Error("The selected row range or columns exceed this worksheet.");
  const indexed = new Map(sheet.cells.map((c) => [c.cell, c]));
  const occupied = new Set(sheet.cells.map((c) => c.row));
  const rows: ImportRow[] = [];
  let warningCount = 0;
  for (let r = mapping.firstRow; r <= mapping.lastRow; r++) {
    const row: ImportRow = {
      row: r,
      name: "",
      status: occupied.has(r) ? "valid" : "blank",
      price: null,
      nutrients: Object.fromEntries(
        nutrientKeys.map((k) => [k, null]),
      ) as Nutrients,
      issues: [],
      sourceCells: {},
    };
    let errors = 0;
    if (row.status === "blank") {
      rows.push(row);
      continue;
    }
    for (const key of importFields) {
      const col = mapping.columns[key];
      if (!col) {
        if (key !== "name")
          row.issues.push(`${key}: unmapped; remains unknown.`);
        continue;
      }
      const cell = `${col}${r}`;
      row.sourceCells[key] = cell;
      const original = indexed.get(cell);
      if (!original) {
        if (key === "name") {
          errors++;
          row.issues.push("Name is missing.");
        } else row.issues.push(`${key}: blank; remains unknown.`);
        continue;
      }
      if (original.kind === "formula") {
        errors++;
        row.issues.push(
          `${cell}: formula is not evaluated or imported as a value.`,
        );
        continue;
      }
      if (key === "name") {
        if (
          original.kind !== "text" ||
          !String(original.value).trim() ||
          String(original.value).trim().length > 100
        ) {
          errors++;
          row.issues.push(
            `${cell}: ingredient name must be text with 1–100 characters.`,
          );
        } else row.name = String(original.value).trim();
        continue;
      }
      const number =
        original.kind === "date" || original.kind === "boolean"
          ? null
          : numeric(original.value);
      if (number === null || !Number.isFinite(number) || number < 0) {
        errors++;
        row.issues.push(
          `${cell}: invalid, negative or ambiguous numeric value.`,
        );
        continue;
      }
      if (key === "price") {
        const price = new Decimal(number)
          .div(mapping.priceUnit === "NGN/bag" ? mapping.bagKg : 1)
          .toDecimalPlaces(4)
          .toNumber();
        if (price > 1e10) {
          errors++;
          row.issues.push(`${cell}: price exceeds the supported range.`);
        } else {
          row.price = price;
          if (price === 0)
            row.issues.push(
              "Zero price requires review; it is not assumed to be free.",
            );
        }
        continue;
      }
      const scalingFormat = original.format.replace(/"[^"]*"/g, "");
      if (
        key !== "energy" &&
        /(^|[^\\])%/.test(scalingFormat) &&
        mapping.concentrationUnit !== "fraction"
      ) {
        errors++;
        row.issues.push(
          `${cell}: Excel percentage formatting stores a fraction. Choose fraction units or standardize the source.`,
        );
        continue;
      }
      const converted =
        key === "energy"
          ? new Decimal(number).mul(
              mapping.energyUnit === "MJ/kg" ? new Decimal(1000).div(4.184) : 1,
            )
          : new Decimal(number).mul(
              mapping.concentrationUnit === "fraction"
                ? 100
                : mapping.concentrationUnit === "g/kg"
                  ? 0.1
                  : 1,
            );
      const value = converted.toNumber();
      if (
        !Number.isFinite(value) ||
        value > (key === "energy" ? 100000 : 100)
      ) {
        errors++;
        row.issues.push(
          `${cell}: converted ${key} is outside the supported range; check units.`,
        );
      } else {
        row.nutrients[key] = value;
        if (
          (key === "methionine" && value > 10) ||
          (key === "lysine" && value > 20) ||
          (key === "phosphorus" && value > 5)
        )
          row.issues.push(
            `${key}: suspicious source value retained for expert review.`,
          );
      }
    }
    if (row.price === null)
      row.issues.push(
        "A current price quotation is required before optimization.",
      );
    row.issues.push(
      "Unverified: nutrient bases, species, stage and ingredient restrictions need review.",
    );
    if (errors) row.status = "error";
    else warningCount += row.issues.length;
    rows.push(row);
  }
  return {
    rows,
    validCount: rows.filter((r) => r.status === "valid").length,
    errorCount: rows.filter((r) => r.status === "error").length,
    blankCount: rows.filter((r) => r.status === "blank").length,
    warningCount,
  };
}
