import DecimalBase from "decimal.js";
import { z } from "zod";
import {
  calculateBroilerPlan,
  broilerPlanModel,
  type PlanRow,
  type PlanReport,
} from "./broiler-planning";
const D = DecimalBase.clone({ precision: 40 });
export const budgetCategories = [
  "health",
  "litter",
  "labour",
  "utilities",
  "transport",
  "processing",
  "overhead",
  "other",
] as const;
export const budgetLabels: Record<(typeof budgetCategories)[number], string> = {
  health: "Medication and vaccination",
  litter: "Litter and housing",
  labour: "Labour",
  utilities: "Utilities",
  transport: "Transport and selling",
  processing: "Processing and packaging",
  overhead: "Allocated overhead, depreciation, finance and taxes",
  other: "Other attributable costs",
};
const decimal = (max: number, places: number) =>
  z
    .string()
    .refine(
      (v) =>
        new RegExp(`^(?:0|[1-9]\\d{0,8})(?:\\.\\d{1,${places}})?$`).test(v) &&
        new D(v).lte(max),
      "Enter a nonnegative decimal within range and precision.",
    )
    .transform((v) => new D(v).toFixed(places));
export const economicsData = z
  .strictObject({
    name: z.string().trim().min(2).max(100),
    saleBasis: z.enum(["bird", "liveKg", "processedKg"]),
    salePrice: decimal(1e8, 4).nullable(),
    yieldFraction: decimal(1, 8).nullable(),
    priceEvidence: z.string().trim().max(1000),
    yieldEvidence: z.string().trim().max(1000),
    allocationEvidence: z.string().trim().min(3).max(2000),
    completeBudget: z.boolean(),
    costs: z
      .array(
        z.strictObject({
          category: z.enum(budgetCategories),
          amount: decimal(1e8, 4).nullable(),
          evidence: z.string().trim().min(3).max(1000),
        }),
      )
      .length(budgetCategories.length),
    notes: z.string().max(2000),
  })
  .superRefine((v, c) => {
    if (
      new Set(v.costs.map((x) => x.category)).size !== budgetCategories.length
    )
      c.addIssue({
        code: "custom",
        message: "Supply each budget category exactly once.",
      });
    if (v.salePrice !== null && v.priceEvidence.length < 3)
      c.addIssue({
        code: "custom",
        message: "A sale price needs source evidence.",
      });
    if (
      v.saleBasis !== "processedKg" &&
      (v.yieldFraction !== null || v.yieldEvidence !== "")
    )
      c.addIssue({
        code: "custom",
        message: "Yield assumptions apply only to a processed-kg sale.",
      });
    if (
      v.saleBasis === "processedKg" &&
      v.yieldFraction !== null &&
      v.yieldEvidence.length < 3
    )
      c.addIssue({
        code: "custom",
        message: "A processed yield needs source evidence.",
      });
  });
export const economicsInput = z.strictObject({
  organizationId: z.uuid(),
  unitId: z.uuid(),
  scenarioId: z.uuid(),
  previousId: z.uuid().nullable(),
  planId: z.uuid(),
  data: economicsData,
});
export type EconomicsData = z.infer<typeof economicsData>;
export type EconomicsInput = z.infer<typeof economicsInput>;
export const economicsModel = "broiler-declared-budget-yield-v1";
export function projectEconomics(raw: EconomicsData, plan: PlanRow) {
  if (plan.model_version !== broilerPlanModel)
    throw Error("Unsupported source planning model.");
  const p = economicsData.parse(raw),
    { exact: x, forecast } = calculateBroilerPlan(
      plan.input,
      plan.unit_snapshot,
    );
  const costs = [
    {
      category: "chicks",
      label: "Chicks · original placement count",
      amount: x.chickCost,
      evidence: "Exact linked plan chick price × original placement count",
    },
    {
      category: "feed",
      label: "Feed · full planned period",
      amount: x.feedCost,
      evidence:
        "Exact linked plan daily opening-bird feed × stated stage prices",
    },
    ...budgetCategories.map((category) => {
      const row = p.costs.find((c) => c.category === category)!;
      return {
        category,
        label: budgetLabels[category],
        amount: row.amount === null ? null : new D(row.amount),
        evidence: row.evidence,
      };
    }),
  ];
  const missingCosts = costs
    .filter((c) => c.amount === null)
    .map((c) => c.category);
  const subtotal = costs.reduce((s, c) => s.plus(c.amount ?? 0), new D(0));
  const total = p.completeBudget && !missingCosts.length ? subtotal : null;
  const processed =
    p.saleBasis === "processedKg" &&
    x.biomass !== null &&
    p.yieldFraction !== null
      ? x.biomass.mul(p.yieldFraction)
      : null;
  const quantity =
    p.saleBasis === "bird"
      ? x.birds
      : p.saleBasis === "liveKg"
        ? x.biomass
        : processed;
  const revenue =
    quantity !== null && p.salePrice !== null
      ? quantity.mul(p.salePrice)
      : null;
  const margin =
    total !== null && revenue !== null ? revenue.minus(total) : null;
  const ratio = (n: DecimalBase | null, d: DecimalBase | null, places = 4) =>
    n !== null && d !== null && d.gt(0) ? n.div(d).toFixed(places) : null;
  const issues: string[] = [];
  if (!p.completeBudget)
    issues.push("The complete-budget allocation has not been confirmed.");
  if (missingCosts.length)
    issues.push("Unknown costs: " + missingCosts.join(", ") + ".");
  if (quantity === null)
    issues.push(
      "Sale quantity is unknown; review mortality and any processed-yield assumption.",
    );
  else if (quantity.isZero())
    issues.push("Sale quantity is zero; break-even sale price is undefined.");
  if (p.salePrice === null) issues.push("Sale price is unknown.");
  return {
    modelVersion: economicsModel,
    currency: plan.input.currency,
    plannedHarvestDate: forecast.plannedHarvestDate,
    expectedSaleBirds: x.birds?.toFixed(8) ?? null,
    expectedLiveKg: x.biomass?.toFixed(6) ?? null,
    expectedProcessedKg: processed?.toFixed(6) ?? null,
    saleBasis: p.saleBasis,
    saleQuantity: quantity?.toFixed(p.saleBasis === "bird" ? 8 : 6) ?? null,
    costs: costs.map((c) => ({ ...c, amount: c.amount?.toFixed(4) ?? null })),
    knownCostSubtotal: subtotal.toFixed(4),
    missingCosts,
    completeBudget: p.completeBudget,
    totalPlannedCost: total?.toFixed(4) ?? null,
    expectedRevenue: revenue?.toFixed(4) ?? null,
    projectedMargin: margin?.toFixed(4) ?? null,
    marginPercent:
      margin !== null && revenue !== null && revenue.gt(0)
        ? margin.div(revenue).mul(100).toFixed(6)
        : null,
    costPerSurvivingBird: ratio(total, x.birds),
    costPerLiveKg: ratio(total, x.biomass),
    costPerProcessedKg: ratio(total, processed),
    breakEvenSalePrice: ratio(total, quantity),
    issues,
  };
}
export type EconomicsRow = {
  id: string;
  organization_id: string;
  unit_id: string;
  previous_id: string | null;
  revision: number;
  plan_id: string;
  model_version: string;
  input: EconomicsData;
  plan_snapshot: PlanRow;
  created_by: string;
  created_at: string;
};
export type EconomicsReport = {
  source: EconomicsRow;
  plan: PlanReport;
  economics: ReturnType<typeof projectEconomics>;
  evidenceSha256: string;
};
export type EconomicsWorkspace = {
  plans: { id: string; revision: number; name: string; currency: string }[];
  history: {
    id: string;
    revision: number;
    name: string;
    plan_id: string;
    created_at: string;
  }[];
  selected: EconomicsReport | null;
};
export function compareEconomics(
  reports: EconomicsReport[],
  baselineId: string,
) {
  if (
    reports.length < 2 ||
    reports.length > 4 ||
    new Set(reports.map((r) => r.source.id)).size !== reports.length
  )
    throw Error("Select two to four distinct saved scenarios.");
  const baseline = reports.find((r) => r.source.id === baselineId);
  if (!baseline) throw Error("Choose a baseline from the selected scenarios.");
  if (
    reports.some(
      (r) =>
        r.source.unit_id !== baseline.source.unit_id ||
        r.economics.currency !== baseline.economics.currency,
    )
  )
    throw Error(
      "Comparison requires the same batch and original currency; currencies are never converted.",
    );
  const keys = [
    "totalPlannedCost",
    "expectedRevenue",
    "projectedMargin",
  ] as const;
  return {
    modelVersion: economicsModel,
    baselineId,
    currency: baseline.economics.currency,
    reports,
    comparisons: reports.map((r) => ({
      id: r.source.id,
      deltas: Object.fromEntries(
        keys.map((k) => [
          k,
          r.economics[k] !== null && baseline.economics[k] !== null
            ? new D(r.economics[k]!).minus(baseline.economics[k]!).toFixed(4)
            : null,
        ]),
      ),
      sameSaleBasis: r.economics.saleBasis === baseline.economics.saleBasis,
      samePlan: r.source.plan_id === baseline.source.plan_id,
    })),
    scope:
      "Whole linked batches at their own original duration, budget boundary and sale basis. No scaling, currency conversion, cash or actual profit. Review differences before interpreting deltas.",
  };
}
export type EconomicsComparison = ReturnType<typeof compareEconomics> & {
  evidenceSha256: string;
};
export function economicsCsv(report: EconomicsReport | EconomicsComparison) {
  const comparison = "reports" in report;
  const reports = comparison ? report.reports : [report];
  const rows: unknown[][] = [
    ["Broiler cost and yield planning", economicsModel],
    ["Evidence SHA-256", report.evidenceSha256],
    [
      "Planning assumptions only; no actual stock, sales, cash or costs are posted.",
    ],
  ];
  if (comparison)
    rows.push(
      ["Baseline", report.baselineId],
      ["Comparison scope", report.scope],
      ["Comparison source", JSON.stringify(report)],
    );
  for (const r of reports)
    rows.push(
      [],
      ["Scenario", r.source.id, "Revision", r.source.revision],
      ["Scenario name", r.source.input.name],
      ["Linked plan", r.source.plan_id],
      ["Currency", r.economics.currency],
      ["Immutable source", JSON.stringify(r.source)],
      ["Linked plan report", JSON.stringify(r.plan)],
      ["Scenario evidence SHA-256", r.evidenceSha256],
      ["Budget allocation", r.source.input.allocationEvidence],
      ["Cost category", "Budget amount", "Evidence"],
      ...r.economics.costs.map((c) => [c.label, c.amount, c.evidence]),
      [],
      ["Economic forecast"],
      ...Object.entries(r.economics)
        .filter(([k]) => !["costs", "issues", "missingCosts"].includes(k))
        .map(([k, v]) => [k, v]),
      ["Unknown cost categories", r.economics.missingCosts.join("; ")],
      ["Issues", r.economics.issues.join(" ")],
    );
  if (comparison)
    rows.push(
      [],
      [
        "Scenario",
        "Total cost delta",
        "Revenue delta",
        "Margin delta",
        "Same sale basis",
        "Same plan",
      ],
      ...report.comparisons.map((c) => [
        c.id,
        c.deltas.totalPlannedCost,
        c.deltas.expectedRevenue,
        c.deltas.projectedMargin,
        c.sameSaleBasis,
        c.samePlan,
      ]),
    );
  return rows
    .map((row) =>
      row
        .map((v) => {
          let s = v == null ? "" : String(v);
          if (/^(?:\s*[=+\-@]|[\t\r\n])/.test(s)) s = "'" + s;
          return '"' + s.replaceAll('"', '""') + '"';
        })
        .join(","),
    )
    .join("\r\n");
}
