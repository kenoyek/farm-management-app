import {
  applyProfileBounds,
  profileRuleIssues,
  type IngredientRule,
} from "./profile-rules";
import { spawn } from "node:child_process";
import {
  nutrientKeys,
  type Ingredient,
  type FormulaLine,
  type Limits,
  calculateFormula,
  compliance,
} from "./feed";
export async function optimize(
  ingredients: Ingredient[],
  lines: FormulaLine[],
  limits: Limits,
  batchKg: number,
  rules: IngredientRule[] = [],
) {
  if (!Number.isFinite(batchKg) || batchKg <= 0)
    throw Error("Batch weight must be greater than zero.");
  lines = applyProfileBounds(lines, rules);
  const selected = lines.map((l) => {
    const ingredient = ingredients.find((i) => i.id === l.ingredientId);
    if (!ingredient) throw Error("Ingredient not found.");
    return ingredient;
  });
  if (
    !selected.length ||
    new Set(lines.map((l) => l.ingredientId)).size !== lines.length
  )
    throw Error("Choose unique ingredients.");
  for (const i of selected) {
    if (
      i.review_status !== "approved" ||
      !i.basis ||
      !i.energy_system ||
      i.price === null ||
      Number(i.price) <= 0
    )
      throw Error(
        `${i.name}: reviewed nutrient basis, energy system and a positive price are required.`,
      );
    for (const n of nutrientKeys.filter((n) => limits[n]))
      if (i.nutrients[n] === null)
        throw Error(`${i.name}: required ${n} data is missing.`);
  }
  if (
    new Set(selected.map((i) => i.basis)).size !== 1 ||
    new Set(selected.map((i) => i.energy_system)).size !== 1
  )
    throw Error("Incompatible nutrient bases.");
  if (!Object.keys(limits).length)
    throw Error("A nutritional specification is required.");
  lines = lines.map((line, index) => ({
    ...line,
    min: Math.max(line.min ?? 0, Number(selected[index].inclusion_min ?? 0)),
    max: Math.min(
      line.max ?? 100,
      Number(selected[index].inclusion_max ?? 100),
      line.availableKg === undefined ? 100 : (line.availableKg / batchKg) * 100,
    ),
  }));
  if (
    lines.some((l) => (l.min ?? 0) > (l.max ?? 100)) ||
    lines.reduce((s, l) => s + (l.min ?? 0), 0) > 100 + 1e-7 ||
    lines.reduce((s, l) => s + (l.max ?? 100), 0) < 100 - 1e-7
  )
    return {
      status: "infeasible",
      fractions: null,
      solver: "constraint-precheck",
      message:
        "Ingredient/profile minimums, maximums or available stock conflict with the 100% batch requirement.",
    };
  const payload = {
    cost: selected.map((i) => Number(i.price)),
    bounds: lines.map((l) => [(l.min ?? 0) / 100, (l.max ?? 100) / 100]),
    constraints: nutrientKeys
      .filter((n) => limits[n])
      .map((n) => ({
        values: selected.map((i) => i.nutrients[n]),
        ...limits[n],
      })),
  };
  const raw = await new Promise<string>((resolve, reject) => {
    const p = spawn(
      /* turbopackIgnore: true */ process.env.FARM_PYTHON ?? "python",
      ["scripts/optimize.py"],
      { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    let errors = "";
    const timer = setTimeout(() => {
      p.kill();
      reject(Error("Optimization timed out."));
    }, 20000);
    p.stdout.on("data", (d) => {
      output += d.toString();
    });
    p.stderr.on("data", (d) => {
      errors += d.toString();
    });
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        reject(Error(`Optimization service failed: ${errors.slice(0, 100)}`));
      else resolve(output);
    });
    p.stdin.end(JSON.stringify(payload));
  });
  const solution = JSON.parse(raw) as {
    status: string;
    fractions?: number[];
    solver: string;
    message: string;
  };
  if (solution.status !== "optimal" || !solution.fractions) return solution;
  const optimized = lines.map((l, index) => ({
    ...l,
    percent: solution.fractions![index] * 100,
  }));
  const calculation = calculateFormula(optimized, selected, batchKg);
  const ruleIssues = profileRuleIssues(optimized, ingredients, rules);
  calculation.issues.push(...ruleIssues);
  calculation.releaseEligible = calculation.issues.length === 0;
  const checks = compliance(calculation.nutrients, limits);
  if (
    ruleIssues.length > 0 ||
    Math.abs(calculation.totalPercent - 100) > 1e-6 ||
    checks.some((c) => c.status !== "pass") ||
    optimized.some(
      (l) =>
        l.percent < (l.min ?? 0) - 1e-6 || l.percent > (l.max ?? 100) + 1e-6,
    )
  )
    throw Error("Solver result failed independent constraint validation.");
  const bindingConstraints = [
    ...checks.flatMap((c) => [
      ...(c.actual !== null &&
      c.min !== undefined &&
      Math.abs(c.actual - c.min) < 1e-6
        ? [`${c.nutrient} minimum`]
        : []),
      ...(c.actual !== null &&
      c.max !== undefined &&
      Math.abs(c.actual - c.max) < 1e-6
        ? [`${c.nutrient} maximum`]
        : []),
    ]),
    ...optimized.flatMap((l, i) => [
      ...(Math.abs(l.percent - (l.min ?? 0)) < 1e-6
        ? [`${selected[i].name} minimum`]
        : []),
      ...(Math.abs(l.percent - (l.max ?? 100)) < 1e-6
        ? [`${selected[i].name} maximum/availability`]
        : []),
    ]),
  ];
  return {
    ...solution,
    lines: optimized,
    calculation,
    compliance: checks,
    bindingConstraints,
  };
}
