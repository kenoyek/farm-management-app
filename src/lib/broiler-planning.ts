import DecimalBase from "decimal.js";
import { z } from "zod";
const D = DecimalBase.clone({ precision: 40 });
const dec = (max: number, places = 6, zero = true) =>
  z
    .string()
    .refine(
      (v) =>
        new RegExp(`^(?:0|[1-9]\\d{0,8})(?:\\.\\d{1,${places}})?$`).test(v) &&
        new D(v).lte(max) &&
        (zero || new D(v).gt(0)),
      "Enter a decimal within range and precision.",
    )
    .transform((v) => new D(v).toFixed(places));
const text = (max: number, min = 2) => z.string().trim().min(min).max(max);
export const broilerPlanData = z
  .strictObject({
    name: text(100),
    house: text(200).nullable(),
    strain: text(200).nullable(),
    supplier: text(200).nullable(),
    hatchDate: z.iso.date().nullable(),
    startingAgeDays: z.number().int().min(0).max(3650),
    harvestAgeDays: z.number().int().min(1).max(4015),
    chickCostPerBird: dec(1e8, 4).nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    targetMarketWeightG: dec(1e6, 6, false).nullable(),
    saleBasis: z.enum(["unpriced", "bird", "kg"]),
    salePrice: dec(1e8, 4).nullable(),
    sourceTitle: text(300, 3),
    sourceReference: text(2000, 3),
    notes: z.string().max(2000),
    stages: z
      .array(
        z.strictObject({
          stage: z.enum(["pre-starter", "starter", "grower", "finisher"]),
          startAge: z.number().int().min(0).max(4014),
          endAge: z.number().int().min(0).max(4014),
          rationG: dec(1000).nullable(),
          mortalityDaily: dec(1, 8).nullable(),
          pricePerKg: dec(1e8, 4).nullable(),
          recipeId: z.uuid().nullable(),
          tempMinC: dec(60).nullable(),
          tempMaxC: dec(60).nullable(),
          evidence: text(1000, 3),
        }),
      )
      .min(1)
      .max(24),
    targets: z
      .array(
        z.strictObject({
          ageDays: z.number().int().min(1).max(4015),
          weightG: dec(1e6, 6, false),
          evidence: text(1000, 3),
        }),
      )
      .min(1)
      .max(60),
  })
  .superRefine((v, c) => {
    if (
      v.harvestAgeDays <= v.startingAgeDays ||
      v.harvestAgeDays - v.startingAgeDays > 365
    )
      c.addIssue({
        code: "custom",
        message: "Harvest age must be 1–365 days after placement age.",
      });
    if ((v.saleBasis === "unpriced") !== (v.salePrice === null))
      c.addIssue({
        code: "custom",
        message: "Choose an explicit sale price or an unpriced forecast.",
      });
    let next = v.startingAgeDays;
    for (const s of v.stages) {
      if (s.startAge !== next || s.endAge < s.startAge)
        c.addIssue({
          code: "custom",
          message:
            "Stages must cover consecutive whole ages without gaps or overlaps.",
        });
      next = s.endAge + 1;
      if (
        (s.tempMinC === null) !== (s.tempMaxC === null) ||
        (s.tempMinC !== null &&
          s.tempMaxC !== null &&
          new D(s.tempMinC).gt(s.tempMaxC))
      )
        c.addIssue({
          code: "custom",
          message:
            "Supply both ordered guide temperature bounds or leave both unknown.",
        });
    }
    if (next !== v.harvestAgeDays)
      c.addIssue({
        code: "custom",
        message: "Stage feed days must end on the day before harvest age.",
      });
    let prior = v.startingAgeDays;
    for (const t of v.targets) {
      if (t.ageDays <= prior || t.ageDays > v.harvestAgeDays)
        c.addIssue({
          code: "custom",
          message:
            "Weight targets must have distinct increasing ages after placement, through harvest.",
        });
      prior = t.ageDays;
    }
    if (prior !== v.harvestAgeDays)
      c.addIssue({
        code: "custom",
        message: "Supply a weight target at the harvest age.",
      });
  });
export const broilerPlanInput = z.strictObject({
  organizationId: z.uuid(),
  unitId: z.uuid(),
  planId: z.uuid(),
  previousId: z.uuid().nullable(),
  data: broilerPlanData,
});
export type BroilerPlanData = z.infer<typeof broilerPlanData>;
export type BroilerPlanInput = z.infer<typeof broilerPlanInput>;
export type PlanUnit = {
  id: string;
  organization_id: string;
  farm_id: string;
  name: string;
  kind: string;
  stocked_on: string;
  opening_count: number;
  initial_weight_g: string;
};
export type RecipeLink = {
  id: string;
  name: string;
  status: string;
  batch_kg: string;
  profile_id: string | null;
  species: string | null;
  stage: string | null;
};
export type PlanRow = {
  id: string;
  organization_id: string;
  unit_id: string;
  previous_id: string | null;
  revision: number;
  model_version: string;
  input: BroilerPlanData;
  unit_snapshot: PlanUnit;
  recipe_snapshots: RecipeLink[];
  timezone: string;
  created_by: string;
  created_at: string;
};
export const broilerPlanModel = "broiler-daily-linear-targets-v1";
export function projectBroilerPlan(raw: BroilerPlanData, u: PlanUnit) {
  const p = broilerPlanData.parse(raw),
    start = Date.parse(u.stocked_on + "T00:00:00Z");
  if (
    p.hatchDate !== null &&
    (Date.parse(u.stocked_on) - Date.parse(p.hatchDate)) / 86400000 !==
      p.startingAgeDays
  )
    throw Error(
      "Hatch date and supplied placement age must match the original stocking date.",
    );
  const duration = p.harvestAgeDays - p.startingAgeDays,
    points = [
      { ageDays: p.startingAgeDays, weightG: u.initial_weight_g },
      ...p.targets,
    ];
  const weight = (age: number) => {
    const i = points.findIndex((t) => t.ageDays >= age);
    if (i === 0) return new D(points[0].weightG);
    const a = points[i - 1],
      b = points[i];
    return new D(a.weightG).plus(
      new D(b.weightG)
        .minus(a.weightG)
        .mul(age - a.ageDays)
        .div(b.ageDays - a.ageDays),
    );
  };
  let birds: DecimalBase | null = new D(u.opening_count),
    feed: DecimalBase | null = new D(0),
    cost: DecimalBase | null = new D(0),
    deaths: DecimalBase | null = new D(0);
  const rows = Array.from({ length: duration }, (_, i) => {
    const age = p.startingAgeDays + i,
      s = p.stages.find((s) => age >= s.startAge && age <= s.endAge)!,
      opening = birds;
    const dailyFeed =
      opening !== null && s.rationG !== null
        ? opening.mul(s.rationG).div(1000)
        : null;
    const dailyCost =
      dailyFeed !== null && s.pricePerKg !== null
        ? dailyFeed.mul(s.pricePerKg)
        : null;
    const lost =
      opening !== null && s.mortalityDaily !== null
        ? opening.mul(s.mortalityDaily)
        : null;
    birds = opening !== null && lost !== null ? opening.minus(lost) : null;
    feed = feed !== null && dailyFeed !== null ? feed.plus(dailyFeed) : null;
    cost = cost !== null && dailyCost !== null ? cost.plus(dailyCost) : null;
    deaths = deaths !== null && lost !== null ? deaths.plus(lost) : null;
    return {
      date: new Date(start + i * 86400000).toISOString().slice(0, 10),
      ageDays: age,
      stage: s.stage,
      openingBirds: opening?.toFixed(8) ?? null,
      targetWeightG: weight(age).toFixed(6),
      nextDayTargetWeightG: weight(age + 1).toFixed(6),
      dailyGainG: weight(age + 1)
        .minus(weight(age))
        .toFixed(6),
      feedKg: dailyFeed?.toFixed(6) ?? null,
      feedCost: dailyCost?.toFixed(4) ?? null,
      expectedDeaths: lost?.toFixed(8) ?? null,
      closingBirds: birds?.toFixed(8) ?? null,
      cumulativeFeedKg: feed?.toFixed(6) ?? null,
      cumulativeFeedCost: cost?.toFixed(4) ?? null,
      recipeId: s.recipeId,
      tempMinC: s.tempMinC,
      tempMaxC: s.tempMaxC,
    };
  });
  const finalWeight = weight(p.harvestAgeDays),
    biomass = birds === null ? null : birds.mul(finalWeight).div(1000),
    revenue =
      birds !== null && p.salePrice !== null
        ? (p.saleBasis === "bird" ? birds : biomass!).mul(p.salePrice)
        : null;
  return {
    modelVersion: broilerPlanModel,
    rows,
    durationDays: duration,
    plannedHarvestDate: new Date(start + duration * 86400000)
      .toISOString()
      .slice(0, 10),
    expectedClosingBirds: birds?.toFixed(8) ?? null,
    expectedDeaths: deaths?.toFixed(8) ?? null,
    harvestWeightG: finalWeight.toFixed(6),
    expectedHarvestBiomassKg: biomass?.toFixed(6) ?? null,
    feedKg: feed?.toFixed(6) ?? null,
    feedCost: cost?.toFixed(4) ?? null,
    chickCost:
      p.chickCostPerBird === null
        ? null
        : new D(u.opening_count).mul(p.chickCostPerBird).toFixed(4),
    expectedGrossLiveValue: revenue?.toFixed(4) ?? null,
    averageDailyGainG: finalWeight
      .minus(u.initial_weight_g)
      .div(duration)
      .toFixed(6),
    currency: p.currency,
  };
}
export type PlanReport = {
  source: PlanRow;
  forecast: ReturnType<typeof projectBroilerPlan>;
  evidenceSha256: string;
};
export type PlanWorkspace = {
  unit: PlanUnit;
  currency: string;
  timezone: string;
  today: string;
  history: { id: string; revision: number; name: string; created_at: string }[];
  selected: PlanReport | null;
  recipes: RecipeLink[];
  actualRecords: {
    recorded_on: string;
    feed_kg: string;
    average_weight_g: string | null;
    sample_size: number | null;
  }[];
};
export function planCsv(r: PlanReport) {
  const rows: unknown[][] = [
    ["Broiler planning forecast", r.forecast.modelVersion],
    ["Evidence SHA-256", r.evidenceSha256],
    ["Plan", r.source.id, "Revision", r.source.revision],
    ["Plan name", r.source.input.name],
    [
      "Planning assumptions only. No actual stock, feed, sale or cash is posted.",
    ],
    ["Currency", r.forecast.currency],
    ["Immutable source", JSON.stringify(r.source)],
    [],
    ["Daily forecast"],
    [
      "Date",
      "Age days",
      "Stage",
      "Expected opening birds",
      "Target opening weight g",
      "Next-day target g",
      "Daily target gain g",
      "Feed kg",
      "Feed cost",
      "Expected deaths",
      "Expected closing birds",
      "Cumulative feed kg",
      "Cumulative feed cost",
      "Recipe version",
      "Guide temperature min C",
      "Guide temperature max C",
    ],
    ...r.forecast.rows.map((x) => [
      x.date,
      x.ageDays,
      x.stage,
      x.openingBirds,
      x.targetWeightG,
      x.nextDayTargetWeightG,
      x.dailyGainG,
      x.feedKg,
      x.feedCost,
      x.expectedDeaths,
      x.closingBirds,
      x.cumulativeFeedKg,
      x.cumulativeFeedCost,
      x.recipeId,
      x.tempMinC,
      x.tempMaxC,
    ]),
    [],
    ["Harvest forecast"],
    ...Object.entries(r.forecast)
      .filter(([key]) => key !== "rows")
      .map(([k, v]) => [k, v]),
  ];
  return rows
    .map((row) =>
      row
        .map((v) => {
          let t = v == null ? "" : String(v);
          if (/^(?:\s*[=+\-@]|[\t\r\n])/.test(t)) t = "'" + t;
          return '"' + t.replaceAll('"', '""') + '"';
        })
        .join(","),
    )
    .join("\r\n");
}
