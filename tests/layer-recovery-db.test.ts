import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { admin } from "./admin-db";
import { tenant, pool } from "../src/lib/db";
import { productionApi } from "../src/lib/production-api";
let owner: string,
  worker: string,
  auditor: string,
  outsider: string,
  org: string,
  otherOrg: string,
  farm: string,
  unit: string,
  broiler: string;
async function post(actor: string, path: string, data: unknown) {
  return (await productionApi(
    new NextRequest("http://localhost/api/" + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    }),
    { id: actor },
    path,
  ))!;
}
const review = (values: Record<string, unknown> = {}) => ({
  organizationId: org,
  unitId: unit,
  eventId: randomUUID(),
  kind: "daily",
  date: "2024-02-01",
  previousId: null,
  baseRecordId: null,
  mortality: 0,
  eggs: 0,
  cracked: 0,
  feedKg: "0",
  notes: "Synthetic reviewed observation",
  reason: "Synthetic dated source reviewed",
  evidence: "Synthetic collection sheet reference",
  ...values,
});
const census = (values: Record<string, unknown> = {}) => ({
  organizationId: org,
  unitId: unit,
  eventId: randomUUID(),
  kind: "census",
  date: "2024-02-03",
  previousId: null,
  openingHens: 90,
  reason: "Synthetic physical count reviewed",
  evidence: "Synthetic opening count sheet",
  ...values,
});
async function history(actor = owner, flock = unit) {
  return (await productionApi(
    new NextRequest(
      `http://localhost/api/layers/recovery?organizationId=${org}&unitId=${flock}`,
    ),
    { id: actor },
    "layers/recovery",
  ))!.json();
}
async function record(date: string, mortality = 1, flock = unit) {
  return post(owner, "records", {
    organizationId: org,
    unitId: flock,
    recordedOn: date,
    mortality,
    eggs: 80,
    cracked: 1,
    feedKg: 1,
    averageWeightG: null,
    sampleSize: null,
    waterQuality: null,
    notes: "Original synthetic observation",
  });
}
async function report(from = "2024-02-01", to = "2024-02-04") {
  return (
    await post(owner, "layers/report", {
      organizationId: org,
      unitId: unit,
      from,
      to,
      traySize: 30,
      forecastId: null,
    })
  ).json();
}
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
      c.query("SELECT create_organization('Synthetic layer recovery') AS id"),
    )
  ).rows[0].id;
  otherOrg = (
    await tenant(outsider, (c) =>
      c.query("SELECT create_organization('Foreign recovery') AS id"),
    )
  ).rows[0].id;
  await admin.query(
    "INSERT INTO memberships VALUES($1,$2,'worker'),($1,$3,'auditor')",
    [org, worker, auditor],
  );
  farm = (
    await tenant(owner, (c) =>
      c.query(
        "INSERT INTO farms(organization_id,name,kind) VALUES($1,'Synthetic recovery farm','layers') RETURNING id",
        [org],
      ),
    )
  ).rows[0].id;
  for (const kind of ["layers", "broilers"]) {
    const r = await (
      await post(owner, "units", {
        organizationId: org,
        farmId: farm,
        name: "Synthetic " + kind,
        kind,
        stockedOn: "2024-02-01",
        openingCount: 100,
        initialWeightG: 1000,
      })
    ).json();
    if (kind === "layers") unit = r.id;
    else broiler = r.id;
  }
  await record("2024-02-01", 2);
  await record("2024-02-03");
  await record("2024-02-04");
});
afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])", [
    [org, otherOrg],
  ]);
  await admin.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
    [owner, worker, auditor, outsider],
  ]);
  await pool.end();
  await admin.end();
});
it("starts with real owner/auditor-visible originals and an unknown gap, never empty-row RLS proofs", async () => {
  const h = await history(auditor);
  expect(h.originals).toHaveLength(3);
  expect(h.adjustments).toHaveLength(0);
  expect((await report()).henDays).toBeNull();
  expect(
    await tenant(outsider, (c) =>
      c.query("SELECT * FROM layer_adjustments WHERE organization_id=$1", [
        org,
      ]),
    ),
  ).toMatchObject({ rowCount: 0 });
});
it("denies worker/auditor writes, non-layer recovery and foreign units, tenants and history", async () => {
  for (const actor of [worker, auditor, outsider])
    await expect(
      post(actor, "layers/recovery", census()),
    ).rejects.toMatchObject({ status: 403 });
  await expect(history(outsider)).rejects.toMatchObject({ status: 404 });
  await expect(
    post(owner, "layers/recovery", census({ unitId: broiler })),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    post(owner, "layers/recovery", census({ organizationId: otherOrg })),
  ).rejects.toMatchObject({ status: 403 });
});
it("creates a census with actor/reason/evidence and recovers only its forward population segment", async () => {
  const p = census(),
    r = await post(owner, "layers/recovery", p);
  expect(r.status).toBe(201);
  const h = await history(auditor);
  expect(h.adjustments[0]).toMatchObject({
    id: p.eventId,
    created_by: owner,
    opening_hens: 90,
    evidence: p.evidence,
  });
  expect((await report()).actualTotals).toBeNull();
  const later = await report("2024-02-03");
  expect(later.henDays).toBe(179);
  expect(later.rows.map((r: { openingHens: number }) => r.openingHens)).toEqual(
    [90, 89],
  );
  expect((await history()).balance.recorded_balance).toBe(88);
});
it("retries an identical receipt without duplicate review/audit and refuses changed receipt values", async () => {
  const h = await history(),
    a = h.adjustments[0],
    p = a.submission;
  const before = (
    await tenant(owner, (c) =>
      c.query("SELECT count(*) FROM audit_logs WHERE organization_id=$1", [
        org,
      ]),
    )
  ).rows[0].count;
  expect((await post(owner, "layers/recovery", p)).status).toBe(200);
  expect((await history()).adjustments).toHaveLength(1);
  expect(
    (
      await tenant(owner, (c) =>
        c.query("SELECT count(*) FROM audit_logs WHERE organization_id=$1", [
          org,
        ]),
      )
    ).rows[0].count,
  ).toBe(before);
  await expect(
    post(owner, "layers/recovery", { ...p, openingHens: 91 }),
  ).rejects.toMatchObject({ status: 409 });
});
it("serializes competing successors, rejects stale reviews and preserves both original and earlier review", async () => {
  const old = (await history()).adjustments[0];
  const results = await Promise.allSettled([
    post(
      owner,
      "layers/recovery",
      census({ previousId: old.id, openingHens: 80 }),
    ),
    post(
      owner,
      "layers/recovery",
      census({ previousId: old.id, openingHens: 85 }),
    ),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")[0]).toMatchObject({
    reason: { status: 409 },
  });
  expect((await history()).adjustments).toHaveLength(2);
  await expect(post(owner, "layers/recovery", census())).rejects.toMatchObject({
    status: 409,
  });
});
it("backfills an observed zero day and replaces full daily values without adding deltas or changing originals", async () => {
  await post(owner, "layers/recovery", review({ date: "2024-02-02" }));
  const h = await history(),
    base = h.originals[0];
  await post(
    owner,
    "layers/recovery",
    review({
      baseRecordId: base.id,
      mortality: 5,
      eggs: 70,
      cracked: 2,
      feedKg: "1.123456",
    }),
  );
  const r = await report();
  expect(r.actualTotals).toMatchObject({
    eggs: 230,
    mortality: 7,
    feedKg: "3.123456",
  });
  expect(r.rows[1]).toMatchObject({ eggs: 0, feedKg: "0.000000" });
  expect((await history()).originals[0]).toMatchObject({
    mortality: 2,
    eggs: 80,
    feed_kg: "1.000000",
  });
  expect(r.sourceSnapshot.adjustments).toHaveLength(4);
  const prod = await (await productionApi(
    new NextRequest(`http://localhost/api/production?organizationId=${org}`),
    { id: owner },
    "production",
  ))!.json();
  expect(prod.records).toHaveLength(4);
  expect(prod.records[0].eggs).toBe(70);
});
it("requires exact original IDs, explicit values and valid local dates", async () => {
  await expect(post(owner, "layers/recovery", review())).rejects.toMatchObject({
    status: 409,
  });
  for (const date of ["2024-01-31", "2099-01-01"])
    await expect(
      post(owner, "layers/recovery", census({ date })),
    ).rejects.toMatchObject({ status: 400 });
  await expect(
    post(owner, "layers/recovery", census({ openingHens: 1 })),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    post(
      owner,
      "layers/recovery",
      review({ date: "2024-02-05", feedKg: "0.0000001" }),
    ),
  ).rejects.toHaveProperty("issues");
});
it("refuses impossible losses both before and after a census, even through direct runtime inserts", async () => {
  const h = await history(),
    head = h.adjustments.find(
      (a: { kind: string; observed_on: string; previous_id: string | null }) =>
        a.kind === "daily" && a.observed_on === "2024-02-01",
    );
  await expect(
    post(
      owner,
      "layers/recovery",
      review({
        baseRecordId: h.originals[0].id,
        previousId: head.id,
        mortality: 101,
      }),
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    post(
      owner,
      "layers/recovery",
      review({ date: "2024-02-05", mortality: 100 }),
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    tenant(owner, (c) =>
      c.query(
        `INSERT INTO layer_adjustments(id,organization_id,unit_id,kind,observed_on,opening_hens,reason,evidence,submission) VALUES($1,$2,$3,'census','2024-02-01',1,'Synthetic impossible count','Synthetic evidence','{}')`,
        [randomUUID(), org, unit],
      ),
    ),
  ).rejects.toMatchObject({ code: "23514" });
});
it("keeps adjustment rows and original daily records immutable and tests actual outsider-visible recovery rows", async () => {
  expect((await history()).adjustments.length).toBeGreaterThan(0);
  for (const sql of [
    "UPDATE layer_adjustments SET opening_hens=500 WHERE unit_id=$1",
    "DELETE FROM layer_adjustments WHERE unit_id=$1",
    "UPDATE daily_records SET eggs=1 WHERE unit_id=$1",
  ])
    await expect(
      tenant(owner, (c) => c.query(sql, [unit])),
    ).rejects.toMatchObject({ code: "42501" });
  expect(
    (
      await tenant(outsider, (c) =>
        c.query("SELECT * FROM layer_adjustments WHERE unit_id=$1", [unit]),
      )
    ).rowCount,
  ).toBe(0);
  await expect(
    tenant(worker, (c) =>
      c.query(
        `INSERT INTO layer_adjustments(id,organization_id,unit_id,kind,observed_on,opening_hens,reason,evidence,submission) VALUES($1,$2,$3,'census','2024-02-05',50,'Synthetic worker count','Synthetic evidence','{}')`,
        [randomUUID(), org, unit],
      ),
    ),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    tenant(owner, (c) =>
      c.query(
        `INSERT INTO layer_adjustments(id,organization_id,unit_id,kind,observed_on,opening_hens,reason,evidence,submission,created_by) VALUES($1,$2,$3,'census','2024-02-07',50,'Synthetic forged reviewer','Synthetic evidence','{}',$4)`,
        [randomUUID(), org, unit, outsider],
      ),
    ),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    tenant(outsider, (c) =>
      c.query(
        `INSERT INTO layer_adjustments(id,organization_id,unit_id,kind,observed_on,opening_hens,reason,evidence,submission) VALUES($1,$2,$3,'census','2024-02-07',50,'Synthetic outsider count','Synthetic evidence','{}')`,
        [randomUUID(), org, unit],
      ),
    ),
  ).rejects.toMatchObject({ code: "23514" });
});
it("validates new original records against reviewed population balances and keeps chronological entry protected", async () => {
  await expect(record("2024-02-02", 0)).rejects.toMatchObject({
    code: "23514",
  });
  await expect(record("2024-02-05", 100)).rejects.toMatchObject({
    code: "23514",
  });
  await record("2024-02-05", 1);
  expect((await history()).originals).toHaveLength(4);
});
it("exports recovery provenance and keeps earlier-window hashes unchanged by later-dated reviews", async () => {
  const before = await report();
  await post(
    owner,
    "layers/recovery",
    census({ date: "2024-02-06", openingHens: 60 }),
  );
  const after = await report();
  expect(after.evidenceSha256).toBe(before.evidenceSha256);
  expect(after.sourceSnapshot.records[0].eggs).toBe(80);
  const q = new URLSearchParams({
    organizationId: org,
    unitId: unit,
    from: "2024-02-01",
    to: "2024-02-04",
    traySize: "30",
    format: "csv",
  });
  const r = (await productionApi(
    new NextRequest("http://localhost/api/layers/report?" + q),
    { id: auditor },
    "layers/report",
  ))!;
  expect(await r.text()).toContain("Recovery source");
  expect((await history(auditor)).adjustments.length).toBe(5);
});
