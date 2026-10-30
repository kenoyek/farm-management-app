import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { admin } from "./admin-db";
import { tenant, pool } from "../src/lib/db";
import { productionApi } from "../src/lib/production-api";
import {
  broilerEvidence,
  type BroilerSnapshot,
} from "../src/lib/broiler-lifecycle";
import type { BroilerLossInput } from "../src/lib/broiler-loss";
let owner: string,
  worker: string,
  auditor: string,
  outsider: string,
  org: string,
  foreign: string,
  farm: string,
  unit: string;
const post = async (actor: string, path: string, p: unknown) =>
  (await productionApi(
    new NextRequest("http://localhost/api/" + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(p),
    }),
    { id: actor },
    path,
  ))!;
const get = async (actor = owner, u = unit, format = "json") =>
  (await productionApi(
    new NextRequest(
      `http://localhost/api/broilers/lifecycle?organizationId=${org}&unitId=${u}&format=${format}`,
    ),
    { id: actor },
    "broilers/lifecycle",
  ))!;
const snapshot = async (u = unit, actor = owner): Promise<BroilerSnapshot> =>
  (await get(actor, u)).json();
async function stocked() {
  return (
    await (
      await post(owner, "units", {
        organizationId: org,
        farmId: farm,
        name: "Synthetic loss batch " + randomUUID(),
        kind: "broilers",
        stockedOn: "2024-02-01",
        openingCount: 100,
        initialWeightG: 1000,
      })
    ).json()
  ).id;
}
async function daily(
  date: string,
  mortality: number,
  feedKg: number,
  averageWeightG: number,
  u = unit,
) {
  await post(owner, "records", {
    organizationId: org,
    unitId: u,
    recordedOn: date,
    mortality,
    feedKg,
    averageWeightG,
    sampleSize: 10,
    eggs: 0,
    cracked: 0,
    waterQuality: null,
    notes: "Synthetic original loss observation",
  });
}
async function event(values: Record<string, unknown>, u = unit) {
  const h = await snapshot(u);
  return {
    organizationId: org,
    unitId: u,
    eventId: randomUUID(),
    date: h.summary.asOf,
    kind: "health",
    quantity: 1,
    description: "Synthetic source event",
    reason: "Synthetic actual source record",
    evidence: "Synthetic register",
    expectedPosition: h.summary.expectedPosition,
    expectedDailyId: h.summary.expectedDailyId,
    ...values,
  };
}
async function payload(
  kind: "daily" | "cull" = "daily",
  date = "2024-02-01",
  weightKg: string | null = "2.4",
  u = unit,
): Promise<BroilerLossInput> {
  const h = await snapshot(u),
    t = h.summary.lossEvidence.targets.find(
      (t) => t.kind === kind && t.date === date,
    )!;
  return {
    organizationId: org,
    unitId: u,
    reviewId: randomUUID(),
    kind,
    date,
    targetEventId: t.targetEventId,
    sourceId: t.sourceId,
    sourceCount: t.sourceCount,
    weightKg,
    measurementBasis: "whole-bird-at-loss",
    previousId: t.reviewId,
    expectedPosition: h.summary.expectedPosition,
    expectedDailyId: h.summary.expectedDailyId,
    reason: "Synthetic measured whole-bird loss mass",
    evidence: "Synthetic original scale record at loss",
  };
}
const loss = async (
  kind: "daily" | "cull" = "daily",
  date = "2024-02-01",
  weight: string | null = "2.4",
  u = unit,
) => post(owner, "broilers/loss-biomass", await payload(kind, date, weight, u));
async function correction(date: string, mortality: number, u = unit) {
  const h = await snapshot(u);
  return {
    organizationId: org,
    unitId: u,
    eventId: randomUUID(),
    kind: "daily",
    date,
    previousId:
      (h.reviews ?? [])
        .filter((r) => r.kind === "daily" && r.observed_on === date)
        .at(-1)?.id ?? null,
    baseRecordId:
      h.originalRecords?.find((r) => r.recorded_on === date)?.id ?? null,
    mortality,
    feedKg: "11",
    averageWeightG: "2000",
    sampleSize: 10,
    notes: "Synthetic full daily review",
    reason: "Synthetic corrected observed register",
    evidence: "Synthetic dated observation source",
    expectedPosition: h.summary.expectedPosition,
    expectedDailyId: h.summary.expectedDailyId,
  };
}
const direct = (
  actor: string,
  p: BroilerLossInput,
  extra = "",
  values: unknown[] = [],
) =>
  tenant(actor, (c) =>
    c.query(
      `INSERT INTO broiler_loss_reviews(id,organization_id,unit_id,kind,observed_on,target_event_id,source_id,source_count,weight_kg,measurement_basis,previous_id,expected_position,expected_daily_id,reason,evidence${extra}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15${values.map((_, i) => ",$" + (16 + i)).join("")}) RETURNING *`,
      [
        p.reviewId,
        p.organizationId,
        p.unitId,
        p.kind,
        p.date,
        p.targetEventId,
        p.sourceId,
        p.sourceCount,
        p.weightKg,
        p.measurementBasis,
        p.previousId,
        p.expectedPosition,
        p.expectedDailyId,
        p.reason,
        p.evidence,
        ...values,
      ],
    ),
  );
beforeAll(async () => {
  const ids = [];
  for (let i = 0; i < 4; i++)
    ids.push(
      (
        await admin.query(
          "INSERT INTO users(email,password_hash) VALUES($1,'fixture') RETURNING id",
          [randomUUID() + "@test.invalid"],
        )
      ).rows[0].id,
    );
  [owner, worker, auditor, outsider] = ids;
  org = (
    await tenant(owner, (c) =>
      c.query("SELECT create_organization('Synthetic measured losses') AS id"),
    )
  ).rows[0].id;
  foreign = (
    await tenant(outsider, (c) =>
      c.query("SELECT create_organization('Foreign measured losses') AS id"),
    )
  ).rows[0].id;
  await admin.query(
    "INSERT INTO memberships VALUES($1,$2,'worker'),($1,$3,'auditor')",
    [org, worker, auditor],
  );
  farm = (
    await tenant(owner, (c) =>
      c.query(
        "INSERT INTO farms(organization_id,name,kind) VALUES($1,'Synthetic loss farm','broilers') RETURNING id",
        [org],
      ),
    )
  ).rows[0].id;
  unit = await stocked();
  await daily("2024-02-01", 2, 10, 2000);
  await post(
    owner,
    "broilers/lifecycle",
    await event({ kind: "cull", quantity: 3, weightKg: null }),
  );
  await post(
    owner,
    "broilers/lifecycle",
    await event({
      kind: "harvest",
      quantity: 10,
      weightKg: "20",
      priceBasis: "kg",
      pricePerUnit: "3",
      reference: "SYNTHETIC-LOSS-HARVEST",
      customer: "Synthetic buyer",
    }),
  );
  await daily("2024-02-02", 1, 20, 2500);
});
afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])", [
    [org, foreign],
  ]);
  await admin.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
    [owner, worker, auditor, outsider],
  ]);
  await pool.end();
  await admin.end();
});
it("records exact measured loss evidence, unlocks complete cohort FCR and never repeats animal/feed/sale events", async () => {
  const before = await snapshot();
  expect(before.summary.fcr).toBeNull();
  for (const [kind, date, kg] of [
    ["daily", "2024-02-01", "2.4"],
    ["daily", "2024-02-02", "1.5"],
    ["cull", "2024-02-01", "4.5"],
  ] as const)
    expect((await loss(kind, date, kg)).status).toBe(201);
  const h = await snapshot();
  expect(h.summary).toMatchObject({
    balance: 84,
    mortality: 3,
    feedKg: "30.000000",
    measuredDeathKg: "3.900000",
    measuredWithdrawalKg: "24.500000",
    cohortGainKg: "138.400000",
    fcr: "0.216763",
    sales: { NGN: "60.0000" },
    asOf: "2024-02-02",
  });
  expect(h.events).toEqual(before.events);
  expect(h.originalRecords).toEqual(before.originalRecords);
  expect(h.records).toEqual(before.records);
  expect(h.lossReviews).toHaveLength(3);
  expect(h.lossReviews![0].source_snapshot).toMatchObject({
    id: h.records[0].id,
    mortality: 2,
    feed_kg: "10.000000",
  });
});
it("normalizes exact receipt retries and audits once while rejecting reuse for changed weight claims", async () => {
  const p = await payload();
  expect((await post(owner, "broilers/loss-biomass", p)).status).toBe(201);
  const audits = async () =>
      (
        await tenant(owner, (c) =>
          c.query(
            "SELECT count(*) FROM audit_logs WHERE organization_id=$1 AND action='broiler.loss_biomass_review'",
            [org],
          ),
        )
      ).rows[0].count,
    before = await audits();
  p.weightKg = "2.400000";
  expect((await post(owner, "broilers/loss-biomass", p)).status).toBe(200);
  expect(await audits()).toBe(before);
  await expect(
    post(owner, "broilers/loss-biomass", { ...p, weightKg: "9" }),
  ).rejects.toMatchObject({ status: 409 });
});
it("proves populated owner/auditor RLS versus outsiders and denies write roles or foreign source links", async () => {
  const p = await payload();
  expect((await snapshot(unit, auditor)).lossReviews!.length).toBeGreaterThan(
    0,
  );
  expect(
    (
      await tenant(outsider, (c) =>
        c.query("SELECT * FROM broiler_loss_reviews WHERE organization_id=$1", [
          org,
        ]),
      )
    ).rowCount,
  ).toBe(0);
  await expect(snapshot(unit, outsider)).rejects.toMatchObject({ status: 404 });
  for (const actor of [worker, auditor, outsider])
    await expect(post(actor, "broilers/loss-biomass", p)).rejects.toMatchObject(
      { status: 403 },
    );
  await expect(
    post(owner, "broilers/loss-biomass", { ...p, organizationId: foreign }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    post(owner, "broilers/loss-biomass", { ...p, sourceId: randomUUID() }),
  ).rejects.toMatchObject({ status: 409 });
  const other = await stocked();
  await expect(
    post(owner, "broilers/loss-biomass", {
      ...p,
      unitId: other,
      expectedPosition: "0",
      expectedDailyId: null,
    }),
  ).rejects.toMatchObject({ status: 404 });
});
it("serializes API reviews of distinct targets against the same combined loaded state", async () => {
  const a = await payload(),
    b = await payload("daily", "2024-02-02", "1.5"),
    r = await Promise.allSettled([
      post(owner, "broilers/loss-biomass", a),
      post(owner, "broilers/loss-biomass", b),
    ]);
  expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(r.find((x) => x.status === "rejected")).toMatchObject({
    reason: { status: 409 },
  });
});
it("invalidates mass after even a same-count daily replacement and requires a new source-linked confirmation", async () => {
  const before = await snapshot(),
    old = before
      .lossReviews!.filter(
        (r) => r.kind === "daily" && r.observed_on === "2024-02-01",
      )
      .at(-1)!;
  await post(owner, "broilers/recovery", await correction("2024-02-01", 2));
  const stale = await snapshot();
  expect(stale.summary).toMatchObject({
    balance: 84,
    measuredDeathKg: null,
    fcr: null,
    cohortGainKg: null,
  });
  expect(
    stale.summary.lossEvidence.targets.find(
      (t) => t.kind === "daily" && t.date === "2024-02-01",
    )?.state,
  ).toBe("stale");
  expect(stale.lossReviews!.find((r) => r.id === old.id)).toEqual(old);
  expect(stale.originalRecords).toEqual(before.originalRecords);
  await loss();
  const confirmed = await snapshot();
  expect(confirmed.summary).toMatchObject({
    feedKg: "31.000000",
    measuredDeathKg: "3.900000",
    fcr: "0.223988",
  });
  expect(confirmed.lossReviews!.at(-1)?.previous_id).toBe(old.id);
  expect(confirmed.lossReviews!.at(-1)?.source_id).toBe(
    confirmed.records[0].adjustment_id,
  );
});
it("rejects old count or source reuse after revised mortality instead of scaling an earlier measured total", async () => {
  const old = await payload();
  await post(owner, "broilers/recovery", await correction("2024-02-01", 3));
  const p = await payload();
  await expect(
    post(owner, "broilers/loss-biomass", { ...p, sourceCount: 2 }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    post(owner, "broilers/loss-biomass", { ...p, sourceId: old.sourceId }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(direct(owner, { ...p, sourceCount: 2 })).rejects.toMatchObject({
    code: "23514",
  });
  await loss("daily", "2024-02-01", "3.6");
  expect((await snapshot()).summary).toMatchObject({
    balance: 83,
    mortality: 4,
    measuredDeathKg: "5.100000",
    cohortGainKg: "137.100000",
    fcr: "0.226112",
  });
});
it("withdraws weight claims to explicit unknown and preserves an original cull measurement through later review and void", async () => {
  await loss("daily", "2024-02-01", null);
  expect((await snapshot()).summary.measuredDeathKg).toBeNull();
  await loss("daily", "2024-02-01", "3.6");
  const u = await stocked();
  await daily("2024-02-01", 0, 10, 2000, u);
  const e = await event({ kind: "cull", quantity: 2, weightKg: "3" }, u);
  await post(owner, "broilers/lifecycle", e);
  await loss("cull", "2024-02-01", null, u);
  let h = await snapshot(u);
  expect(h.events[0].weight_kg).toBe("3.000000");
  expect(h.summary.lossEvidence.targets[0]).toMatchObject({
    originalWeightKg: "3.000000",
    weightKg: null,
    state: "unknown",
  });
  expect(h.summary.fcr).toBeNull();
  await post(
    owner,
    "broilers/lifecycle",
    await event({ kind: "void", voidOfId: e.eventId, quantity: undefined }, u),
  );
  h = await snapshot(u);
  expect(h.summary.balance).toBe(100);
  expect(h.summary.lossEvidence.targets).toHaveLength(0);
  expect(h.summary.lossEvidence.history[0].status).toBe("inactive");
  expect(h.lossReviews).toHaveLength(1);
});
it("tracks backfilled daily loss chains by date when the effective backfill UUID changes", async () => {
  const u = await stocked();
  await daily("2024-02-02", 0, 10, 2500, u);
  await post(owner, "broilers/recovery", await correction("2024-02-01", 1, u));
  await loss("daily", "2024-02-01", "1.2", u);
  let h = await snapshot(u);
  const old = h.lossReviews![0];
  expect(old.source_id).toBe(h.records[0].id);
  expect(h.summary.fcr).not.toBeNull();
  await post(owner, "broilers/recovery", await correction("2024-02-01", 1, u));
  h = await snapshot(u);
  expect(h.summary.lossEvidence.targets[0].state).toBe("stale");
  await loss("daily", "2024-02-01", "1.2", u);
  h = await snapshot(u);
  expect(h.lossReviews!.at(-1)?.previous_id).toBe(old.id);
  expect(h.lossReviews!.at(-1)?.source_id).not.toBe(old.source_id);
  expect(h.originalRecords).toHaveLength(1);
});
it("enforces direct actor/time/shape/reference guards and derives snapshots/receipts independently of client claims", async () => {
  const p = await payload();
  for (const actor of [worker, auditor, outsider])
    await expect(direct(actor, p)).rejects.toHaveProperty("code");
  for (const [extra, values] of [
    [",created_by", [auditor]],
    [",created_at", ["2024-01-01"]],
  ] as const)
    await expect(direct(owner, p, extra, [...values])).rejects.toMatchObject({
      code: "42501",
    });
  for (const patch of [
    { sourceId: randomUUID() },
    { sourceCount: 1 },
    { weightKg: "0" },
    { weightKg: "-1" },
    { measurementBasis: "sample-estimate" },
    { targetEventId: randomUUID() },
  ])
    await expect(
      direct(owner, { ...p, ...patch } as BroilerLossInput),
    ).rejects.toHaveProperty("code");
  const row = (
    await direct(owner, p, ",source_snapshot,submission,position", [
      '{"mortality":999}',
      '{"profit":999}',
      999999,
    ])
  ).rows[0];
  expect(row.source_snapshot.mortality).toBe(3);
  expect(row.source_snapshot.id).toBe((await snapshot()).records[0].id);
  expect(row.submission.weightKg).toBe("2.400000");
  expect(row.submission.profit).toBeUndefined();
  expect(row.position).not.toBe("999999");
  for (const sql of [
    "UPDATE broiler_loss_reviews SET weight_kg=99 WHERE unit_id=$1",
    "DELETE FROM broiler_loss_reviews WHERE unit_id=$1",
  ])
    await expect(
      tenant(owner, (c) => c.query(sql, [unit])),
    ).rejects.toMatchObject({ code: "42501" });
  await expect(
    pool.query("SELECT * FROM broiler_loss_reviews LIMIT 1"),
  ).rejects.toMatchObject({ code: "42501" });
});
it("serializes distinct direct runtime targets under the combined event/recovery/weight position", async () => {
  const a = await payload(),
    b = await payload("daily", "2024-02-02", "1.5"),
    r = await Promise.allSettled([direct(owner, a), direct(owner, b)]);
  expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(r.find((x) => x.status === "rejected")).toMatchObject({
    reason: { code: "23505" },
  });
});
it("invalidates earlier lifecycle and recovery submissions after a weight review without advancing the actual activity date", async () => {
  const e = await event({}),
    r = await correction("2024-02-01", 3),
    before = await snapshot();
  await loss("daily", "2024-02-01", "3.6");
  await expect(post(owner, "broilers/lifecycle", e)).rejects.toMatchObject({
    status: 409,
  });
  await expect(post(owner, "broilers/recovery", r)).rejects.toMatchObject({
    status: 409,
  });
  const after = await snapshot();
  expect(after.summary.asOf).toBe(before.summary.asOf);
  expect(after.summary.expectedPosition).not.toBe(
    before.summary.expectedPosition,
  );
  expect(after.events).toEqual(before.events);
});
it("exports complete private source/review evidence with the v3 digest, current unknown states and safe spreadsheet text", async () => {
  const p = await payload();
  p.reason = "=Synthetic original measurement reference";
  await post(owner, "broilers/loss-biomass", p);
  const h = await snapshot(),
    r = await get(auditor, unit, "csv"),
    csv = await r.text();
  expect(h.modelVersion).toBe("broiler-reviewed-loss-biomass-v3");
  expect(h.evidenceSha256).toBe(
    createHash("sha256")
      .update(JSON.stringify(broilerEvidence(h)))
      .digest("hex"),
  );
  expect(r.headers.get("x-evidence-sha256")).toBe(h.evidenceSha256);
  expect(r.headers.get("cache-control")).toBe("private, no-store");
  expect(csv).toContain("'=Synthetic original measurement reference");
  expect(csv).toContain('"Complete original loss source"');
  for (const review of h.lossReviews!) expect(csv).toContain(review.source_id);
  const before = h.lossReviews;
  await tenant(owner, (c) =>
    c.query(
      "UPDATE organizations SET currency='USD',timezone='UTC' WHERE id=$1",
      [org],
    ),
  );
  expect((await snapshot()).lossReviews).toEqual(before);
  expect((await snapshot()).summary.sales).toEqual({ NGN: "60.0000" });
});
