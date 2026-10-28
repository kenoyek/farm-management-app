import { z } from "zod";
import Decimal from "decimal.js";
const count = z.number().int().min(0).max(100000000);
const common = {
  organizationId: z.uuid(),
  unitId: z.uuid(),
  eventId: z.uuid(),
  date: z.iso.date(),
  previousId: z.uuid().nullable(),
  reason: z.string().trim().min(10).max(2000),
  evidence: z.string().trim().min(3).max(2000),
};
export const layerAdjustmentInput = z.discriminatedUnion("kind", [
  z
    .object({
      ...common,
      kind: z.literal("daily"),
      baseRecordId: z.uuid().nullable(),
      mortality: count,
      eggs: count,
      cracked: count,
      feedKg: z
        .string()
        .regex(/^\d{1,9}(?:\.\d{1,6})?$/)
        .refine((v) => new Decimal(v).lte(100000000))
        .transform((v) => new Decimal(v).toFixed(6)),
      notes: z.string().max(2000),
    })
    .strict()
    .refine((v) => v.cracked <= v.eggs, "Cracked eggs exceed total eggs."),
  z
    .object({ ...common, kind: z.literal("census"), openingHens: count })
    .strict(),
]);
export type LayerAdjustmentInput = z.infer<typeof layerAdjustmentInput>;
export const layerAdjustment = z
  .object({
    id: z.uuid(),
    organization_id: z.uuid(),
    unit_id: z.uuid(),
    kind: z.enum(["daily", "census"]),
    observed_on: z.iso.date(),
    previous_id: z.uuid().nullable(),
    base_record_id: z.uuid().nullable(),
    mortality: count.nullable(),
    eggs: count.nullable(),
    cracked: count.nullable(),
    feed_kg: z.string().nullable(),
    notes: z.string().nullable(),
    opening_hens: count.nullable(),
    reason: z.string(),
    evidence: z.string(),
    created_by: z.uuid(),
    created_at: z.string(),
  })
  .passthrough();
export type LayerAdjustment = z.infer<typeof layerAdjustment>;
export function currentAdjustments(all: LayerAdjustment[]) {
  const superseded = new Set(all.map((a) => a.previous_id));
  return all.filter((a) => !superseded.has(a.id));
}
// Validate and apply exact full replacements. Source originals remain separately available.
export function effectiveLayerRecords<
  T extends {
    id: string;
    organization_id: string;
    unit_id: string;
    recorded_on: string;
    mortality: number;
    eggs: number;
    cracked: number;
    feed_kg: string | number;
    notes: string;
    created_at: string;
  },
>(
  originals: T[],
  adjustments: LayerAdjustment[],
  unit: { id: string; organization_id: string; stocked_on: string },
  to: string,
) {
  const ids = new Map(adjustments.map((a) => [a.id, a]));
  if (ids.size !== adjustments.length)
    throw Error("Duplicate adjustment evidence.");
  const roots = new Set<string>(),
    successors = new Set<string>();
  for (const a of adjustments) {
    if (
      a.unit_id !== unit.id ||
      a.organization_id !== unit.organization_id ||
      a.observed_on < unit.stocked_on ||
      a.observed_on > to
    )
      throw Error("Adjustment does not match this report source.");
    if (a.previous_id) {
      const p = ids.get(a.previous_id);
      if (
        !p ||
        p.id === a.id ||
        p.kind !== a.kind ||
        p.observed_on !== a.observed_on ||
        p.base_record_id !== a.base_record_id ||
        successors.has(p.id)
      )
        throw Error("Incomplete or branching adjustment history.");
      successors.add(p.id);
      const seen = new Set([a.id]);
      let cursor: LayerAdjustment | undefined = p;
      while (cursor) {
        if (seen.has(cursor.id)) throw Error("Cyclic adjustment history.");
        seen.add(cursor.id);
        cursor = cursor.previous_id ? ids.get(cursor.previous_id) : undefined;
      }
    } else {
      const key = a.kind + ":" + a.observed_on;
      if (roots.has(key)) throw Error("Duplicate adjustment root.");
      roots.add(key);
    }
    if (a.kind === "daily") {
      const base = originals.find((r) => r.recorded_on === a.observed_on);
      if (
        (base?.id ?? null) !== a.base_record_id ||
        a.mortality === null ||
        a.eggs === null ||
        a.cracked === null ||
        a.feed_kg === null ||
        a.notes === null ||
        a.cracked > a.eggs ||
        a.opening_hens !== null ||
        !/^\d+(?:\.\d{1,6})?$/.test(a.feed_kg)
      )
        throw Error("Incomplete replacement evidence.");
    } else if (a.opening_hens === null || a.base_record_id !== null)
      throw Error("Incomplete opening census evidence.");
  }
  const heads = currentAdjustments(adjustments),
    byDate = new Map(originals.map((r) => [r.recorded_on, r]));
  for (const a of heads.filter((a) => a.kind === "daily")) {
    const base = byDate.get(a.observed_on);
    byDate.set(a.observed_on, {
      ...base,
      id: a.id,
      organization_id: a.organization_id,
      unit_id: a.unit_id,
      recorded_on: a.observed_on,
      mortality: a.mortality!,
      eggs: a.eggs!,
      cracked: a.cracked!,
      feed_kg: a.feed_kg!,
      notes: a.notes!,
      created_at: a.created_at,
    } as T);
  }
  return {
    records: [...byDate.values()].sort((a, b) =>
      a.recorded_on.localeCompare(b.recorded_on),
    ),
    censuses: heads
      .filter((a) => a.kind === "census")
      .sort((a, b) => a.observed_on.localeCompare(b.observed_on)),
  };
}

export function layerPopulation(
  records: { recorded_on: string; mortality: number }[],
  censuses: LayerAdjustment[],
  stockedOn: string,
  opening: number,
  to: string,
) {
  const ordinal = (d: string) => Date.parse(d + "T00:00:00Z") / 86400000;
  const stocked = ordinal(stockedOn),
    end = ordinal(to),
    ordinals = records.map((r) => ordinal(r.recorded_on));
  const anchors = [
    { date: stocked, count: opening, id: null as string | null },
    ...censuses.map((c) => ({
      date: ordinal(c.observed_on),
      count: c.opening_hens!,
      id: c.id,
    })),
  ]
    .filter((a, i, list) => !list.some((b, j) => j > i && b.date === a.date))
    .sort((a, b) => a.date - b.date);
  const lower = (n: number) => {
    let lo = 0,
      hi = ordinals.length;
    while (lo < hi) {
      const m = Math.floor((lo + hi) / 2);
      if (ordinals[m] < n) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  const prefix = [0];
  records.forEach((r, i) => prefix.push(prefix[i] + r.mortality));
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i],
      limit = anchors[i + 1]?.date ?? end + 1;
    if (prefix[lower(limit)] - prefix[lower(a.date)] > a.count)
      throw Error(
        "Recorded mortality exceeds the opening count within a census segment.",
      );
  }
  const openingAt = (ord: number) => {
    if (ord < stocked) return null;
    let lo = 0,
      hi = anchors.length;
    while (lo < hi) {
      const m = Math.floor((lo + hi) / 2);
      if (anchors[m].date <= ord) lo = m + 1;
      else hi = m;
    }
    const a = anchors[lo - 1];
    if (!a) return null;
    const first = lower(a.date),
      last = lower(ord);
    // Every intervening day must be observed; a physical count never fills missing feed or eggs.
    return last - first === ord - a.date
      ? a.count - (prefix[last] - prefix[first])
      : null;
  };
  let expected = stocked,
    firstGap: number | null = null;
  for (const ord of ordinals) {
    if (ord !== expected && firstGap === null) firstGap = expected;
    expected = ord + 1;
  }
  if (expected <= end && firstGap === null) firstGap = expected;
  return { openingAt, firstGap };
}
