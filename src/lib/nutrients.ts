// Canonical, bounded definitions. Adding a definition never supplies a measured
// value or changes the meaning of a historical reference/profile.
export const coreNutrientKeys = [
  "energy",
  "protein",
  "dryMatter",
  "calcium",
  "phosphorus",
  "methionine",
  "lysine",
] as const;
export const extendedNutrientKeys = [
  "crudeFat",
  "crudeFibre",
  "moisture",
  "ash",
] as const;
export const nutrientKeys = [
  ...coreNutrientKeys,
  ...extendedNutrientKeys,
] as const;
export type Nutrient = (typeof nutrientKeys)[number];
export type Nutrients = Record<
  (typeof coreNutrientKeys)[number],
  number | null
> &
  Partial<Record<(typeof extendedNutrientKeys)[number], number | null>>;
export const nutrientRegistryVersion = 2;
export const nutrientLabels: Record<Nutrient, string> = {
  energy: "Energy (kcal/kg)",
  protein: "Crude protein (%)",
  dryMatter: "Dry matter (%)",
  calcium: "Calcium (%)",
  phosphorus: "Phosphorus (%)",
  methionine: "Methionine (%)",
  lysine: "Lysine (%)",
  crudeFat: "Crude fat (%)",
  crudeFibre: "Crude fibre (%)",
  moisture: "Moisture (as-fed %)",
  ash: "Ash (%)",
};
export const nutrientDefinitions = nutrientKeys.map((key) => ({
  key,
  label: nutrientLabels[key],
  unit: key === "energy" ? "kcal/kg" : "%",
  basis: key === "moisture" ? "as-fed only" : "declared reference basis",
  requiredByDefault: (coreNutrientKeys as readonly string[]).includes(key),
}));
