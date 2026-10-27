import { remoteWorker } from "./remote-worker";
import Decimal from "decimal.js";
import { z } from "zod";
import {
  diagnoseConstraints,
  type OptimizationResult,
} from "./optimization-diagnostics";
import { profileRuleIssues, type IngredientRule } from "./profile-rules";
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
): Promise<OptimizationResult> {
  if (!Number.isFinite(batchKg) || batchKg <= 0)
    throw Error("Batch weight must be greater than zero.");
  const selected = lines.map((l) => {
    const ingredient = ingredients.find((i) => i.id === l.ingredientId);
    if (!ingredient) throw Error("Ingredient not found.");
    return ingredient;
  });
  if (
    !selected.length ||
    selected.length > 100 ||
    new Set(lines.map((l) => l.ingredientId)).size !== lines.length
  )
    throw Error("Choose unique ingredients.");
  for (const i of selected) {
    if (
      i.review_status !== "approved" ||
      !i.basis ||
      !i.energy_system ||
      i.price === null ||
      !Number.isFinite(Number(i.price)) ||
      Number(i.price) <= 0
    )
      throw Error(
        `${i.name}: reviewed nutrient basis, energy system and a positive price are required.`,
      );
    for (const n of nutrientKeys.filter((n) => limits[n]))
      if (
        typeof i.nutrients[n] !== "number" ||
        !Number.isFinite(i.nutrients[n]) ||
        i.nutrients[n]! < 0
      )
        throw Error(`${i.name}: required ${n} data is missing.`);
  }
  if (
    new Set(selected.map((i) => i.basis)).size !== 1 ||
    new Set(selected.map((i) => i.energy_system)).size !== 1
  )
    throw Error("Incompatible nutrient bases.");
  if (!Object.keys(limits).length)
    throw Error("A nutritional specification is required.");
  const evidence = diagnoseConstraints(
    ingredients,
    lines,
    limits,
    batchKg,
    rules,
  );
  lines = lines.map((line, i) => ({
    ...line,
    min: evidence.effectiveBounds[i].min,
    max: evidence.effectiveBounds[i].max,
  }));
  if (evidence.diagnostics.length)
    return {
      status: "infeasible",
      fractions: null,
      objective: null,
      solver: "constraint-precheck",
      message: evidence.diagnostics.map((d) => d.message).join(" "),
      ...evidence,
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
  const raw = await solvePayload(payload);
  const solution = z
    .object({
      status: z.enum([
        "optimal",
        "infeasible",
        "limit",
        "unbounded",
        "solver-error",
      ]),
      fractions: z.array(z.number().finite()).nullable(),
      objective: z.number().finite().nullable(),
      solver: z.string().min(1),
      message: z.string(),
    })
    .strict()
    .parse(JSON.parse(raw));
  if (solution.status !== "optimal") {
    if (solution.fractions !== null || solution.objective !== null)
      throw Error("Unexpected nonoptimal solver allocation.");
    if (solution.status === "infeasible")
      evidence.diagnostics.push({
        kind: "combined-constraints",
        message:
          "No solution satisfies all constraints together. Individual reachable ranges are not a joint feasibility proof. All constraints remain unchanged.",
      });
    return {
      ...solution,
      status: solution.status,
      fractions: null,
      objective: null,
      ...evidence,
    };
  }
  if (
    !solution.fractions ||
    solution.fractions.length !== lines.length ||
    solution.objective === null
  )
    throw Error("Invalid optimal solver response.");
  const optimized = lines.map((l, index) => ({
    ...l,
    percent: solution.fractions![index] * 100,
  }));
  const calculation = calculateFormula(optimized, selected, batchKg);
  const ruleIssues = profileRuleIssues(optimized, ingredients, rules);
  calculation.issues.push(...ruleIssues);
  calculation.releaseEligible = calculation.issues.length === 0;
  const checks = compliance(calculation.nutrients, limits);
  const totalPercentError = Math.abs(calculation.totalPercent - 100);
  const maximumBoundViolationPercent = Math.max(
    0,
    ...optimized.flatMap((l) => [
      (l.min ?? 0) - l.percent,
      l.percent - (l.max ?? 100),
    ]),
  );
  const objective = optimized.reduce(
    (sum, line, i) =>
      sum.plus(new Decimal(line.percent).div(100).mul(selected[i].price!)),
    new Decimal(0),
  );
  const objectiveError = objective.minus(solution.objective).abs().toNumber();
  const objectiveTolerance = 1e-7 * Math.max(1, objective.abs().toNumber());
  if (
    objectiveError > objectiveTolerance ||
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
    status: "optimal",
    fractions: solution.fractions,
    objective: solution.objective,
    ...evidence,
    validation: {
      totalPercentError,
      maximumBoundViolationPercent,
      objectiveError,
      objectiveTolerance,
      nutrientTolerance: 1e-7,
      boundTolerancePercent: 1e-6,
    },
    lines: optimized,
    calculation,
    compliance: checks,
    bindingConstraints,
  };
}

let solving = 0;
async function solvePayload(payload: unknown): Promise<string> {
  if (solving >= 2) throw Error("Optimization is busy. Try again shortly.");
  const input = JSON.stringify(payload);
  if (Buffer.byteLength(input) > 256 * 1024)
    throw Error("Optimization request is too large.");
  solving++;
  try {
    const remote = await remoteWorker("optimize", Buffer.from(input));
    if (remote !== null) return remote.toString("utf8");
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(
        /* turbopackIgnore: true */ process.env.FARM_PYTHON ?? "python",
        ["scripts/optimize.py"],
        { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
      );
      let stopped = false,
        output = "";
      const stop = (message: string) => {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        child.kill();
        reject(Error(message));
      };
      const timer = setTimeout(() => stop("Optimization timed out."), 20000);
      child.on("error", () => stop("Optimization service is unavailable."));
      child.stdin.on("error", () => {});
      child.stderr.on("data", () => {});
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (Buffer.byteLength(output) > 256 * 1024)
          stop("Optimization response is too large.");
      });
      child.on("close", (code) => {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        if (code !== 0)
          reject(
            Error(
              "Optimization service failed or exceeded its resource limits.",
            ),
          );
        else resolve(output);
      });
      child.stdin.end(input);
    });
  } finally {
    solving--;
  }
}
