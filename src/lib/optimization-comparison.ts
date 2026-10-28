import { z } from "zod";
import Decimal from "decimal.js";
import { outcomeView, runSummary } from "./optimization-history";
import { nutrientKeys, nutrientLabels } from "./nutrients";
import { processingRules } from "./processing";
import type { ReportSheet } from "./recipe-reports";

const finite = z.number().finite();
const amount = z.union([
  finite.nonnegative(),
  z.string().regex(/^\d+(?:\.\d+)?$/),
]);
const line = z.object({
  ingredientId: z.uuid(),
  percent: finite.min(0).max(100),
  min: finite.min(0).max(100).optional(),
  max: finite.min(0).max(100).optional(),
  availableKg: finite.nonnegative().optional(),
});
const range = z
  .object({
    min: finite.nonnegative().optional(),
    max: finite.nonnegative().optional(),
  })
  .refine(
    (r) =>
      (r.min !== undefined || r.max !== undefined) &&
      (r.min ?? 0) <= (r.max ?? Infinity),
  );
const profile = z
  .object({
    id: z.uuid(),
    name: z.string(),
    revision: z.number().int().positive().optional(),
    species: z.string().min(1),
    stage: z.string().min(1),
    basis: z.string().min(1),
    energy_system: z.string().min(1),
    phosphorus_basis: z.string().min(1),
    source: z.string(),
    limits: z.partialRecord(z.enum(nutrientKeys), range),
    ingredient_rules: z
      .array(
        z.object({
          ingredientId: z.uuid(),
          min: finite,
          max: finite,
          source: z.string(),
        }),
      )
      .default([]),
    processing_rules: processingRules.default([]),
  })
  .passthrough();
const reference = z
  .object({
    id: z.uuid(),
    name: z.string(),
    revision: z.number().int().positive().optional(),
    price: amount.nullable(),
    source: z.string(),
    quoted_on: z.string().nullable().optional(),
    processing_method: z.string().nullable().optional(),
    processing_evidence: z.string().nullable().optional(),
    supplier: z.string().nullable().optional(),
    certificate_reference: z.string().nullable().optional(),
  })
  .passthrough();
const input = z.object({
  name: z.string(),
  batchKg: finite.positive().max(1e8),
  profileId: z.uuid(),
  lines: z.array(line).min(1).max(100),
  ingredientSnapshot: z.array(reference).min(1).max(100),
  profileSnapshot: profile,
  modelVersion: z.number().int().optional(),
  nutrientDefinitions: z
    .array(
      z.object({
        key: z.enum(nutrientKeys),
        label: z.string(),
        unit: z.string(),
        basis: z.string(),
      }),
    )
    .optional(),
});
const solution = z.object({
  objective: finite.nonnegative(),
  lines: z.array(line).min(1).max(100),
  calculation: z.object({
    costPerKg: amount,
    nutrients: z.partialRecord(
      z.enum(nutrientKeys),
      finite.nonnegative().nullable(),
    ),
  }),
});
export type RunRecord = {
  id: string;
  created_at: string | Date;
  request: unknown;
  result: unknown;
};
const contextKeys = [
  "species",
  "stage",
  "basis",
  "energy_system",
  "phosphorus_basis",
] as const;
export const comparisonNotice =
  "Historical planning comparison only. Scaling costs and quantities does not re-solve stock or other constraints at the comparison batch. Different specifications and candidate sets may change outcomes; a lower cost is not a recommended or approved formula.";
function normalized(record: RunRecord, batchKg: number) {
  const parsed = input.safeParse(record.request),
    view = outcomeView(record.result);
  const summary = runSummary(record);
  const valid =
    parsed.success &&
    parsed.data.profileSnapshot.id === parsed.data.profileId &&
    new Set(parsed.data.lines.map((l) => l.ingredientId)).size ===
      parsed.data.lines.length &&
    new Set(parsed.data.ingredientSnapshot.map((i) => i.id)).size ===
      parsed.data.ingredientSnapshot.length &&
    parsed.data.lines.every((l) =>
      parsed.data.ingredientSnapshot.some((i) => i.id === l.ingredientId),
    );
  const request = valid ? parsed.data : null;
  const solved = solution.safeParse(record.result);
  const allocationValid =
    request &&
    view?.status === "optimal" &&
    solved.success &&
    solved.data.lines.length === request.lines.length &&
    new Set(solved.data.lines.map((l) => l.ingredientId)).size ===
      solved.data.lines.length &&
    solved.data.lines.every((l) =>
      request.lines.some((i) => i.ingredientId === l.ingredientId),
    ) &&
    Math.abs(solved.data.lines.reduce((sum, l) => sum + l.percent, 0) - 100) <=
      1e-6;
  // Recheck historical snapshot cost without substituting today's references.
  let cost: Decimal | null = null;
  if (
    allocationValid &&
    solved.success &&
    request &&
    request.ingredientSnapshot.every((i) => i.price !== null)
  ) {
    const computed = solved.data.lines.reduce(
      (sum, l) =>
        sum.plus(
          new Decimal(l.percent)
            .div(100)
            .mul(
              request.ingredientSnapshot.find((i) => i.id === l.ingredientId)!
                .price!,
            ),
        ),
      new Decimal(0),
    );
    const recorded = new Decimal(solved.data.calculation.costPerKg);
    if (
      computed.minus(recorded).abs().lte("0.000051") &&
      computed
        .minus(solved.data.objective)
        .abs()
        .lte(Decimal.max("0.000001", computed.abs().mul("0.00000001")))
    )
      cost = recorded;
  }
  const usable = !!cost;
  const allocations =
    request?.lines.map((l) => {
      const ref = request.ingredientSnapshot.find(
        (i) => i.id === l.ingredientId,
      )!;
      const percent =
        usable && solved.success
          ? solved.data.lines.find((s) => s.ingredientId === l.ingredientId)!
              .percent
          : null;
      return {
        reference: ref,
        input: l,
        percent,
        originalKg:
          percent === null
            ? null
            : new Decimal(percent).div(100).mul(request.batchKg).toFixed(6),
        planningKg:
          percent === null
            ? null
            : new Decimal(percent).div(100).mul(batchKg).toFixed(6),
        deltaPercent: null as number | null,
      };
    }) ?? [];
  return {
    ...summary,
    costPerKg: cost?.toFixed(4) ?? null,
    batchCost: cost?.mul(batchKg).toFixed(4) ?? null,
    deltaCostPerKg: null as string | null,
    deltaBatchCost: null as string | null,
    originalBatchKg: request?.batchKg ?? null,
    profile: request?.profileSnapshot ?? null,
    modelVersion: request?.modelVersion ?? null,
    evidenceIssue: !request
      ? "Incomplete historical reference/specification evidence."
      : !view
        ? "Unreadable historical outcome."
        : view.status === "optimal" && !usable
          ? "Incomplete or inconsistent historical solution/cost evidence."
          : null,
    allocations,
    view,
    nutrients:
      usable && solved.success ? solved.data.calculation.nutrients : null,
    definitions: request?.nutrientDefinitions ?? null,
  };
}
export function compareOptimizationRuns(records: RunRecord[], batchKg: number) {
  if (
    records.length < 2 ||
    records.length > 4 ||
    new Set(records.map((r) => r.id)).size !== records.length ||
    !Number.isFinite(batchKg) ||
    batchKg <= 0 ||
    batchKg > 1e8
  )
    throw Error(
      "Choose two to four distinct runs and a valid comparison batch.",
    );
  const runs = records.map((r) => normalized(r, batchKg)),
    baseline = runs[0];
  for (const run of runs) {
    if (run.costPerKg !== null && baseline.costPerKg !== null) {
      run.deltaCostPerKg = new Decimal(run.costPerKg)
        .minus(baseline.costPerKg)
        .toFixed(4);
      run.deltaBatchCost = new Decimal(run.deltaCostPerKg)
        .mul(batchKg)
        .toFixed(4);
    }
    for (const allocation of run.allocations) {
      const base = baseline.allocations.find(
        (a) => a.reference.id === allocation.reference.id,
      );
      // Not offered/omitted is distinct from a solved zero allocation.
      if (
        allocation.percent !== null &&
        base?.percent !== null &&
        base?.percent !== undefined
      )
        allocation.deltaPercent = new Decimal(allocation.percent)
          .minus(base.percent)
          .toNumber();
    }
  }
  const nutrients = nutrientKeys
    .filter((key) =>
      runs.some(
        (r) =>
          (r.nutrients && Object.hasOwn(r.nutrients, key)) ||
          !!r.profile?.limits[key],
      ),
    )
    .map((key) => ({
      key,
      label: nutrientLabels[key],
      values: runs.map((run) => {
        const actual = run.nutrients?.[key] ?? null,
          base = baseline.nutrients?.[key] ?? null;
        const sameContext =
          !!run.profile &&
          !!baseline.profile &&
          contextKeys.every(
            (k) =>
              run.profile![k] === baseline.profile![k] &&
              !["unknown", ""].includes(run.profile![k]),
          );
        const def = run.definitions?.find((d) => d.key === key),
          baseDef = baseline.definitions?.find((d) => d.key === key);
        const sameDefinition =
          !!def &&
          !!baseDef &&
          def.unit === baseDef.unit &&
          def.basis === baseDef.basis;
        const comparable =
          actual !== null && base !== null && sameContext && sameDefinition;
        const limit = run.profile?.limits[key] ?? null;
        return {
          runId: run.id,
          actual,
          limit,
          delta: comparable ? new Decimal(actual).minus(base).toNumber() : null,
          deltaReason: comparable
            ? null
            : actual === null || base === null
              ? "Unknown or unavailable outcome."
              : !sameContext
                ? "Different or unknown scientific context."
                : "Nutrient definitions were not recorded or differ.",
          // Evaluate only this saved run's own recorded limits, never the baseline's.
          check: !limit
            ? "unassessed"
            : actual === null
              ? "unknown"
              : actual < (limit.min ?? -Infinity) - 1e-7 ||
                  actual > (limit.max ?? Infinity) + 1e-7
                ? "fail"
                : "pass",
        };
      }),
    }));
  return {
    modelVersion: 1,
    baselineId: baseline.id,
    batchKg,
    currency: "NGN",
    notice: comparisonNotice,
    runs,
    nutrients,
  };
}
export type OptimizationComparison = ReturnType<typeof compareOptimizationRuns>;
export function optimizationComparisonSheets(
  c: OptimizationComparison,
  organizationId: string,
  digest: string,
): ReportSheet[] {
  const rows: ReportSheet["rows"] = [
    ["HISTORICAL OPTIMIZER SCENARIO COMPARISON"],
    ["Organization", organizationId],
    ["Evidence SHA-256", digest],
    ["Baseline run", c.baselineId],
    ["Comparison batch kg", c.batchKg],
    ["Scope", c.notice],
    [],
    [
      "Run",
      "Name",
      "Saved",
      "Status",
      "Original batch kg",
      "Historical NGN/kg",
      "Planning cost NGN",
      "Delta NGN/kg",
      "Delta planning cost NGN",
      "Profile UUID",
      "Profile revision",
      "Species",
      "Stage",
      "Nutrient basis",
      "Energy system",
      "Phosphorus basis",
      "Solver",
      "Evidence issue",
    ],
  ];
  for (const r of c.runs)
    rows.push([
      r.id,
      r.name,
      r.createdAt,
      r.status,
      r.originalBatchKg,
      r.costPerKg,
      r.batchCost,
      r.deltaCostPerKg,
      r.deltaBatchCost,
      r.profile?.id ?? null,
      r.profile?.revision ?? null,
      r.profile?.species ?? null,
      r.profile?.stage ?? null,
      r.profile?.basis ?? null,
      r.profile?.energy_system ?? null,
      r.profile?.phosphorus_basis ?? null,
      r.solver,
      r.evidenceIssue,
    ]);
  const allocations: ReportSheet["rows"] = [
    [
      "Run",
      "Exact reference",
      "Name",
      "Revision",
      "Historical price NGN/kg",
      "Quotation date",
      "Input %",
      "Scenario min %",
      "Scenario max %",
      "Available kg",
      "Solution %",
      "Original kg",
      "Planning kg",
      "Delta percentage points",
      "Effective min %",
      "Effective max %",
      "Bound sources",
      "Recorded method",
      "Method evidence",
      "Source",
      "Supplier",
      "Certificate reference",
    ],
  ];
  const constraints: ReportSheet["rows"] = [
    [
      "Run",
      "Constraint kind",
      "Name / reference",
      "Exact members",
      "Minimum",
      "Maximum",
      "Actual %",
      "Saved check",
      "Required method",
      "Evidence",
    ],
  ];
  const evidence: ReportSheet["rows"] = [["Run", "Evidence kind", "Detail"]];
  for (const r of c.runs) {
    for (const a of r.allocations) {
      const b = r.view?.effectiveBounds.find(
        (b) => b.ingredientId === a.reference.id,
      );
      allocations.push([
        r.id,
        a.reference.id,
        a.reference.name,
        a.reference.revision ?? null,
        a.reference.price,
        a.reference.quoted_on ?? null,
        a.input.percent,
        a.input.min ?? null,
        a.input.max ?? null,
        a.input.availableKg ?? null,
        a.percent,
        a.originalKg,
        a.planningKg,
        a.deltaPercent,
        b?.min ?? null,
        b?.max ?? null,
        b
          ? JSON.stringify({ min: b.minimumSources, max: b.maximumSources })
          : null,
        a.reference.processing_method ?? null,
        a.reference.processing_evidence ?? null,
        a.reference.source,
        a.reference.supplier ?? null,
        a.reference.certificate_reference ?? null,
      ]);
    }
    for (const rule of r.profile?.ingredient_rules ?? [])
      constraints.push([
        r.id,
        "Reviewed ingredient",
        rule.ingredientId,
        null,
        rule.min,
        rule.max,
        null,
        null,
        null,
        rule.source,
      ]);
    for (const rule of r.profile?.processing_rules ?? []) {
      const check = r.view?.processingGroups.find((g) => g.name === rule.name);
      constraints.push([
        r.id,
        "Processing group",
        rule.name,
        rule.ingredientIds.join(", "),
        rule.minPercent,
        rule.maxPercent,
        check?.actualPercent ?? null,
        check?.status ?? "Not recorded",
        rule.requiredMethod,
        rule.source,
      ]);
    }
    evidence.push(
      [r.id, "Profile source", r.profile?.source ?? null],
      [r.id, "Request model version", r.modelVersion],
      [r.id, "Solver message", r.view?.message ?? null],
    );
    if (r.view?.conflict) {
      const c = r.view.conflict;
      evidence.push(
        [
          r.id,
          "Conflict search",
          `${c.status}; ${c.termination}; ${c.checks}/${c.maxChecks} checks; tolerance ${c.tolerance}`,
        ],
        [
          r.id,
          "Fixed diagnostic background",
          "Exact selected candidates, 100% total and 0–100% inclusions. Original limits are unchanged. No diagnostic allocation is exported.",
        ],
      );
      for (const constraint of c.constraints)
        constraints.push([
          r.id,
          `Conflict ${constraint.kind}`,
          `${constraint.label} (${constraint.id}; ${constraint.unit})`,
          constraint.ingredientId ??
            constraint.ingredientIds?.join(", ") ??
            null,
          constraint.side === "min" ? constraint.value : null,
          constraint.side === "max" ? constraint.value : null,
          null,
          c.status,
          null,
          constraint.evidence ??
            constraint.origins
              ?.map((o) => `${o.source}: ${o.percent}%`)
              .join("; ") ??
            null,
        ]);
    }
    for (const diagnostic of r.view?.diagnostics ?? [])
      evidence.push([r.id, diagnostic.kind, diagnostic.message]);
    for (const binding of r.view?.bindingConstraints ?? [])
      evidence.push([r.id, "Binding constraint", binding]);
    if (r.view?.validation)
      for (const [key, value] of Object.entries(r.view.validation))
        evidence.push([r.id, key, value]);
  }
  const nutrients: ReportSheet["rows"] = [
    [
      "Run",
      "Nutrient",
      "Actual",
      "Own minimum",
      "Own maximum",
      "Own check",
      "Delta vs baseline",
      "Delta unavailable reason",
    ],
  ];
  for (const n of c.nutrients)
    for (const v of n.values)
      nutrients.push([
        v.runId,
        n.label,
        v.actual,
        v.limit?.min ?? null,
        v.limit?.max ?? null,
        v.check,
        v.delta,
        v.deltaReason,
      ]);
  return [
    { name: "Runs", rows, headerRows: [1, 8] },
    { name: "Allocations", rows: allocations, headerRows: [1] },
    { name: "Nutrients", rows: nutrients, headerRows: [1] },
    { name: "Constraints", rows: constraints, headerRows: [1] },
    { name: "Run evidence", rows: evidence, headerRows: [1] },
  ];
}
