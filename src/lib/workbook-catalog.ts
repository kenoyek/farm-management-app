import workbooks from "../../data/workbook-audit.json";
// Values are normalized as candidates, never as approved nutrition constraints.
export type ParsedValue = {
  kind: "missing" | "scalar" | "range" | "unsupported";
  value?: number;
  min?: number;
  max?: number;
};
export type SourceField = {
  cell: string;
  raw: string | number | null;
  unit: string;
  parsed: ParsedValue;
};
export type CatalogRow = {
  category: "requirement" | "restriction" | "recipe";
  source_hash: string;
  sheet: string;
  source_row: number;
  label: string;
  context: string;
  fields: Record<string, SourceField>;
  issues: string[];
};
export function parseSourceValue(raw: unknown): ParsedValue {
  if (raw === null || raw === undefined || raw === "")
    return { kind: "missing" };
  if (typeof raw === "number")
    return Number.isFinite(raw) && raw >= 0
      ? { kind: "scalar", value: raw }
      : { kind: "unsupported" };
  if (typeof raw !== "string") return { kind: "unsupported" };
  const text = raw.trim().replaceAll("\u00a0", " ").replace(/\s+/g, "");
  // Decimal comma is accepted, but comma thousands or mixed separators are ambiguous.
  if ((text.includes(",") && text.includes(".")) || /\d,\d{3}(?!\d)/.test(text))
    return { kind: "unsupported" };
  const normalized = text.replaceAll(",", ".");
  const match = normalized.match(/^(\d+(?:\.\d+)?)(?:-|to)(\d+(?:\.\d+)?)$/i);
  if (match) {
    const min = Number(match[1]),
      max = Number(match[2]);
    return Number.isFinite(min) && Number.isFinite(max) && min <= max
      ? { kind: "range", min, max }
      : { kind: "unsupported" };
  }
  return /^\d+(?:\.\d+)?$/.test(normalized) &&
    Number.isFinite(Number(normalized))
    ? { kind: "scalar", value: Number(normalized) }
    : { kind: "unsupported" };
}
export function workbookCatalog(): CatalogRow[] {
  const book = workbooks.find(
    (w) => w.file === "Feed Formula Calculator.xlsx",
  )!;
  const rows: CatalogRow[] = [];
  const sheet = (name: string) => book.sheets.find((s) => s.name === name)!;
  const value = (name: string, cell: string) =>
    sheet(name).cells.find((c) => c.cell === cell)?.value ?? null;
  function field(name: string, cell: string, unit: string): SourceField {
    const raw = value(name, cell);
    return { cell, raw, unit, parsed: parseSourceValue(raw) };
  }
  function add(
    category: CatalogRow["category"],
    name: string,
    row: number,
    label: string,
    context: string,
    fields: CatalogRow["fields"],
    extra: string[] = [],
  ) {
    const issues = ["Unverified source; requires expert review.", ...extra];
    for (const [key, f] of Object.entries(fields)) {
      if (f.parsed.kind === "missing")
        issues.push(`${key}: missing; not zero or unrestricted.`);
      if (f.parsed.kind === "unsupported")
        issues.push(`${key}: unsupported or ambiguous value.`);
      if (category === "requirement" && f.parsed.kind === "scalar")
        issues.push(`${key}: scalar has no declared minimum/maximum meaning.`);
      if (
        f.unit === "%" &&
        ((f.parsed.value ?? 0) > 100 || (f.parsed.max ?? 0) > 100)
      )
        issues.push(`${key}: percentage exceeds 100.`);
    }
    rows.push({
      category,
      source_hash: book.sha256,
      sheet: name,
      source_row: row,
      label,
      context,
      fields,
      issues,
    });
  }
  for (let r = 8; r <= 39; r++) {
    const name = "Dietary Needs";
    const fields = Object.fromEntries(
      [
        ["protein", "C"],
        ["lipids", "D"],
        ["cellulose", "E"],
        ["calcium", "F"],
        ["phosphorus", "G"],
        ["lysine", "H"],
        ["methionine", "I"],
        ["energy", "J"],
      ].map(([key, col]) => [
        key,
        field(name, `${col}${r}`, key === "energy" ? "kcal/kg" : "%"),
      ]),
    );
    add(
      "requirement",
      name,
      r,
      String(value(name, `B${r}`)),
      "Source stage label; species/bases not verified",
      fields,
      [
        ...([30, 36].includes(r)
          ? [
              "Suspicious methionine value: preserve the original and seek source verification.",
            ]
          : []),
        "Energy and phosphorus systems are unspecified.",
      ],
    );
  }
  for (let r = 5; r <= 34; r++)
    for (const col of ["C", "D", "E", "F"]) {
      add(
        "restriction",
        "Ingredient Level",
        r,
        String(value("Ingredient Level", `B${r}`)),
        String(value("Ingredient Level", `${col}4`)),
        { inclusion: field("Ingredient Level", `${col}${r}`, "%") },
        [
          "Ingredient alias and production stage must be explicitly reconciled before use.",
        ],
      );
    }
  for (const name of ["Broiler Starter", "Broiler Finisher"])
    for (let r = 8; r <= 41; r++) {
      const label = String(value(name, `C${r}`));
      const extras = [
        "Recipe mapping is evidence only; no ingredient alias is automatically accepted.",
      ];
      for (const col of ["E", "F", "H", "I", "J", "K", "L"]) {
        const expression = value(name, `${col}${r}`);
        if (typeof expression !== "string" || !expression.startsWith("=")) {
          extras.push(`${col}${r}: missing contribution formula.`);
          continue;
        }
        const ref = expression.match(/'Nutritional Intake'!([A-Z]+)(\d+)/);
        if (!ref) continue;
        const target = String(value("Nutritional Intake", `B${ref[2]}`) ?? "");
        if (!target || label.toLowerCase() !== target.toLowerCase())
          extras.push(
            `${col}${r} references Nutritional Intake!${ref[1]}${ref[2]} (${target || "missing row"}), not an exact label match.`,
          );
      }
      add(
        "recipe",
        name,
        r,
        label,
        name,
        { inclusion: field(name, `D${r}`, "%") },
        extras,
      );
    }
  return rows;
}
