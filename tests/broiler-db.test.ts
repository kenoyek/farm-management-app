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
  layer: string;
const post = (actor: string, path: string, p: unknown) =>
  productionApi(
    new NextRequest("http://localhost/api/" + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(p),
    }),
    { id: actor },
    path,
  ).then((r) => r!);
const snap = async (actor = owner, u = unit, format = "json") =>
  (await productionApi(
    new NextRequest(
      `http://localhost/api/broilers/lifecycle?organizationId=${org}&unitId=${u}&format=${format}`,
    ),
    { id: actor },
    "broilers/lifecycle",
  ))!;
const history = async (actor = owner, u = unit): Promise<BroilerSnapshot> =>
  (await snap(actor, u)).json();
async function stocked(kind = "broilers", count = 100) {
  return (
    await (
      await post(owner, "units", {
        organizationId: org,
        farmId: farm,
        name: "Synthetic " + kind + " " + randomUUID(),
        kind,
        stockedOn: "2024-02-01",
        openingCount: count,
        initialWeightG: 1000,
      })
    ).json()
  ).id;
}
async function record(
  date: string,
  death = 0,
  u = unit,
  weight: number | null = 2000,
  sample: number | null = 10,
) {
  return post(owner, "records", {
    organizationId: org,
    unitId: u,
    recordedOn: date,
    mortality: death,
    eggs: 0,
    cracked: 0,
    feedKg: 10,
    averageWeightG: weight,
    sampleSize: sample,
    waterQuality: null,
    notes: "Synthetic actual observation",
  });
}
async function payload(values: Record<string, unknown> = {}, u = unit) {
  const h = await history(owner, u);
  return {
    organizationId: org,
    unitId: u,
    eventId: randomUUID(),
    kind: "health",
    date: h.summary.asOf,
    expectedPosition: h.summary.expectedPosition,
    expectedDailyId: h.summary.expectedDailyId,
    quantity: 5,
    description: "Synthetic observed health",
    reason: "Synthetic reviewed event",
    evidence: "Synthetic dated register",
    ...values,
  };
}
const save = async (values: Record<string, unknown> = {}, u = unit) =>
  (await post(owner, "broilers/lifecycle", await payload(values, u))).json();
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
      c.query(
        "SELECT create_organization('Synthetic broiler lifecycle') AS id",
      ),
    )
  ).rows[0].id;
  foreign = (
    await tenant(outsider, (c) =>
      c.query("SELECT create_organization('Foreign broilers') AS id"),
    )
  ).rows[0].id;
  await admin.query(
    "INSERT INTO memberships VALUES($1,$2,'worker'),($1,$3,'auditor')",
    [org, worker, auditor],
  );
  farm = (
    await tenant(owner, (c) =>
      c.query(
        "INSERT INTO farms(organization_id,name,kind) VALUES($1,'Synthetic lifecycle farm','broilers') RETURNING id",
        [org],
      ),
    )
  ).rows[0].id;
  unit = await stocked();
  layer = await stocked("layers");
  await record("2024-02-01");
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
it("saves observed health without subtracting birds and proves actual owner/auditor rows against outsiders", async () => {
  await save();
  const h = await history(auditor);
  expect(h.events).toHaveLength(1);
  expect(h.summary.balance).toBe(100);
  expect(
    (
      await tenant(outsider, (c) =>
        c.query("SELECT * FROM broiler_events WHERE organization_id=$1", [org]),
      )
    ).rowCount,
  ).toBe(0);
  await expect(history(outsider)).rejects.toMatchObject({ status: 404 });
});
it("denies workers, auditors, foreign parents, layer batches and forged reviewer identity", async () => {
  const p = await payload();
  for (const actor of [worker, auditor, outsider])
    await expect(post(actor, "broilers/lifecycle", p)).rejects.toMatchObject({
      status: 403,
    });
  await expect(
    post(owner, "broilers/lifecycle", { ...p, unitId: layer }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    post(owner, "broilers/lifecycle", { ...p, organizationId: foreign }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    tenant(owner, (c) =>
      c.query(
        `INSERT INTO broiler_events(id,organization_id,unit_id,kind,recorded_on,expected_position,expected_daily_id,quantity,description,reason,evidence,submission,created_by) VALUES($1,$2,$3,'health','2024-02-01',$4,$5,1,'Synthetic health','Synthetic reviewed event','Synthetic record','{}',$6)`,
        [
          randomUUID(),
          org,
          unit,
          p.expectedPosition,
          p.expectedDailyId,
          outsider,
        ],
      ),
    ),
  ).rejects.toMatchObject({ code: "42501" });
});
it("replays exactly one receipt and audit, rejects changed payload and stale concurrent reviews", async () => {
  const p = await payload();
  expect((await post(owner, "broilers/lifecycle", p)).status).toBe(201);
  const count = (
    await tenant(owner, (c) =>
      c.query("SELECT count(*) FROM audit_logs WHERE organization_id=$1", [
        org,
      ]),
    )
  ).rows[0].count;
  expect((await post(owner, "broilers/lifecycle", p)).status).toBe(200);
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
    post(owner, "broilers/lifecycle", { ...p, quantity: 6 }),
  ).rejects.toMatchObject({ status: 409 });
  const p1 = await payload(),
    p2 = { ...p1, eventId: randomUUID() };
  const results = await Promise.allSettled([
    post(owner, "broilers/lifecycle", p1),
    post(owner, "broilers/lifecycle", p2),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { status: 409 },
  });
});
it("blocks live harvest for unknown or unexpired treatment guidance, preserves corrected original evidence", async () => {
  const t = await save({
    kind: "treatment",
    product: "Synthetic product",
    administration: "Synthetic actual administration; no dose advice",
    earliestHarvestOn: null,
  });
  const harvest = {
    kind: "harvest",
    quantity: 10,
    weightKg: "20.000001",
    priceBasis: "kg",
    pricePerUnit: "3.1234",
    reference: "SYNTHETIC-" + randomUUID(),
    customer: "Synthetic customer",
  };
  await expect(save(harvest)).rejects.toMatchObject({ status: 409 });
  await save({
    kind: "void",
    quantity: undefined,
    voidOfId: t.id,
    description: "Synthetic erroneous unknown date review",
  });
  const t2 = await save({
    kind: "treatment",
    product: "Synthetic product",
    administration: "Synthetic label-guided record",
    earliestHarvestOn: "2024-02-03",
  });
  await expect(save(harvest)).rejects.toMatchObject({ status: 409 });
  await save({ kind: "void", quantity: undefined, voidOfId: t2.id });
  await save({ ...harvest, reference: "SYNTHETIC-FIRST" });
  const h = await history();
  expect(h.summary).toMatchObject({
    balance: 90,
    harvested: 10,
    sales: { NGN: "62.4680" },
    fcr: null,
  });
  expect(h.events.filter((e) => e.kind === "treatment")).toHaveLength(2);
});
it("keeps daily deaths distinct from culls, updates production/dashboard balances, and protects later samples", async () => {
  await record("2024-02-02", 2);
  await save({ kind: "cull", quantity: 3, weightKg: null });
  const h = await history();
  expect(h.summary).toMatchObject({
    balance: 85,
    mortality: 2,
    culled: 3,
    harvested: 10,
    fcr: null,
  });
  const prod = (await productionApi(
    new NextRequest("http://localhost/api/production?organizationId=" + org),
    { id: owner },
    "production",
  ))!;
  expect(
    (await prod.json()).units.find((u: { id: string }) => u.id === unit)
      .recorded_balance,
  ).toBe("85");
  await expect(record("2024-02-02", 0)).rejects.toMatchObject({
    code: "23514",
  });
  await expect(
    record("2024-02-03", 86, unit, null, null),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(record("2024-02-03", 0, unit, 2000, 86)).rejects.toMatchObject({
    code: "23514",
  });
  const older = h.events.find((e) => e.kind === "harvest")!;
  await expect(
    save({ kind: "void", quantity: undefined, voidOfId: older.id }),
  ).rejects.toMatchObject({ status: 409 });
});
it("serializes competing partial harvests without overdraw, exact receipt retry and immediate correction", async () => {
  const u = await stocked("broilers", 10);
  await record("2024-02-01", 0, u, 2000, 5);
  const p = await payload(
    {
      kind: "harvest",
      quantity: 8,
      weightKg: "16",
      priceBasis: "bird",
      pricePerUnit: "0.3333",
      reference: "SYNTHETIC-RACE-A",
      customer: "Synthetic",
    },
    u,
  );
  const results = await Promise.allSettled([
    post(owner, "broilers/lifecycle", p),
    post(owner, "broilers/lifecycle", {
      ...p,
      eventId: randomUUID(),
      reference: "SYNTHETIC-RACE-B",
    }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await history(owner, u)).summary.balance).toBe(2);
  const h = await history(owner, u),
    original = h.events[0];
  await save({ kind: "void", quantity: undefined, voidOfId: original.id }, u);
  expect((await history(owner, u)).summary).toMatchObject({
    balance: 10,
    harvested: 0,
    sales: {},
  });
  await expect(
    save({ kind: "void", quantity: undefined, voidOfId: original.id }, u),
  ).rejects.toMatchObject({ status: 409 });
});
it("enforces withdrawal, stale state, price and quantity checks through direct runtime writes too", async () => {
  const p = await payload();
  const insert = (quantity: number, amount: string, currency = "NGN") =>
    tenant(owner, (c) =>
      c.query(
        `INSERT INTO broiler_events(id,organization_id,unit_id,kind,recorded_on,expected_position,expected_daily_id,quantity,weight_kg,description,price_basis,price_per_unit,amount,currency,reference,customer,reason,evidence,submission) VALUES($1,$2,$3,'harvest','2024-02-02',$4,$5,$6,2,'Synthetic forged harvest','kg',1,$7,$8,$9,'Synthetic customer','Synthetic price review','Synthetic evidence','{}')`,
        [
          randomUUID(),
          org,
          unit,
          p.expectedPosition,
          p.expectedDailyId,
          quantity,
          amount,
          currency,
          randomUUID(),
        ],
      ),
    );
  await expect(insert(100, "2")).rejects.toMatchObject({ code: "23514" });
  await expect(insert(1, "999")).rejects.toMatchObject({ code: "23514" });
  await expect(insert(1, "2", "USD")).rejects.toMatchObject({ code: "23514" });
  await save({
    kind: "treatment",
    product: "Synthetic product",
    administration: "Synthetic treatment with unknown date",
    earliestHarvestOn: null,
  });
  const p2 = await payload();
  await expect(
    tenant(owner, (c) =>
      c.query(
        `INSERT INTO broiler_events(id,organization_id,unit_id,kind,recorded_on,expected_position,expected_daily_id,quantity,weight_kg,description,price_basis,reason,evidence,submission) VALUES($1,$2,$3,'harvest','2024-02-02',$4,$5,1,2,'Synthetic bypass attempt','unpriced','Synthetic direct check','Synthetic evidence','{}')`,
        [randomUUID(), org, unit, p2.expectedPosition, p2.expectedDailyId],
      ),
    ),
  ).rejects.toMatchObject({ code: "23514" });
});
it("uses measured withdrawn biomass and a later representative sample for complete-feed FCR and original currencies", async () => {
  const u = await stocked("broilers", 10);
  await record("2024-02-01", 0, u, 2000, 5);
  await save(
    {
      kind: "harvest",
      quantity: 2,
      weightKg: "4",
      priceBasis: "kg",
      pricePerUnit: "1.2345",
      reference: "SYNTHETIC-FCR-1",
      customer: "Synthetic",
    },
    u,
  );
  await record("2024-02-02", 0, u, 2500, 5);
  let h = await history(owner, u);
  expect(h.summary).toMatchObject({
    balance: 8,
    cohortGainKg: "14.000000",
    fcr: "1.428571",
    sales: { NGN: "4.9380" },
  });
  await tenant(owner, (c) =>
    c.query("UPDATE organizations SET currency='USD' WHERE id=$1", [org]),
  );
  await save(
    {
      kind: "harvest",
      quantity: 8,
      weightKg: "20",
      priceBasis: "bird",
      pricePerUnit: "0.1234",
      reference: "SYNTHETIC-FCR-2",
      customer: "Synthetic",
    },
    u,
  );
  h = await history(owner, u);
  expect(h.summary).toMatchObject({
    balance: 0,
    fcr: "1.428571",
    sales: { NGN: "4.9380", USD: "0.9872" },
  });
  expect(h.events[0]).toMatchObject({
    currency: "NGN",
    price_per_unit: "1.2345",
  });
});
it("protects chronology, future dates, stale daily observations, immutability and private source exports", async () => {
  const p = await payload();
  await expect(
    post(owner, "broilers/lifecycle", { ...p, date: "2024-01-31" }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    post(owner, "broilers/lifecycle", { ...p, date: "2099-01-01" }),
  ).rejects.toMatchObject({ status: 400 });
  await record("2024-02-03", 0, unit, 2000, 5);
  await expect(post(owner, "broilers/lifecycle", p)).rejects.toMatchObject({
    status: 409,
  });
  for (const sql of [
    "UPDATE broiler_events SET quantity=1 WHERE unit_id=$1",
    "DELETE FROM broiler_events WHERE unit_id=$1",
  ])
    await expect(
      tenant(owner, (c) => c.query(sql, [unit])),
    ).rejects.toMatchObject({ code: "42501" });
  const a = await history(),
    b = await history(auditor);
  expect(a.evidenceSha256).toBe(b.evidenceSha256);
  const csv = await snap(auditor, unit, "csv");
  expect(csv.headers.get("cache-control")).toBe("private, no-store");
  expect(csv.headers.get("x-evidence-sha256")).toBe(a.evidenceSha256);
  expect(await csv.text()).toContain("Synthetic actual observation");
  expect((await history()).evidenceSha256).toBe(a.evidenceSha256);
});
it("allows harvest on the explicit earliest date and preserves unpriced versus known zero", async () => {
  const u = await stocked("broilers", 10);
  await record("2024-02-01", 0, u, 2000, 5);
  await save(
    {
      kind: "treatment",
      quantity: 10,
      product: "Synthetic product",
      administration: "Synthetic recorded administration",
      earliestHarvestOn: "2024-02-02",
    },
    u,
  );
  await record("2024-02-02", 0, u, 2100, 5);
  await save(
    {
      kind: "harvest",
      quantity: 2,
      weightKg: "4.2",
      priceBasis: "unpriced",
      pricePerUnit: null,
      reference: null,
      customer: null,
    },
    u,
  );
  await save(
    {
      kind: "harvest",
      quantity: 1,
      weightKg: "2.1",
      priceBasis: "bird",
      pricePerUnit: "0",
      reference: "SYNTHETIC-ZERO-" + randomUUID(),
      customer: "Synthetic known zero",
    },
    u,
  );
  const h = await history(owner, u);
  expect(h.summary).toMatchObject({
    balance: 7,
    harvested: 3,
    unpricedHarvests: 1,
    sales: { USD: "0.0000" },
  });
  expect(h.events.find((e) => e.price_basis === "unpriced")!.amount).toBeNull();
});
it("serializes daily mortality against withdrawals under the same unit lock", async () => {
  const u = await stocked("broilers", 10);
  await record("2024-02-01", 0, u, 2000, 5);
  const p = await payload(
    {
      kind: "harvest",
      quantity: 8,
      weightKg: "16",
      priceBasis: "unpriced",
      pricePerUnit: null,
      reference: null,
      customer: null,
    },
    u,
  );
  const results = await Promise.allSettled([
    post(owner, "broilers/lifecycle", p),
    record("2024-02-02", 5, u, null, null),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const h = await history(owner, u);
  expect(h.summary.balance).toBeGreaterThanOrEqual(0);
  expect(h.summary.mortality + h.summary.harvested).toBeLessThanOrEqual(10);
});
