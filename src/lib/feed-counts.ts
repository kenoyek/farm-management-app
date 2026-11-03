import { z } from "zod";
import DecimalBase from "decimal.js";
import {
  feedStockDay,
  feedStockResults,
  feedWithdrawalValue,
  type FeedStockEvent,
} from "./feed-stock";
const D = DecimalBase.clone({
  precision: 40,
  rounding: DecimalBase.ROUND_HALF_UP,
});
export const feedCountModel = "weighed-feed-stocktake-v1";
const uuid = z.uuid().transform((v) => v.toLowerCase());
const reason = z.string().trim().min(10),
  evidence = z.string().trim().min(3);
export const feedCountData = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("count"),
    lotId: uuid,
    date: feedStockDay,
    previousId: uuid.nullable(),
    reference: z.string().trim().min(3).max(100),
    countedKg: z
      .string()
      .refine(
        (v) =>
          /^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/.test(v) && new D(v).lte(1e8),
        "Enter a nonnegative measured kg up to 100,000,000 with at most six decimals.",
      )
      .transform((v) => new D(v).toFixed(6)),
    scope: z.literal("actual-weighed-unused-feed-lot-count"),
    reason: reason.max(2000),
    evidence: evidence.max(2000),
  }),
  z.strictObject({
    kind: z.literal("resolve_shortage"),
    countId: uuid,
    scope: z.literal("approve-weighed-shortage-as-feed-loss"),
    reason: reason.max(1000),
    evidence: evidence.max(1500),
  }),
]);
export const feedCountInput = z.strictObject({
  organizationId: uuid,
  eventId: uuid,
  expectedStockPosition: z.string().regex(/^(0|[1-9]\d{0,18})$/),
  expectedCountPosition: z.string().regex(/^(0|[1-9]\d{0,18})$/),
  expectedSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  data: feedCountData,
});
export type FeedCountInput = z.infer<typeof feedCountInput>;
export type FeedCountData = z.infer<typeof feedCountData>;
export type FeedCountEvent = {
  id: string;
  organization_id: string;
  model_version: string;
  kind: FeedCountData["kind"];
  lot_id: string;
  count_id: string | null;
  previous_id: string | null;
  loss_event_id: string | null;
  position: string;
  expected_stock_position: string;
  expected_count_position: string;
  recorded_on: string;
  currency: string;
  recorded_kg: string;
  counted_kg: string;
  variance_kg: string;
  recorded_value: string | null;
  shortage_value: string | null;
  expected_source_sha256: string;
  source_sha256: string;
  input: FeedCountData;
  source_snapshot:
    FeedCountSource | { count: FeedCountEvent; loss: FeedStockEvent };
  submission: FeedCountInput;
  created_by: string;
  created_at: string;
};
export type FeedCountSource = {
  receipt: FeedStockEvent;
  events: FeedStockEvent[];
};
export function feedCountPreview(source: FeedCountSource, countedKg: string) {
  const lot = feedStockResults(source.events).lots.find(
    (l) => l.receipt.id === source.receipt.id,
  );
  if (!lot?.active) throw Error("An active original lot is required.");
  const counted = new D(countedKg);
  if (
    !counted.isFinite() ||
    counted.lt(0) ||
    counted.gt(1e8) ||
    !counted.eq(counted.toDecimalPlaces(6))
  )
    throw Error("Invalid weighed count quantity.");
  const variance = counted.minus(lot.balanceKg),
    shortage = variance.lt(0) ? variance.negated() : new D(0);
  return {
    lotId: source.receipt.id,
    currency: source.receipt.currency,
    recordedKg: lot.balanceKg,
    countedKg: counted.toFixed(6),
    varianceKg: variance.toFixed(6),
    classification: variance.lt(0)
      ? ("shortage" as const)
      : variance.gt(0)
        ? ("surplus" as const)
        : ("match" as const),
    recordedValue: lot.remainingValue,
    shortageKg: shortage.toFixed(6),
    shortageValue: shortage.gt(0)
      ? feedWithdrawalValue(
          lot.balanceKg,
          lot.remainingValue,
          shortage.toFixed(6),
        )
      : null,
    statement: variance.gt(0)
      ? "Unresolved surplus: investigate identity, ownership and source records. Available stock and cost are unchanged."
      : variance.lt(0)
        ? "Observation only. A manager must approve the current shortage before one physical loss is appended; Finance remains separate."
        : "Count matches recorded unused stock. No stock or financial entry is created.",
  };
}
export function feedCountResults(e: FeedCountEvent) {
  const count =
    e.kind === "count"
      ? e
      : (e.source_snapshot as { count: FeedCountEvent }).count;
  if (count.kind !== "count" || count.input.kind !== "count")
    throw Error("Incomplete immutable count authority.");
  const result = feedCountPreview(
    count.source_snapshot as FeedCountSource,
    count.input.countedKg,
  );
  if (
    result.recordedKg !== e.recorded_kg ||
    result.countedKg !== e.counted_kg ||
    result.varianceKg !== e.variance_kg ||
    result.recordedValue !== e.recorded_value ||
    result.shortageValue !== e.shortage_value ||
    result.currency !== e.currency ||
    result.lotId !== e.lot_id
  )
    throw Error("Saved count differs from its captured physical source.");
  if (e.kind === "resolve_shortage") {
    const loss = (e.source_snapshot as { loss: FeedStockEvent }).loss;
    if (
      result.classification !== "shortage" ||
      e.count_id !== count.id ||
      e.loss_event_id !== e.id ||
      loss.id !== e.id ||
      loss.kind !== "loss" ||
      loss.lot_id !== count.lot_id ||
      loss.recorded_on !== count.recorded_on ||
      loss.weight_kg !== result.shortageKg ||
      loss.amount !== result.shortageValue ||
      loss.currency !== count.currency ||
      loss.created_by !== e.created_by
    )
      throw Error("Approved count shortage differs from its derived loss.");
    return {
      ...result,
      appliedLossId: loss.id,
      statement:
        "Manager-approved shortage appended exactly one original-value physical loss. Financial recognition is separate.",
    };
  }
  return { ...result, appliedLossId: null };
}
export type FeedCountReport = {
  modelVersion: string;
  event: FeedCountEvent;
  results: ReturnType<typeof feedCountResults>;
  evidenceSha256: string;
};
export type FeedCountWorkspace = {
  today: string;
  expectedStockPosition: string;
  expectedCountPosition: string;
  lots: { id: string; label: string; balanceKg: string; currency: string }[];
  history: {
    id: string;
    kind: FeedCountData["kind"];
    lot_id: string;
    reference: string;
    recorded_on: string;
  }[];
  counts: {
    id: string;
    lotId: string;
    reference: string;
    date: string;
    varianceKg: string;
    recordedKg: string;
    countedKg: string;
    shortageValue: string | null;
    currency: string;
    classification: "shortage" | "surplus" | "match";
    sourceCurrent: boolean;
    resolutionId: string | null;
    lossActive: boolean;
    canResolve: boolean;
  }[];
  selected: {
    lotId: string;
    latestId: string | null;
    source: FeedCountSource | null;
    sourceSha256: string | null;
    sourceTooLarge: boolean;
  } | null;
  report: FeedCountReport | null;
};
export function feedCountCsv(r: FeedCountReport) {
  const rows: unknown[][] = [
    ["Weighed feed stocktake", r.modelVersion],
    ["Evidence SHA-256", r.evidenceSha256],
    ["Complete immutable event and source", JSON.stringify(r.event)],
    ["Complete results", JSON.stringify(r.results)],
    [
      "Reference",
      r.event.input.kind === "count"
        ? r.event.input.reference
        : (r.event.source_snapshot as { count: FeedCountEvent }).count.input
              .kind === "count"
          ? (
              (r.event.source_snapshot as { count: FeedCountEvent }).count
                .input as Extract<FeedCountData, { kind: "count" }>
            ).reference
          : "",
    ],
    ["Count date", r.event.recorded_on],
    ["Original currency", r.event.currency],
    [],
    ["Recorded kg", r.results.recordedKg],
    ["Counted kg", r.results.countedKg],
    ["Signed variance kg", r.results.varianceKg],
    ["Classification", r.results.classification],
    ["Original recorded value", r.results.recordedValue],
    ["Proposed/applied shortage kg", r.results.shortageKg],
    ["Original shortage value", r.results.shortageValue],
    ["Statement", r.results.statement],
  ];
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
