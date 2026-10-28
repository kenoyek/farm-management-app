import { z } from "zod";
import Decimal from "decimal.js";
import { eggForecast } from "./forecast";
import type { ReportSheet } from "./recipe-reports";
const day = z.iso.date();
const finite = z.number().finite();
const amount = z.union([
  z.string().regex(/^\d+(?:\.\d+)?$/),
  finite.nonnegative(),
]);
export const layerReportInput = z
  .object({
    organizationId: z.uuid(),
    unitId: z.uuid(),
    from: day,
    to: day,
    traySize: z.number().int().min(1).max(1000),
    forecastId: z.uuid().nullable(),
  })
  .strict()
  .refine((i) => i.from <= i.to, "Report end precedes its start.");
export type LayerReportInput = z.infer<typeof layerReportInput>;
const unit = z
  .object({
    id: z.uuid(),
    organization_id: z.uuid(),
    farm_id: z.uuid(),
    name: z.string(),
    kind: z.literal("layers"),
    stocked_on: day,
    opening_count: z.number().int().positive(),
  })
  .passthrough();
const actual = z
  .object({
    id: z.uuid(),
    organization_id: z.uuid(),
    unit_id: z.uuid(),
    recorded_on: day,
    mortality: z.number().int().nonnegative(),
    eggs: z.number().int().nonnegative(),
    cracked: z.number().int().nonnegative(),
    feed_kg: amount,
    notes: z.string(),
    created_at: z.string(),
  })
  .passthrough()
  .refine((r) => r.cracked <= r.eggs);
const period = z.object({
  lay: finite.min(0).max(1),
  mortality: finite.min(0).max(1),
  cracks: finite.min(0).max(1),
});
const projectedRow = z.object({
  period: z.number().int().positive(),
  month: z.string(),
  days: z.number().int().positive(),
  opening: finite.nonnegative(),
  lay: finite,
  gross: finite.nonnegative(),
  cracked: finite.nonnegative(),
  saleable: finite.nonnegative(),
  trays: finite.nonnegative(),
  deaths: finite.nonnegative(),
  closing: finite.nonnegative(),
});
const forecast = z
  .object({
    id: z.uuid(),
    name: z.string(),
    kind: z.literal("layer-eggs"),
    organization_id: z.uuid(),
    created_at: z.string(),
    input: z
      .object({
        opening: finite.positive(),
        startMonth: z.string(),
        traySize: z.number().int().positive(),
        legacy28: z.boolean().optional(),
        periods: z.array(period).min(1).max(60),
      })
      .passthrough(),
    result: z
      .object({
        modelVersion: z.enum([
          "opening-stock-calendar-v1",
          "opening-stock-28day-v1",
        ]),
        rows: z.array(projectedRow),
        eggs: finite,
        saleable: finite,
        cracked: finite,
        trays: finite,
        closing: finite,
      })
      .passthrough(),
  })
  .passthrough();
export const layerSource = z.object({
  timezone: z.string(),
  unit,
  records: z.array(actual).max(10000),
  forecast: forecast.nullable(),
});
export type LayerSource = z.infer<typeof layerSource>;
const millis = 86400000;
export function dateOrdinal(value: string) {
  if (!day.safeParse(value).success) throw Error("Invalid calendar date.");
  const n = Date.parse(value + "T00:00:00Z");
  if (!Number.isFinite(n)) throw Error("Invalid calendar date.");
  return n / millis;
}
export const dateString = (ordinal: number) =>
  new Date(ordinal * millis).toISOString().slice(0, 10);
export function localDate(timezone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  return ["year", "month", "day"]
    .map((k) => parts.find((p) => p.type === k)!.value)
    .join("-");
}
const numericEqual = (a: number, b: number) =>
  Math.abs(a - b) <= Math.max(1e-7, Math.abs(a) * 1e-10);
function verifyForecast(f: NonNullable<LayerSource["forecast"]>) {
  const legacy = f.result.modelVersion === "opening-stock-28day-v1";
  if (f.input.legacy28 !== undefined && f.input.legacy28 !== legacy)
    throw Error("Saved forecast model and assumptions disagree.");
  const checked = eggForecast(
    f.input.opening,
    f.input.startMonth,
    f.input.periods,
    f.input.traySize,
    legacy,
  );
  if (checked.rows.length !== f.result.rows.length)
    throw Error("Incomplete saved forecast rows.");
  for (let i = 0; i < checked.rows.length; i++)
    for (const [key, value] of Object.entries(checked.rows[i])) {
      const stored =
        f.result.rows[i][key as keyof (typeof checked.rows)[number]];
      if (
        typeof value === "number"
          ? typeof stored !== "number" || !numericEqual(value, stored)
          : value !== stored
      )
        throw Error(
          "Saved forecast evidence is inconsistent with its recorded model.",
        );
    }
  for (const key of [
    "eggs",
    "cracked",
    "saleable",
    "trays",
    "closing",
  ] as const)
    if (!numericEqual(checked[key], f.result[key]))
      throw Error("Incomplete saved forecast totals.");
}
export function layerReport(
  input: LayerReportInput,
  raw: unknown,
  now = new Date(),
) {
  input = layerReportInput.parse(input);
  const source = layerSource.parse(raw),
    u = source.unit,
    records = [...source.records].sort((a, b) =>
      a.recorded_on.localeCompare(b.recorded_on),
    ),
    f = source.forecast;
  const from = dateOrdinal(input.from),
    to = dateOrdinal(input.to),
    stocked = dateOrdinal(u.stocked_on),
    today = localDate(source.timezone, now);
  if (from < stocked || to - from >= 366 || input.to > today)
    throw Error(
      "Choose up to 366 days from stocking through today in the organization timezone.",
    );
  if (
    u.id !== input.unitId ||
    u.organization_id !== input.organizationId ||
    (f?.id ?? null) !== input.forecastId ||
    (f && f.organization_id !== input.organizationId)
  )
    throw Error(
      "Report source does not match the selected organization, flock or forecast.",
    );
  if (
    new Set(records.map((r) => r.recorded_on)).size !== records.length ||
    records.some(
      (r) =>
        r.unit_id !== u.id ||
        r.organization_id !== u.organization_id ||
        r.recorded_on < u.stocked_on ||
        r.recorded_on > input.to,
    )
  )
    throw Error("Invalid daily-record source.");
  if (f) verifyForecast(f);
  const ordinals = records.map((r) => dateOrdinal(r.recorded_on)),
    deathsPrefix = [0];
  let expected = stocked,
    firstGap: number | null = null,
    recordedLive = u.opening_count;
  for (const [index, r] of records.entries()) {
    const ord = ordinals[index];
    deathsPrefix.push(deathsPrefix[index] + r.mortality);
    if (ord !== expected && firstGap === null) firstGap = expected;
    expected = ord + 1;
    recordedLive -= r.mortality;
    if (recordedLive < 0)
      throw Error("Recorded mortality exceeds the stocked flock.");
  }
  if (expected <= to && firstGap === null) firstGap = expected;
  const openingAt = (ord: number) => {
    if (ord < stocked || (firstGap !== null && ord > firstGap)) return null;
    let lo = 0,
      hi = ordinals.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (ordinals[mid] < ord) lo = mid + 1;
      else hi = mid;
    }
    return u.opening_count - deathsPrefix[lo];
  };
  const calendar = !!f && f.result.modelVersion === "opening-stock-calendar-v1",
    anchor = f ? f.input.startMonth + "-01" : null;
  const anchorOpening =
    anchor && dateOrdinal(anchor) <= to + 1
      ? openingAt(dateOrdinal(anchor))
      : null;
  const aligned =
    calendar &&
    anchorOpening !== null &&
    new Decimal(anchorOpening).equals(f!.input.opening);
  const reason = !f
    ? "No saved egg forecast selected."
    : !calendar
      ? "The legacy 28-day model has no calendar-day alignment."
      : anchorOpening === null
        ? "The flock population at the forecast start is unknown or outside this flock history."
        : !aligned
          ? "The saved forecast opening differs from the recorded flock opening at its start."
          : null;
  const projected = f
    ? new Map(f.result.rows.map((r) => [r.month, r]))
    : new Map<string, z.infer<typeof projectedRow>>();
  const byDate = new Map(records.map((r) => [r.recorded_on, r]));
  const rows = Array.from({ length: to - from + 1 }, (_, i) => {
    const ord = from + i,
      date = dateString(ord),
      r = byDate.get(date),
      opening = openingAt(ord),
      closing = r && opening !== null ? opening - r.mortality : null,
      p = calendar ? projected.get(date.slice(0, 7)) : undefined;
    const gross = p ? new Decimal(p.gross).div(p.days).toNumber() : null,
      cracked = p ? new Decimal(p.cracked).div(p.days).toNumber() : null,
      saleable = p ? new Decimal(p.saleable).div(p.days).toNumber() : null;
    const henDay =
      r && opening !== null && opening > 0
        ? new Decimal(r.eggs).div(opening).mul(100).toNumber()
        : null;
    const expectedRate =
      p && p.opening > 0
        ? new Decimal(p.gross).div(p.days).div(p.opening).mul(100).toNumber()
        : null;
    return {
      date,
      recordId: r?.id ?? null,
      recorded: !!r,
      openingHens: opening,
      closingHens: closing,
      mortality: r?.mortality ?? null,
      eggs: r?.eggs ?? null,
      cracked: r?.cracked ?? null,
      saleable: r ? r.eggs - r.cracked : null,
      feedKg: r ? new Decimal(r.feed_kg).toFixed(6) : null,
      henDays: r ? opening : null,
      henDayPercent: henDay,
      forecast: p
        ? {
            gross,
            cracked,
            saleable,
            openingHens: p.opening,
            henDayPercent: expectedRate,
          }
        : null,
      grossDelta:
        r && aligned && gross !== null && !(opening === 0 && r.eggs > 0)
          ? new Decimal(r.eggs).minus(gross).toNumber()
          : null,
      henDayDelta:
        aligned && henDay !== null && expectedRate !== null
          ? new Decimal(henDay).minus(expectedRate).toNumber()
          : null,
      issues:
        r && opening === 0 && r.eggs > 0
          ? ["Eggs were recorded without a positive opening flock."]
          : [],
    };
  });
  const present = rows.filter((r) => r.recorded),
    complete = present.length === rows.length,
    forecastComplete = rows.every((r) => r.forecast !== null);
  const recordedTotals = {
    eggs: present.reduce((n, r) => n + r.eggs!, 0),
    cracked: present.reduce((n, r) => n + r.cracked!, 0),
    saleable: present.reduce((n, r) => n + r.saleable!, 0),
    mortality: present.reduce((n, r) => n + r.mortality!, 0),
    feedKg: present
      .reduce((n, r) => n.plus(r.feedKg!), new Decimal(0))
      .toFixed(6),
  };
  const henDays =
    complete && rows.every((r) => r.henDays !== null)
      ? rows.reduce((n, r) => n + r.henDays!, 0)
      : null;
  const actualTotals = complete ? recordedTotals : null;
  const expectedTotals = forecastComplete
    ? {
        gross: rows
          .reduce((n, r) => n.plus(r.forecast!.gross!), new Decimal(0))
          .toNumber(),
        cracked: rows
          .reduce((n, r) => n.plus(r.forecast!.cracked!), new Decimal(0))
          .toNumber(),
        saleable: rows
          .reduce((n, r) => n.plus(r.forecast!.saleable!), new Decimal(0))
          .toNumber(),
      }
    : null;
  const issues = [
    ...(henDays === 0
      ? [
          "The window has no positive hen-days; a hen-day percentage is undefined.",
        ]
      : []),
    ...(firstGap !== null
      ? [
          `Missing daily history begins ${dateString(firstGap)}. Later flock denominators remain unknown.`,
        ]
      : []),
    ...(!complete
      ? [
          "Selected-window totals and full-window variances are unavailable because daily records are missing.",
        ]
      : []),
    ...(reason ? [reason] : []),
    ...(f && calendar && !forecastComplete
      ? ["Some selected days lie outside the saved calendar forecast."]
      : []),
    ...(input.to === today
      ? [
          "Today may still be in progress; this snapshot includes recorded totals only.",
        ]
      : []),
    ...rows.flatMap((r) => r.issues.map((s) => r.date + ": " + s)),
  ];
  return {
    modelVersion: "layer-hen-day-opening-v1",
    input,
    timezone: source.timezone,
    unit: {
      id: u.id,
      name: u.name,
      stockedOn: u.stocked_on,
      openingCount: u.opening_count,
    },
    basis:
      "Opening-of-day hens before recorded same-day deaths. Death times are not supplied; no within-day averaging is inferred. The stocked layer count is treated as hens without a sex or laying-age adjustment.",
    scope:
      "Recorded observations and the selected original forecast stay separate. No stock, sale or financial event is posted.",
    coverage: {
      days: rows.length,
      recordedDays: present.length,
      missingDates: rows.filter((r) => !r.recorded).map((r) => r.date),
      firstMissingHistory: firstGap === null ? null : dateString(firstGap),
      forecastDays: rows.filter((r) => r.forecast).length,
    },
    recordedTotals,
    actualTotals,
    henDays,
    henDayPercent:
      henDays !== null &&
      henDays > 0 &&
      rows.every((r) => r.issues.length === 0)
        ? new Decimal(recordedTotals.eggs).div(henDays).mul(100).toNumber()
        : null,
    wholeTrays: actualTotals
      ? Math.floor(actualTotals.saleable / input.traySize)
      : null,
    remainderEggs: actualTotals ? actualTotals.saleable % input.traySize : null,
    forecast: f
      ? {
          id: f.id,
          name: f.name,
          modelVersion: f.result.modelVersion,
          startMonth: f.input.startMonth,
          opening: f.input.opening,
          originalTraySize: f.input.traySize,
          flockOpeningAtForecastStart: anchorOpening,
          aligned,
          reason,
        }
      : null,
    expectedTotals,
    deltas:
      actualTotals &&
      expectedTotals &&
      aligned &&
      rows.every((r) => r.issues.length === 0)
        ? {
            gross: new Decimal(actualTotals.eggs)
              .minus(expectedTotals.gross)
              .toNumber(),
            cracked: new Decimal(actualTotals.cracked)
              .minus(expectedTotals.cracked)
              .toNumber(),
            saleable: new Decimal(actualTotals.saleable)
              .minus(expectedTotals.saleable)
              .toNumber(),
          }
        : null,
    issues,
    rows,
  };
}
export type LayerReport = ReturnType<typeof layerReport>;
export function layerReportSheets(
  report: LayerReport,
  digest: string,
  source: LayerSource,
): ReportSheet[] {
  const { input: i } = report;
  return [
    {
      name: "Layer report",
      headerRows: [1],
      rows: [
        [
          "Layer hen-day report",
          "Saved observations; forecasts remain estimates",
        ],
        ["Model", report.modelVersion],
        ["Organization", i.organizationId],
        ["Flock UUID", i.unitId],
        ["Flock", report.unit.name],
        ["From / to", `${i.from} / ${i.to}`],
        ["Timezone", report.timezone],
        ["Snapshot SHA-256", digest],
        ["Hen-day basis", report.basis],
        ["Scope", report.scope],
        [
          "Recorded days / selected days",
          `${report.coverage.recordedDays} / ${report.coverage.days}`,
        ],
        ["Hen-days", report.henDays],
        ["Weighted hen-day %", report.henDayPercent],
        ["Complete-window gross eggs", report.actualTotals?.eggs ?? null],
        ["Recorded gross egg subtotal", report.recordedTotals.eggs],
        ["Recorded cracked subtotal", report.recordedTotals.cracked],
        ["Recorded saleable subtotal", report.recordedTotals.saleable],
        ["Recorded feed kg subtotal", report.recordedTotals.feedKg],
        ["Complete-window tray size", i.traySize],
        [
          "Complete trays / remainder",
          report.wholeTrays === null
            ? null
            : `${report.wholeTrays} / ${report.remainderEggs}`,
        ],
        ["Forecast UUID", i.forecastId],
        ["Forecast model", report.forecast?.modelVersion ?? null],
        [
          "Forecast alignment",
          report.forecast?.reason ??
            (report.forecast ? "Aligned recorded opening population" : null),
        ],
        ["Forecast gross eggs", report.expectedTotals?.gross ?? null],
        ["Gross egg variance", report.deltas?.gross ?? null],
        ...report.issues.map((s) => ["Report issue", s]),
      ],
    },
    {
      name: "Daily hen-days",
      headerRows: [1],
      rows: [
        [
          "Date",
          "Record UUID",
          "Recorded",
          "Opening hens",
          "Deaths",
          "Closing hens",
          "Gross eggs",
          "Cracked",
          "Saleable",
          "Feed kg",
          "Hen-days",
          "Hen-day %",
          "Expected gross eggs",
          "Gross variance",
          "Expected hen-day %",
          "Hen-day delta pp",
        ],
        ...report.rows.map((r) => [
          r.date,
          r.recordId,
          r.recorded ? "yes" : "missing",
          r.openingHens,
          r.mortality,
          r.closingHens,
          r.eggs,
          r.cracked,
          r.saleable,
          r.feedKg,
          r.henDays,
          r.henDayPercent,
          r.forecast?.gross ?? null,
          r.grossDelta,
          r.forecast?.henDayPercent ?? null,
          r.henDayDelta,
        ]),
      ],
    },
    {
      name: "Actual source",
      headerRows: [1],
      rows: [
        [
          "Record UUID",
          "Date",
          "Deaths",
          "Eggs",
          "Cracked",
          "Feed kg",
          "Recorded at",
          "Original notes",
        ],
        ...source.records.map((r) => [
          r.id,
          r.recorded_on,
          r.mortality,
          r.eggs,
          r.cracked,
          String(r.feed_kg),
          r.created_at,
          r.notes,
        ]),
      ],
    },
    {
      name: "Forecast source",
      headerRows: [1],
      rows: [
        ["Selected saved forecast", source.forecast?.id ?? null],
        ["Name", source.forecast?.name ?? null],
        ["Saved at", source.forecast?.created_at ?? null],
        ["Original opening", source.forecast?.input.opening ?? null],
        ["Original tray size", source.forecast?.input.traySize ?? null],
        ["Original model", source.forecast?.result.modelVersion ?? null],
        [],
        [
          "Month",
          "Days",
          "Opening",
          "Lay fraction",
          "Gross",
          "Cracked",
          "Saleable",
          "Expected deaths",
          "Closing",
        ],
        ...(source.forecast?.result.rows ?? []).map((r) => [
          r.month,
          r.days,
          r.opening,
          r.lay,
          r.gross,
          r.cracked,
          r.saleable,
          r.deaths,
          r.closing,
        ]),
      ],
    },
  ];
}
