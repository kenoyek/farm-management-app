import { broilerTreatments, type BroilerReview } from "./broiler-recovery";
import DecimalBase from "decimal.js";
const Decimal = DecimalBase.clone({ precision: 40 });
import { z } from "zod";
const decimal = (places: number, zero: boolean) =>
  z.string().refine((v) => {
    if (!new RegExp(`^(?:0|[1-9]\\d{0,8})(?:\\.\\d{1,${places}})?$`).test(v))
      return false;
    const n = new Decimal(v);
    return n.lte(1e8) && (zero || n.gt(0));
  }, "Enter a decimal within range and precision.");
const count = z.number().int().min(1).max(1e8);
const common = {
  organizationId: z.uuid(),
  unitId: z.uuid(),
  eventId: z.uuid(),
  date: z.iso.date(),
  expectedPosition: z.string().regex(/^(0|[1-9]\d{0,18})$/),
  expectedDailyId: z.uuid().nullable(),
  description: z.string().trim().min(3).max(2000),
  reason: z.string().trim().min(10).max(2000),
  evidence: z.string().trim().min(3).max(2000),
};
export const broilerEventInput = z.discriminatedUnion("kind", [
  z.strictObject({ ...common, kind: z.literal("health"), quantity: count }),
  z.strictObject({
    ...common,
    kind: z.literal("treatment"),
    quantity: count,
    product: z.string().trim().min(2).max(200),
    administration: z.string().trim().min(3).max(2000),
    earliestHarvestOn: z.iso.date().nullable(),
  }),
  z.strictObject({
    ...common,
    kind: z.literal("cull"),
    quantity: count,
    weightKg: decimal(6, false).nullable(),
  }),
  z
    .strictObject({
      ...common,
      kind: z.literal("harvest"),
      quantity: count,
      weightKg: decimal(6, false),
      priceBasis: z.enum(["unpriced", "bird", "kg"]),
      pricePerUnit: decimal(4, true).nullable(),
      reference: z.string().trim().min(3).max(100).nullable(),
      customer: z.string().trim().min(2).max(200).nullable(),
    })
    .refine(
      (v) =>
        v.priceBasis === "unpriced"
          ? v.pricePerUnit === null &&
            v.reference === null &&
            v.customer === null
          : v.pricePerUnit !== null &&
            v.reference !== null &&
            v.customer !== null,
      "Priced harvests need an explicit price, customer and unique reference; unpriced harvests leave these unknown.",
    )
    .refine((v) => {
      try {
        return (
          v.priceBasis === "unpriced" ||
          v.pricePerUnit === null ||
          new Decimal(v.priceBasis === "bird" ? v.quantity : v.weightKg)
            .mul(v.pricePerUnit)
            .toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
            .lt("10000000000000000")
        );
      } catch {
        return false;
      }
    }, "Harvest value exceeds supported money precision."),
  z.strictObject({ ...common, kind: z.literal("void"), voidOfId: z.uuid() }),
]);
export type BroilerInput = z.infer<typeof broilerEventInput>;
export type BroilerEvent = {
  id: string;
  organization_id: string;
  unit_id: string;
  kind: BroilerInput["kind"];
  recorded_on: string;
  position: string;
  quantity: number | null;
  weight_kg: string | null;
  description: string;
  product: string | null;
  administration: string | null;
  earliest_harvest_on: string | null;
  price_basis: "unpriced" | "bird" | "kg" | null;
  price_per_unit: string | null;
  amount: string | null;
  currency: string | null;
  reference: string | null;
  customer: string | null;
  void_of_id: string | null;
  reason: string;
  evidence: string;
  created_by: string;
  created_at: string;
  submission: BroilerInput;
};
export type BroilerUnit = {
  organization_id?: string;
  id: string;
  name: string;
  kind: string;
  stocked_on: string;
  opening_count: number;
  initial_weight_g: string;
};
export type BroilerDaily = {
  id: string;
  recorded_on: string;
  mortality: number;
  feed_kg: string;
  average_weight_g: string | null;
  sample_size: number | null;
};
export type BroilerSource = {
  unit: BroilerUnit;
  records: BroilerDaily[];
  originalRecords?: BroilerDaily[];
  reviews?: BroilerReview[];
  events: BroilerEvent[];
  timezone: string;
  today: string;
};
export function harvestAmount(
  quantity: number,
  weightKg: string,
  basis: "bird" | "kg",
  price: string,
) {
  const amount = new Decimal(basis === "bird" ? quantity : weightKg)
    .mul(price)
    .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  if (amount.gte("10000000000000000"))
    throw new RangeError("Harvest value exceeds supported money precision.");
  return amount.toFixed(4);
}
export function broilerSummary(s: BroilerSource) {
  const voids = new Set(s.events.map((e) => e.void_of_id).filter(Boolean));
  const active = s.events.filter((e) => e.kind !== "void" && !voids.has(e.id));
  const withdrawals = active.filter(
    (e) => e.kind === "cull" || e.kind === "harvest",
  );
  const mortality = s.records.reduce((n, r) => n + r.mortality, 0);
  const culled = withdrawals
    .filter((e) => e.kind === "cull")
    .reduce((n, e) => n + e.quantity!, 0);
  const harvested = withdrawals
    .filter((e) => e.kind === "harvest")
    .reduce((n, e) => n + e.quantity!, 0);
  const balance = s.unit.opening_count - mortality - culled - harvested;
  const lastDaily = s.records.at(-1),
    lastEvent = s.events.at(-1),
    sample = s.records.filter((r) => r.average_weight_g !== null).at(-1);
  const reviews = s.reviews ?? [];
  const treatments = broilerTreatments(s.events, reviews);
  const asOf = [
    s.unit.stocked_on,
    lastDaily?.recorded_on ?? "",
    lastEvent?.recorded_on ?? "",
    ...reviews.filter((r) => r.kind === "withdrawal").map((r) => r.observed_on),
  ]
    .sort()
    .at(-1)!;
  const feed = s.records.reduce((n, r) => n.plus(r.feed_kg), new Decimal(0));
  const measuredWithdrawalKg = withdrawals.reduce(
    (n, e) => n.plus(e.weight_kg ?? 0),
    new Decimal(0),
  );
  const unknownWithdrawalWeight = withdrawals.some((e) => e.weight_kg === null);
  const initial = new Decimal(s.unit.opening_count)
    .mul(s.unit.initial_weight_g)
    .div(1000);
  const closing =
    balance === 0
      ? new Decimal(0)
      : sample
        ? new Decimal(balance).mul(sample.average_weight_g!).div(1000)
        : null;
  const lastWithdrawal = withdrawals
    .map((e) => e.recorded_on)
    .sort()
    .at(-1);
  const totalDays =
    Math.round((Date.parse(asOf) - Date.parse(s.unit.stocked_on)) / 86400000) +
    1;
  const completeFeed =
    s.records.length === totalDays && lastDaily?.recorded_on === asOf;
  const reasons: string[] = [];
  if (!completeFeed)
    reasons.push(
      "Daily feed observations are missing from the stocking date through the last recorded activity.",
    );
  if (mortality > 0)
    reasons.push(
      "Dead-bird biomass is unknown; mortality-adjusted gain cannot be calculated.",
    );
  if (unknownWithdrawalWeight)
    reasons.push("At least one culled group has no measured total weight.");
  if (
    balance > 0 &&
    (!sample ||
      sample.recorded_on !== asOf ||
      (lastWithdrawal && sample.recorded_on <= lastWithdrawal))
  )
    reasons.push(
      "A representative remaining-bird sample is required after the last withdrawal, on the final observation date.",
    );
  const gain =
    closing === null ? null : closing.plus(measuredWithdrawalKg).minus(initial);
  if (gain === null || gain.lte(0))
    reasons.push("Positive cohort biomass gain is unavailable.");
  const sales: Record<string, string> = {};
  let unpricedHarvests = 0;
  for (const e of withdrawals.filter((e) => e.kind === "harvest")) {
    if (e.amount === null || e.currency === null) unpricedHarvests++;
    else
      sales[e.currency] = new Decimal(sales[e.currency] ?? 0)
        .plus(e.amount)
        .toFixed(4);
  }
  const holds = treatments.filter(
    (t) => t.earliest_harvest_on === null || t.earliest_harvest_on > s.today,
  );
  const harvestGuidance = active
    .filter((e) => e.kind === "harvest")
    .map((h) => {
      const before = s.events.filter(
        (t) =>
          t.kind === "treatment" &&
          BigInt(t.position) < BigInt(h.position) &&
          !s.events.some(
            (v) =>
              v.void_of_id === t.id && BigInt(v.position) < BigInt(h.position),
          ),
      );
      const recordedHolds = before
        .filter((t) => {
          const prior = reviews
            .filter(
              (r) =>
                r.kind === "withdrawal" &&
                r.treatment_id === t.id &&
                BigInt(r.position) < BigInt(h.position),
            )
            .at(-1);
          const earliest = prior
            ? prior.earliest_harvest_on
            : t.earliest_harvest_on;
          return earliest === null || earliest > h.recorded_on;
        })
        .map((t) => t.id);
      const currentConcerns = treatments
        .filter(
          (t) =>
            BigInt(t.position) < BigInt(h.position) &&
            (t.earliest_harvest_on === null ||
              t.earliest_harvest_on > h.recorded_on),
        )
        .map((t) => ({
          treatmentId: t.id,
          product: t.product,
          earliestHarvestOn: t.earliest_harvest_on,
          reviewId: t.review_id,
        }));
      return {
        harvestId: h.id,
        date: h.recorded_on,
        recordedHolds,
        currentConcerns,
      };
    });
  const populationEvidenceIssues = active
    .filter((e) => e.kind === "health" || e.kind === "treatment")
    .filter((e) => {
      const recorded =
        s.unit.opening_count -
        s.records
          .filter((r) => r.recorded_on <= e.recorded_on)
          .reduce((n, r) => n + r.mortality, 0) -
        withdrawals
          .filter(
            (w) =>
              w.recorded_on < e.recorded_on ||
              (w.recorded_on === e.recorded_on &&
                BigInt(w.position) < BigInt(e.position)),
          )
          .reduce((n, w) => n + w.quantity!, 0);
      return e.quantity! > recorded;
    })
    .map((e) => e.id);
  const voidable = active
    .filter(
      (e) =>
        !(e.kind === "cull" || e.kind === "harvest") ||
        (!s.records.some((r) => r.recorded_on > e.recorded_on) &&
          !active.some((n) => BigInt(n.position) > BigInt(e.position)) &&
          !reviews.some((r) => BigInt(r.position) > BigInt(e.position))),
    )
    .map((e) => e.id);
  const sampleDays = sample
    ? (Date.parse(sample.recorded_on) - Date.parse(s.unit.stocked_on)) /
      86400000
    : 0;
  const sampledAdgGPerDay =
    sample && sampleDays > 0
      ? new Decimal(sample.average_weight_g!)
          .minus(s.unit.initial_weight_g)
          .div(sampleDays)
          .toFixed(6)
      : null;
  return {
    sampledAdgGPerDay,
    initialBiomassKg: initial.toFixed(6),
    asOf,
    expectedPosition: [...s.events, ...reviews].reduce(
      (last, e) => (BigInt(e.position) > BigInt(last) ? e.position : last),
      "0",
    ),
    expectedDailyId: lastDaily?.id ?? null,
    balance,
    mortality,
    culled,
    harvested,
    feedKg: feed.toFixed(6),
    measuredWithdrawalKg: measuredWithdrawalKg.toFixed(6),
    estimatedClosingBiomassKg: closing?.toFixed(6) ?? null,
    latestSample: sample ?? null,
    completeFeed,
    cohortGainKg: gain?.toFixed(6) ?? null,
    fcr: reasons.length ? null : feed.div(gain!).toFixed(6),
    fcrUnavailableReasons: reasons,
    sales,
    unpricedHarvests,
    holds,
    treatments,
    harvestGuidance,
    populationEvidenceIssues,
    voidable,
  };
}
export type BroilerSnapshot = BroilerSource & {
  modelVersion: string;
  summary: ReturnType<typeof broilerSummary>;
  evidenceSha256: string;
};
export function broilerCsv(s: BroilerSnapshot) {
  const rows: unknown[][] = [
    ["Broiler lifecycle", s.modelVersion],
    ["Evidence SHA-256", s.evidenceSha256],
    ["Unit", s.unit.id, s.unit.name],
    ["Original unit source", JSON.stringify(s.unit)],
    ["Recorded through", s.summary.asOf],
    ["Recorded balance", s.summary.balance],
    ["FCR", s.summary.fcr],
    [
      "FCR scope",
      "Feed / (estimated remaining biomass + measured cull and live-harvest biomass - initial biomass). No unknown death biomass.",
    ],
    ["FCR unavailable reasons", s.summary.fcrUnavailableReasons.join(" ")],
    [
      "Sales values are recorded prices, not cash, profit, processed yield or veterinary clearance.",
    ],
    [],
    ["Original daily records"],
    [
      "ID",
      "Date",
      "Deaths",
      "Feed kg",
      "Sample average g",
      "Sample size",
      "Complete original source",
    ],
    ...(s.originalRecords ?? s.records).map((r) => [
      r.id,
      r.recorded_on,
      r.mortality,
      r.feed_kg,
      r.average_weight_g,
      r.sample_size,
      JSON.stringify(r),
    ]),
    [],
    ["Effective daily evidence"],
    [
      "ID",
      "Date",
      "Deaths",
      "Feed kg",
      "Sample average g",
      "Sample size",
      "Complete effective source",
    ],
    ...s.records.map((r) => [
      r.id,
      r.recorded_on,
      r.mortality,
      r.feed_kg,
      r.average_weight_g,
      r.sample_size,
      JSON.stringify(r),
    ]),
    [],
    ["Review history"],
    [
      "ID",
      "Position",
      "Type",
      "Observation / guidance review date",
      "Previous review",
      "Original daily ID",
      "Original treatment ID",
      "Deaths",
      "Feed kg",
      "Sample average g",
      "Sample size",
      "Notes",
      "Earliest harvest date",
      "Reason",
      "Evidence",
      "Actor",
      "Created at",
      "Complete immutable review",
    ],
    ...(s.reviews ?? []).map((r) => [
      r.id,
      r.position,
      r.kind,
      r.observed_on,
      r.previous_id,
      r.base_record_id,
      r.treatment_id,
      r.mortality,
      r.feed_kg,
      r.average_weight_g,
      r.sample_size,
      r.notes,
      r.earliest_harvest_on,
      r.reason,
      r.evidence,
      r.created_by,
      r.created_at,
      JSON.stringify(r),
    ]),
    [],
    ["Current treatment guidance"],
    [
      "Original treatment ID",
      "Product",
      "Administration date",
      "Original earliest harvest date",
      "Current earliest harvest date",
      "Latest review ID",
      "Review reason",
      "Review evidence",
    ],
    ...s.summary.treatments.map((t) => [
      t.id,
      t.product,
      t.recorded_on,
      t.original_earliest_harvest_on,
      t.earliest_harvest_on,
      t.review_id,
      t.review_reason,
      t.review_evidence,
    ]),
    [],
    ["Historical harvest guidance reconciliation"],
    [
      "Harvest ID",
      "Date",
      "Recorded holds at posting",
      "Current guidance concerns",
    ],
    ...s.summary.harvestGuidance.map((h) => [
      h.harvestId,
      h.date,
      h.recordedHolds.join(";"),
      JSON.stringify(h.currentConcerns),
    ]),
    [],
    ["Immutable lifecycle events"],
    [
      "ID",
      "Position",
      "Date",
      "Kind",
      "Birds",
      "Measured kg",
      "Description",
      "Product",
      "Administration",
      "Earliest harvest date",
      "Price basis",
      "Price per unit",
      "Amount",
      "Currency",
      "Reference",
      "Customer",
      "Voids event",
      "Reason",
      "Evidence",
      "Actor",
      "Created at",
      "Original submission",
    ],
    ...s.events.map((e) => [
      e.id,
      e.position,
      e.recorded_on,
      e.kind,
      e.quantity,
      e.weight_kg,
      e.description,
      e.product,
      e.administration,
      e.earliest_harvest_on,
      e.price_basis,
      e.price_per_unit,
      e.amount,
      e.currency,
      e.reference,
      e.customer,
      e.void_of_id,
      e.reason,
      e.evidence,
      e.created_by,
      e.created_at,
      JSON.stringify(e.submission),
    ]),
  ];
  return rows
    .map((row) =>
      row
        .map((value) => {
          let t = value == null ? "" : String(value);
          if (/^(?:\s*[=+\-@]|[\t\r\n])/.test(t)) t = "'" + t;
          return '"' + t.replaceAll('"', '""') + '"';
        })
        .join(","),
    )
    .join("\r\n");
}
