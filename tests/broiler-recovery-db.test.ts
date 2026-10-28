import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { admin } from "./admin-db";
import { tenant, pool } from "../src/lib/db";
import { productionApi } from "../src/lib/production-api";
import type { BroilerSnapshot } from "../src/lib/broiler-lifecycle";
let owner: string,
  worker: string,
  auditor: string,
  outsider: string,
  org: string,
  foreign: string,
  farm: string,
  unit: string,
  layer: string,
  treatment: string,
  harvest: string;
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
const snapshot = async (actor = owner, u = unit): Promise<BroilerSnapshot> =>
  (await get(actor, u)).json();
async function stock(kind = "broilers", count = 100) {
  return (
    await (
      await post(owner, "units", {
        organizationId: org,
        farmId: farm,
        name: "Synthetic recovery " + kind,
        kind,
        stockedOn: "2024-02-01",
        openingCount: count,
        initialWeightG: 1000,
      })
    ).json()
  ).id;
}
const daily = (
  date: string,
  mortality = 0,
  weight: number | null = 2000,
  u = unit,
  sample: number | null = weight ? 10 : null,
) =>
  post(owner, "records", {
    organizationId: org,
    unitId: u,
    recordedOn: date,
    mortality,
    eggs: 0,
    cracked: 0,
    feedKg: 10,
    averageWeightG: weight,
    sampleSize: sample,
    waterQuality: null,
    notes: "Synthetic immutable original observation",
  });
async function event(values: Record<string, unknown> = {}, u = unit) {
  const h = await snapshot(owner, u);
  return post(owner, "broilers/lifecycle", {
    organizationId: org,
    unitId: u,
    eventId: randomUUID(),
    date: h.summary.asOf,
    expectedPosition: h.summary.expectedPosition,
    expectedDailyId: h.summary.expectedDailyId,
    kind: "health",
    quantity: 1,
    description: "Synthetic observed actual event",
    reason: "Synthetic reviewed original register",
    evidence: "Synthetic dated actual source",
    ...values,
  });
}
async function review(values: Record<string, unknown> = {}, u = unit) {
  const h = await snapshot(owner, u),
    kind = (values.kind ?? "daily") as string,
    date = String(values.date ?? "2024-02-02");
  const previous = h.reviews!.find(
    (r) =>
      r.kind === kind &&
      (kind === "daily"
        ? r.observed_on === date
        : r.treatment_id === (values.treatmentId ?? treatment)) &&
      !h.reviews!.some((n) => n.previous_id === r.id),
  );
  return {
    organizationId: org,
    unitId: u,
    eventId: randomUUID(),
    kind,
    date,
    previousId: previous?.id ?? null,
    expectedPosition: h.summary.expectedPosition,
    expectedDailyId: h.summary.expectedDailyId,
    reason: "Synthetic reviewed recovery evidence",
    evidence: "Synthetic dated veterinary / daily register",
    ...(kind === "daily"
      ? {
          baseRecordId:
            h.originalRecords!.find((r) => r.recorded_on === date)?.id ?? null,
          mortality: 0,
          feedKg: "5.123456",
          averageWeightG: null,
          sampleSize: null,
          notes: "Synthetic reviewed daily source",
        }
      : { treatmentId: treatment, earliestHarvestOn: "2024-02-03" }),
    ...values,
  };
}
const save = async (values: Record<string, unknown> = {}, u = unit) =>
  (await post(owner, "broilers/recovery", await review(values, u))).json();
beforeAll(async () => {
  const users = [];
  for (let i = 0; i < 4; i++)
    users.push(
      (
        await admin.query(
          "INSERT INTO users(email,password_hash) VALUES($1,'fixture') RETURNING id",
          [randomUUID() + "@test.invalid"],
        )
      ).rows[0].id,
    );
  [owner, worker, auditor, outsider] = users;
  org = (
    await tenant(owner, (c) =>
      c.query("SELECT create_organization('Synthetic broiler recovery') AS id"),
    )
  ).rows[0].id;
  foreign = (
    await tenant(outsider, (c) =>
      c.query("SELECT create_organization('Foreign broiler recovery') AS id"),
    )
  ).rows[0].id;
  await admin.query(
    "INSERT INTO memberships VALUES($1,$2,'worker'),($1,$3,'auditor')",
    [org, worker, auditor],
  );
  farm = (
    await tenant(owner, (c) =>
      c.query(
        "INSERT INTO farms(organization_id,name,kind) VALUES($1,'Synthetic recovery farm','broilers') RETURNING id",
        [org],
      ),
    )
  ).rows[0].id;
  unit = await stock();
  layer = await stock("layers");
  await daily("2024-02-01", 1);
  treatment = (
    await (
      await event({
        kind: "treatment",
        quantity: 99,
        product: "Synthetic administered product",
        administration: "Synthetic actual administration and route",
        earliestHarvestOn: null,
      })
    ).json()
  ).id;
  await daily("2024-02-03", 2, 2500);
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
it("preserves a genuine unknown-date administration while appending reviewed guidance and admitting an expiry-date harvest", async () => {
  const before = await snapshot();
  expect(before.summary).toMatchObject({ balance: 97, fcr: null });
  await save({ kind: "withdrawal", date: "2024-02-03" });
  harvest = (
    await (
      await event({
        kind: "harvest",
        quantity: 10,
        weightKg: "25",
        priceBasis: "kg",
        pricePerUnit: "100.1234",
        reference: "SYNTHETIC-RECOVERY-HARVEST",
        customer: "Synthetic customer",
      })
    ).json()
  ).id;
  const h = await snapshot(auditor);
  expect(h.summary).toMatchObject({
    balance: 87,
    harvested: 10,
    sales: { NGN: "2503.0850" },
  });
  expect(h.events.find((e) => e.id === treatment)).toMatchObject({
    earliest_harvest_on: null,
    recorded_on: "2024-02-01",
    quantity: 99,
  });
  expect(h.summary.treatments[0]).toMatchObject({
    earliest_harvest_on: "2024-02-03",
    original_earliest_harvest_on: null,
  });
  expect(h.events.some((e) => e.void_of_id === treatment)).toBe(false);
  expect(h.summary.harvestGuidance[0]).toMatchObject({
    harvestId: harvest,
    recordedHolds: [],
    currentConcerns: [],
  });
});
it("backfills genuinely observed zero deaths without inventing a sample or overwriting original daily rows", async () => {
  const p = await review();
  await post(owner, "broilers/recovery", p);
  const h = await snapshot();
  expect(h.originalRecords).toHaveLength(2);
  expect(h.records).toHaveLength(3);
  expect(h.records[1]).toMatchObject({
    id: p.eventId,
    mortality: 0,
    feed_kg: "5.123456",
    average_weight_g: null,
    sample_size: null,
  });
  expect(h.summary).toMatchObject({
    balance: 87,
    feedKg: "25.123456",
    completeFeed: true,
    fcr: null,
  });
  await expect(daily("2024-02-02")).rejects.toMatchObject({ code: "23514" });
});
it("replaces full mortality, feed and nullable sampling values, updates all shared readers, preserves originals and prior reviews", async () => {
  const before = await snapshot();
  await save({
    date: "2024-02-01",
    mortality: 0,
    feedKg: "11",
    averageWeightG: "2000",
    sampleSize: 10,
  });
  await save({
    date: "2024-02-03",
    mortality: 0,
    feedKg: "20",
    averageWeightG: "2500",
    sampleSize: 10,
  });
  await daily("2024-02-04", 0, 2800);
  const h = await snapshot();
  expect(h.summary).toMatchObject({
    balance: 90,
    mortality: 0,
    cohortGainKg: "177.000000",
    feedKg: "46.123456",
    fcr: "0.260584",
  });
  expect(h.originalRecords!.slice(0, 2)).toEqual(before.originalRecords);
  expect(h.reviews).toHaveLength(4);
  const production = (await productionApi(
    new NextRequest("http://localhost/api/production?organizationId=" + org),
    { id: owner },
    "production",
  ))!;
  const prod = await production.json();
  expect(
    prod.units.find((u: { id: string }) => u.id === unit).recorded_balance,
  ).toBe("90");
  expect(
    prod.records.filter((r: { unit_id: string }) => r.unit_id === unit),
  ).toHaveLength(4);
  await save({
    date: "2024-02-04",
    mortality: 0,
    feedKg: "10",
    averageWeightG: null,
    sampleSize: null,
  });
  expect((await snapshot()).summary.fcr).toBeNull();
  expect((await snapshot()).records.at(-1)!.average_weight_g).toBeNull();
  expect((await snapshot()).originalRecords!.at(-1)!.average_weight_g).toBe(
    "2800.000000",
  );
});
it("retries the exact normalized review once without duplicate audit and rejects changed receipts", async () => {
  const p = await review({ date: "2024-02-02", feedKg: "5.25" });
  expect((await post(owner, "broilers/recovery", p)).status).toBe(201);
  const count = (
    await tenant(owner, (c) =>
      c.query("SELECT count(*) FROM audit_logs WHERE organization_id=$1", [
        org,
      ]),
    )
  ).rows[0].count;
  expect(
    (await post(owner, "broilers/recovery", { ...p, feedKg: "5.250000" }))
      .status,
  ).toBe(200);
  expect(
    (
      await tenant(owner, (c) =>
        c.query("SELECT count(*) FROM audit_logs WHERE organization_id=$1", [
          org,
        ]),
      )
    ).rows[0].count,
  ).toBe(count);
  await expect(
    post(owner, "broilers/recovery", { ...p, feedKg: "6" }),
  ).rejects.toMatchObject({ status: 409 });
});
it("rejects conflicting managers and stale lifecycle previews after recovery even when latest original daily ID stays unchanged", async () => {
  const h = await snapshot(),
    p = await review({ date: "2024-02-02" }),
    other = { ...p, eventId: randomUUID(), feedKg: "8" };
  const results = await Promise.allSettled([
    post(owner, "broilers/recovery", p),
    post(owner, "broilers/recovery", other),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { status: 409 },
  });
  await expect(
    post(owner, "broilers/lifecycle", {
      organizationId: org,
      unitId: unit,
      eventId: randomUUID(),
      date: "2024-02-04",
      expectedPosition: h.summary.expectedPosition,
      expectedDailyId: h.summary.expectedDailyId,
      kind: "health",
      quantity: 1,
      description: "Synthetic stale observation",
      reason: "Synthetic stale source review",
      evidence: "Synthetic register",
    }),
  ).rejects.toMatchObject({ status: 409 });
  const stale = await review();
  await daily("2024-02-05", 0, 2900);
  await expect(post(owner, "broilers/recovery", stale)).rejects.toMatchObject({
    status: 409,
  });
});
it("records later unknown/restrictive guidance, flags earlier harvest evidence, blocks new harvests and retains the complete revision chain", async () => {
  await save({
    kind: "withdrawal",
    date: "2024-02-05",
    earliestHarvestOn: null,
  });
  let h = await snapshot();
  expect(h.summary.holds).toHaveLength(1);
  expect(h.summary.harvestGuidance[0].recordedHolds).toEqual([]);
  expect(h.summary.harvestGuidance[0].currentConcerns[0].treatmentId).toBe(
    treatment,
  );
  await expect(
    event({
      kind: "harvest",
      quantity: 1,
      weightKg: "2.9",
      priceBasis: "unpriced",
      pricePerUnit: null,
      reference: null,
      customer: null,
    }),
  ).rejects.toMatchObject({ status: 409 });
  const state = await snapshot();
  await expect(
    tenant(owner, (c) =>
      c.query(
        `INSERT INTO broiler_events(id,organization_id,unit_id,kind,recorded_on,expected_position,expected_daily_id,quantity,weight_kg,description,price_basis,reason,evidence,submission) VALUES($1,$2,$3,'harvest','2024-02-05',$4,$5,1,2.9,'Synthetic direct hold bypass','unpriced','Synthetic direct withdrawal check','Synthetic register','{}')`,
        [
          randomUUID(),
          org,
          unit,
          state.summary.expectedPosition,
          state.summary.expectedDailyId,
        ],
      ),
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await save({
    kind: "withdrawal",
    date: "2024-02-05",
    earliestHarvestOn: "2024-02-03",
  });
  h = await snapshot();
  expect(h.summary.harvestGuidance[0].currentConcerns).toEqual([]);
  expect(h.reviews!.filter((r) => r.kind === "withdrawal")).toHaveLength(3);
  expect(h.events.find((e) => e.id === harvest)).toMatchObject({
    quantity: 10,
    weight_kg: "25.000000",
    amount: "2503.0850",
  });
});
it("denies worker/auditor/outsider reviews, wrong species/tenant parents and foreign histories against populated rows", async () => {
  const p = await review();
  for (const actor of [worker, auditor, outsider])
    await expect(post(actor, "broilers/recovery", p)).rejects.toMatchObject({
      status: 403,
    });
  await expect(
    post(owner, "broilers/recovery", { ...p, unitId: layer }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    post(owner, "broilers/recovery", { ...p, organizationId: foreign }),
  ).rejects.toMatchObject({ status: 403 });
  expect((await snapshot(auditor)).reviews!.length).toBeGreaterThan(0);
  expect(
    (
      await tenant(outsider, (c) =>
        c.query("SELECT * FROM broiler_reviews WHERE organization_id=$1", [
          org,
        ]),
      )
    ).rowCount,
  ).toBe(0);
  await expect(snapshot(outsider)).rejects.toMatchObject({ status: 404 });
});
it("validates original IDs, predecessor chains, genuine active treatments and dates", async () => {
  await expect(save({ baseRecordId: randomUUID() })).rejects.toMatchObject({
    status: 409,
  });
  await expect(save({ previousId: null })).rejects.toMatchObject({
    status: 409,
  });
  for (const date of ["2024-01-31", "2099-01-01"])
    await expect(save({ date })).rejects.toMatchObject({ status: 400 });
  await expect(
    save({ kind: "withdrawal", date: "2024-02-04" }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    save({
      kind: "withdrawal",
      date: "2024-02-05",
      earliestHarvestOn: "2024-01-31",
    }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    save({ kind: "withdrawal", date: "2024-02-05", treatmentId: harvest }),
  ).rejects.toMatchObject({ status: 404 });
});
it("refuses a historical overdraw or a now-impossible later sample without discarding truthful source history", async () => {
  await expect(
    save({
      date: "2024-02-01",
      mortality: 95,
      averageWeightG: null,
      sampleSize: null,
    }),
  ).rejects.toMatchObject({ code: "23514" });
  const u = await stock("broilers", 50);
  await daily("2024-02-01", 0, null, u);
  await daily("2024-02-03", 0, 2000, u, 10);
  await expect(
    save({ date: "2024-02-01", mortality: 45 }, u),
  ).rejects.toMatchObject({ code: "23514" });
  expect((await snapshot(owner, u)).summary.balance).toBe(50);
  expect((await snapshot(owner, u)).reviews).toEqual([]);
  await save({ date: "2024-02-03", averageWeightG: "2000", sampleSize: 5 }, u);
  await save({ date: "2024-02-01", mortality: 45 }, u);
  expect((await snapshot(owner, u)).summary.balance).toBe(5);
});
it("enforces evidence, actor, chronology and population through direct runtime inserts and keeps review rows immutable", async () => {
  const p = await review({ date: "2024-02-01" });
  const insert = (
    mortality: number,
    actor = owner,
    prev = p.previousId,
    source = "baseRecordId" in p ? p.baseRecordId : null,
  ) =>
    tenant(owner, (c) =>
      c.query(
        `INSERT INTO broiler_reviews(id,organization_id,unit_id,kind,observed_on,previous_id,base_record_id,mortality,feed_kg,notes,expected_position,expected_daily_id,reason,evidence,submission,created_by) VALUES($1,$2,$3,'daily','2024-02-01',$4,$5,$6,1,'Synthetic direct check',$7,$8,'Synthetic direct review','Synthetic register','{}',$9)`,
        [
          randomUUID(),
          org,
          unit,
          prev,
          source,
          mortality,
          p.expectedPosition,
          p.expectedDailyId,
          actor,
        ],
      ),
    );
  await expect(insert(100)).rejects.toMatchObject({ code: "23514" });
  await expect(insert(0, outsider)).rejects.toMatchObject({ code: "42501" });
  await expect(
    insert(0, owner, p.previousId, randomUUID()),
  ).rejects.toMatchObject({ code: "23514" });
  for (const sql of [
    "UPDATE broiler_reviews SET mortality=0 WHERE unit_id=$1",
    "DELETE FROM broiler_reviews WHERE unit_id=$1",
  ])
    await expect(
      tenant(owner, (c) => c.query(sql, [unit])),
    ).rejects.toMatchObject({ code: "42501" });
  const h = await snapshot();
  expect(h.reviews!.every((r) => r.created_by === owner)).toBe(true);
});
it("exports original/effective daily rows and all guidance versions with deterministic private source evidence and no mutations", async () => {
  const before = await snapshot(),
    audited = await snapshot(auditor);
  expect(before.modelVersion).toBe("broiler-reviewed-lifecycle-v2");
  expect(audited.evidenceSha256).toBe(before.evidenceSha256);
  const csv = await get(auditor, unit, "csv"),
    text = await csv.text();
  expect(csv.headers.get("cache-control")).toBe("private, no-store");
  expect(csv.headers.get("x-evidence-sha256")).toBe(before.evidenceSha256);
  for (const label of [
    "Original daily records",
    "Effective daily evidence",
    "Review history",
    "Current treatment guidance",
    "Historical harvest guidance reconciliation",
  ])
    expect(text).toContain(label);
  expect(text).toContain(treatment);
  expect(text).toContain("Synthetic immutable original observation");
  expect(text).toContain("Synthetic reviewed daily source");
  expect((await snapshot()).evidenceSha256).toBe(before.evidenceSha256);
});
it("serializes distinct direct-runtime review targets against one combined lifecycle position", async () => {
  const u = await stock("broilers", 10);
  await daily("2024-02-01", 0, null, u);
  const h = await snapshot(owner, u);
  const insert = (date: string) =>
    tenant(owner, (c) =>
      c.query(
        `INSERT INTO broiler_reviews(id,organization_id,unit_id,kind,observed_on,mortality,feed_kg,notes,expected_position,expected_daily_id,reason,evidence,submission) VALUES($1,$2,$3,'daily',$4,0,1,'Synthetic direct concurrent backfill',$5,$6,'Synthetic direct concurrent review','Synthetic dated source','{}')`,
        [
          randomUUID(),
          org,
          u,
          date,
          h.summary.expectedPosition,
          h.summary.expectedDailyId,
        ],
      ),
    );
  const results = await Promise.allSettled([
    insert("2024-02-02"),
    insert("2024-02-03"),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { code: "23505" },
  });
  expect((await snapshot(owner, u)).reviews).toHaveLength(1);
});
it("shares the stock lock with ordinary daily mortality when reviewing earlier losses", async () => {
  const u = await stock("broilers", 10);
  await daily("2024-02-01", 0, null, u);
  const p = await review({ date: "2024-02-01", mortality: 8 }, u);
  const results = await Promise.allSettled([
    post(owner, "broilers/recovery", p),
    daily("2024-02-02", 5, null, u),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await snapshot(owner, u)).summary.balance).toBeGreaterThanOrEqual(0);
});
