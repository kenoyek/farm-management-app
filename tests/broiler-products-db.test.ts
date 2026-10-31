import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { admin } from "./admin-db";
import { tenant, pool } from "../src/lib/db";
import { productionApi } from "../src/lib/production-api";
import type { BroilerSnapshot } from "../src/lib/broiler-lifecycle";
import type { ProductInput, ProductReport } from "../src/lib/broiler-products";
import { processingFixture } from "./broiler-processing-fixture";
let owner: string,
  worker: string,
  auditor: string,
  outsider: string,
  org: string,
  foreign: string,
  farm: string,
  foreignFarm: string;
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
const get = async (
  unit: string,
  path = "broilers/products",
  actor = owner,
  organization = org,
  format = "json",
) =>
  (await productionApi(
    new NextRequest(
      `http://localhost/api/${path}?organizationId=${organization}&unitId=${unit}&format=${format}`,
    ),
    { id: actor },
    path,
  ))!;
const source = async (u: string): Promise<BroilerSnapshot> =>
  (await get(u, "broilers/lifecycle")).json();
const report = async (u: string): Promise<ProductReport> =>
  (await get(u)).json();
async function setup(
  actor = owner,
  organization = org,
  f = farm,
  withTreatment = false,
) {
  const unit = (
    await (
      await post(actor, "units", {
        organizationId: organization,
        farmId: f,
        name: "Synthetic product batch " + randomUUID(),
        kind: "broilers",
        stockedOn: "2024-02-01",
        openingCount: 100,
        initialWeightG: 1000,
      })
    ).json()
  ).id;
  let s: BroilerSnapshot = await (
    await get(unit, "broilers/lifecycle", actor, organization)
  ).json();
  if (withTreatment) {
    await post(actor, "broilers/lifecycle", {
      organizationId: organization,
      unitId: unit,
      eventId: randomUUID(),
      kind: "treatment",
      date: "2024-02-01",
      quantity: 1,
      product: "Synthetic genuine original treatment",
      administration: "Synthetic original label source",
      earliestHarvestOn: "2024-02-01",
      description: "Synthetic genuine original treatment",
      reason: "Synthetic original clinical observation",
      evidence: "Synthetic original treatment register",
      expectedPosition: s.summary.expectedPosition,
      expectedDailyId: s.summary.expectedDailyId,
    });
    s = await (
      await get(unit, "broilers/lifecycle", actor, organization)
    ).json();
  }
  const harvest = (
    await (
      await post(actor, "broilers/lifecycle", {
        organizationId: organization,
        unitId: unit,
        eventId: randomUUID(),
        kind: "harvest",
        quantity: 10,
        weightKg: "20",
        priceBasis: "unpriced",
        pricePerUnit: null,
        reference: null,
        customer: null,
        date: "2024-02-01",
        description: "Synthetic owned source harvest",
        reason: "Synthetic original weighed harvest",
        evidence: "Synthetic source register",
        expectedPosition: s.summary.expectedPosition,
        expectedDailyId: s.summary.expectedDailyId,
      })
    ).json()
  ).id;
  const next: BroilerSnapshot = await (
    await get(unit, "broilers/lifecycle", actor, organization)
  ).json();
  const reviewId = randomUUID();
  await post(actor, "broilers/processing", {
    organizationId: organization,
    unitId: unit,
    reviewId,
    harvestId: harvest,
    previousId: null,
    expectedPosition: next.summary.expectedPosition,
    expectedDailyId: next.summary.expectedDailyId,
    data: processingFixture(),
  });
  return { unit, harvest, reviewId };
}
async function payload(
  u: string,
  data: ProductInput["data"],
): Promise<ProductInput> {
  const r = await report(u);
  return {
    organizationId: org,
    unitId: u,
    eventId: randomUUID(),
    date: "2024-02-03",
    expectedPosition: r.results.expectedPosition,
    expectedSourcePosition: r.expectedSourcePosition,
    expectedDailyId: r.expectedDailyId,
    data,
  };
}
const receipt = (reviewId: string, index = 0): ProductInput["data"] => ({
  kind: "receipt",
  sourceReviewId: reviewId,
  outputIndex: index,
  location: "Synthetic cold room A",
  scope: "whole-output-owned-available",
  reason: "Synthetic whole-output stock confirmation",
  evidence: "Synthetic owned available stock; no prior outside disposition",
});
const sale = (
  lotId: string,
  kg = "1",
  price = "2.5555",
): ProductInput["data"] => ({
  kind: "sale",
  lotId,
  weightKg: kg,
  pricePerKg: price,
  reference: "SYNTHETIC-" + randomUUID(),
  customer: "Synthetic buyer",
  reason: "Synthetic measured dispatched product",
  evidence: "Synthetic dispatch scale register",
});
const loss = (lotId: string, kg = "1"): ProductInput["data"] => ({
  kind: "loss",
  lotId,
  weightKg: kg,
  reason: "Synthetic measured product spoilage",
  evidence: "Synthetic loss scale and disposal record",
});
const voided = (voidOfId: string): ProductInput["data"] => ({
  kind: "void",
  voidOfId,
  reason: "Synthetic erroneous event did not occur",
  evidence: "Synthetic original entry correction evidence",
});
async function saved(u: string, d: ProductInput["data"]) {
  const p = await payload(u, d);
  expect((await post(owner, "broilers/products", p)).status).toBe(201);
  return p.eventId;
}
async function direct(
  actor: string,
  p: ProductInput,
  extra = "",
  values: unknown[] = [],
) {
  return tenant(actor, (c) =>
    c.query(
      `INSERT INTO broiler_product_events(id,organization_id,unit_id,lot_id,recorded_on,expected_position,expected_source_position,expected_daily_id,input${extra}) VALUES($1,$2,$3,$1,$4,$5,$6,$7,$8${values.map((_, i) => ",$" + (i + 9)).join("")}) RETURNING *`,
      [
        p.eventId,
        p.organizationId,
        p.unitId,
        p.date,
        p.expectedPosition,
        p.expectedSourcePosition,
        p.expectedDailyId,
        JSON.stringify(p.data),
        ...values,
      ],
    ),
  );
}
async function processing(u: string, h: string, r: string) {
  const s = await source(u);
  return {
    organizationId: org,
    unitId: u,
    reviewId: randomUUID(),
    harvestId: h,
    previousId: r,
    expectedPosition: s.summary.expectedPosition,
    expectedDailyId: s.summary.expectedDailyId,
    data: {
      ...processingFixture(),
      reason: "Synthetic corrected source before further stock",
    },
  };
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
      c.query("SELECT create_organization('Synthetic product tests') AS id"),
    )
  ).rows[0].id;
  foreign = (
    await tenant(outsider, (c) =>
      c.query("SELECT create_organization('Foreign product tests') AS id"),
    )
  ).rows[0].id;
  await admin.query(
    "INSERT INTO memberships VALUES($1,$2,'worker'),($1,$3,'auditor')",
    [org, worker, auditor],
  );
  farm = (
    await tenant(owner, (c) =>
      c.query(
        "INSERT INTO farms(organization_id,name,kind) VALUES($1,'Synthetic product farm','broilers') RETURNING id",
        [org],
      ),
    )
  ).rows[0].id;
  foreignFarm = (
    await tenant(outsider, (c) =>
      c.query(
        "INSERT INTO farms(organization_id,name,kind) VALUES($1,'Foreign product farm','broilers') RETURNING id",
        [foreign],
      ),
    )
  ).rows[0].id;
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
it("receives each exact measured output once, sells partial kg and records loss without changing live records, source bytes or FCR", async () => {
  const { unit, reviewId } = await setup(),
    before = await source(unit),
    csv = await (
      await get(unit, "broilers/processing", owner, org, "csv")
    ).text();
  const lot = await saved(unit, receipt(reviewId)),
    saleId = await saved(unit, sale(lot, "3.123456", "1.2345"));
  await saved(unit, loss(lot, "0.123456"));
  const r = await report(unit);
  expect(r.results.lots[0]).toMatchObject({
    balanceKg: "10.753088",
    soldKg: "3.123456",
    lostKg: "0.123456",
  });
  expect(r.events.find((e) => e.id === saleId)).toMatchObject({
    weight_kg: "3.123456",
    price_per_kg: "1.2345",
    amount: "3.8559",
    currency: "NGN",
  });
  expect(r.events[0].source_snapshot).toEqual(before.processingReviews![0]);
  expect(await source(unit)).toEqual(before);
  expect(
    await (await get(unit, "broilers/processing", owner, org, "csv")).text(),
  ).toBe(csv);
  await expect(
    post(owner, "broilers/products", await payload(unit, receipt(reviewId))),
  ).rejects.toMatchObject({ code: "23505" });
});
it("normalizes exact receipts and replays after later activity with one audit while refusing changed retries", async () => {
  const { unit, reviewId } = await setup(),
    p = await payload(unit, receipt(reviewId));
  p.data.reason = "  Synthetic whole-output stock confirmation  ";
  expect((await post(owner, "broilers/products", p)).status).toBe(201);
  await saved(unit, sale(p.eventId));
  expect((await post(owner, "broilers/products", p)).status).toBe(200);
  const rows = (
    await tenant(owner, (c) =>
      c.query("SELECT count(*)::int AS n FROM audit_logs WHERE object_id=$1", [
        p.eventId,
      ]),
    )
  ).rows;
  expect(rows[0].n).toBe(1);
  await expect(
    post(owner, "broilers/products", {
      ...p,
      data: { ...p.data, reason: "Synthetic different receipt values" },
    }),
  ).rejects.toMatchObject({ status: 409 });
});
it("prevents concurrent overdraw and stale direct-runtime movements on distinct lots", async () => {
  const { unit, reviewId } = await setup(),
    lot = await saved(unit, receipt(reviewId)),
    other = await saved(unit, receipt(reviewId, 1));
  const p = await payload(unit, sale(lot, "10")),
    q = await payload(unit, sale(lot, "10"));
  const a = await Promise.allSettled([
    post(owner, "broilers/products", p),
    post(owner, "broilers/products", q),
  ]);
  expect(a.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await report(unit)).results.lots[0].balanceKg).toBe("4.000000");
  const x = await payload(unit, loss(lot)),
    y = await payload(unit, loss(other));
  const b = await Promise.allSettled([direct(owner, x), direct(owner, y)]);
  expect(b.filter((r) => r.status === "fulfilled")).toHaveLength(1);
});
it("serializes competing whole-output receipts and receipt/source-correction races", async () => {
  const { unit, harvest, reviewId } = await setup(),
    p = await payload(unit, receipt(reviewId)),
    q = await payload(unit, receipt(reviewId));
  const a = await Promise.allSettled([direct(owner, p), direct(owner, q)]);
  expect(a.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const fresh = await setup(),
    stock = await payload(fresh.unit, receipt(fresh.reviewId)),
    update = await processing(fresh.unit, fresh.harvest, fresh.reviewId);
  const b = await Promise.allSettled([
    post(owner, "broilers/products", stock),
    post(owner, "broilers/processing", update),
  ]);
  expect(b.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(harvest).toBeTruthy();
});
it("keeps current source measurements locked until all dependent movements and erroneous receipts are reversed", async () => {
  const { unit, harvest, reviewId } = await setup(),
    lot = await saved(unit, receipt(reviewId)),
    out = await saved(unit, sale(lot));
  await expect(
    post(
      owner,
      "broilers/processing",
      await processing(unit, harvest, reviewId),
    ),
  ).rejects.toMatchObject({ status: 409 });
  const change = await processing(unit, harvest, reviewId);
  await expect(
    tenant(owner, (c) =>
      c.query(
        "INSERT INTO broiler_processing_reviews(id,organization_id,unit_id,harvest_id,previous_id,expected_position,expected_daily_id,input) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          change.reviewId,
          org,
          unit,
          harvest,
          reviewId,
          change.expectedPosition,
          change.expectedDailyId,
          JSON.stringify(change.data),
        ],
      ),
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    post(owner, "broilers/products", await payload(unit, voided(lot))),
  ).rejects.toMatchObject({ code: "23514" });
  await saved(unit, voided(out));
  await saved(unit, voided(lot));
  expect((await report(unit)).results.lots[0]).toMatchObject({
    active: false,
    balanceKg: "0.000000",
  });
  expect(
    (
      await post(
        owner,
        "broilers/processing",
        await processing(unit, harvest, reviewId),
      )
    ).status,
  ).toBe(201);
  const s = await source(unit);
  await saved(unit, receipt(s.processingReviews!.at(-1)!.id));
  expect(
    (await report(unit)).results.lots.filter((l) => l.active),
  ).toHaveLength(1);
});
it("preserves original-currency sale values and reversals after settings change without cash or exchange conversion", async () => {
  const { unit, reviewId } = await setup(),
    lot = await saved(unit, receipt(reviewId));
  const first = await saved(unit, sale(lot, "1", "0"));
  await admin.query(
    "UPDATE organizations SET currency='USD',timezone='UTC' WHERE id=$1",
    [org],
  );
  const second = await saved(unit, sale(lot, "2", "3.3333"));
  let r = await report(unit);
  expect(r.results.salesByCurrency).toEqual({ NGN: "0.0000", USD: "6.6666" });
  const old = r.events.find((e) => e.id === first);
  await saved(unit, voided(second));
  r = await report(unit);
  expect(r.events.find((e) => e.id === first)).toEqual(old);
  expect(r.results.salesByCurrency).toEqual({ NGN: "0.0000" });
  expect(r.results.lots[0].balanceKg).toBe("13.000000");
  await admin.query(
    "UPDATE organizations SET currency='NGN',timezone='Africa/Lagos' WHERE id=$1",
    [org],
  );
});
it("allows populated auditor evidence but denies outsiders, workers, forged tenant/source links and actor/time claims", async () => {
  const { unit, reviewId } = await setup();
  await saved(unit, receipt(reviewId));
  expect((await get(unit, "broilers/products", auditor)).status).toBe(200);
  await expect(get(unit, "broilers/products", outsider)).rejects.toMatchObject({
    status: 404,
  });
  const p = await payload(unit, receipt(reviewId, 1));
  for (const actor of [worker, auditor, outsider]) {
    await expect(post(actor, "broilers/products", p)).rejects.toMatchObject({
      status: 403,
    });
    await expect(direct(actor, p)).rejects.toMatchObject({
      code: actor === outsider ? "23514" : "42501",
    });
  }
  const f = await setup(outsider, foreign, foreignFarm);
  await expect(
    direct(owner, { ...p, data: receipt(f.reviewId) }),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(direct(owner, p, ",created_by", [worker])).rejects.toMatchObject(
    { code: "42501" },
  );
  await expect(
    direct(owner, p, ",created_at", ["2000-01-01"]),
  ).rejects.toMatchObject({ code: "42501" });
  expect(
    (
      await tenant(outsider, (c) =>
        c.query("SELECT id FROM broiler_product_events WHERE unit_id=$1", [
          unit,
        ]),
      )
    ).rows,
  ).toEqual([]);
});
it("derives source, quantities, positions and canonical receipts independently of client-supplied database fields", async () => {
  const { unit, reviewId } = await setup(),
    p = await payload(unit, receipt(reviewId));
  const row = (
    await direct(
      owner,
      p,
      ",weight_kg,source_snapshot,submission,position,kind,price_per_kg,amount,currency,reference",
      [
        "999",
        JSON.stringify({ forged: true }),
        "{}",
        999999,
        "sale",
        "900",
        "900",
        "USD",
        "FORGED",
      ],
    )
  ).rows[0];
  expect(row.weight_kg).toBe("14.000000");
  expect(row.source_snapshot.id).toBe(reviewId);
  expect(row.submission).toEqual(p);
  expect(row.position).not.toBe("999999");
  expect(row.kind).toBe("receipt");
  expect(row.amount).toBeNull();
  await expect(
    tenant(owner, (c) =>
      c.query("UPDATE broiler_product_events SET weight_kg=999 WHERE id=$1", [
        p.eventId,
      ]),
    ),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    tenant(owner, (c) =>
      c.query("DELETE FROM broiler_product_events WHERE id=$1", [p.eventId]),
    ),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    pool.query("SELECT * FROM broiler_product_events"),
  ).rejects.toMatchObject({ code: "42501" });
});
it("refuses unknown, unassessed, not-intended, superseded, foreign-batch and future/pre-processing receipts", async () => {
  const { unit, harvest, reviewId } = await setup();
  let p = await payload(unit, receipt(reviewId, 2));
  await expect(direct(owner, p)).rejects.toMatchObject({ code: "23514" });
  for (const date of ["2024-02-02", "2099-01-01"]) {
    p = await payload(unit, receipt(reviewId));
    p.date = date;
    await expect(direct(owner, p)).rejects.toMatchObject({ code: "23514" });
  }
  const change = await processing(unit, harvest, reviewId);
  change.data.products[0].weightKg = null;
  change.data.products[1].disposition = "unassessed";
  await post(owner, "broilers/processing", change);
  expect((await report(unit)).results.outputs).toEqual([]);
  await expect(
    direct(owner, await payload(unit, receipt(change.reviewId))),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    direct(owner, await payload(unit, receipt(reviewId))),
  ).rejects.toMatchObject({ code: "23514" });
  const other = await setup();
  await expect(
    direct(owner, await payload(other.unit, receipt(change.reviewId))),
  ).rejects.toMatchObject({ code: "23514" });
});
it("retains immutable sale references through reversals and rejects chronology, microgram overdraw and forged shapes", async () => {
  const { unit, reviewId } = await setup(),
    lot = await saved(unit, receipt(reviewId));
  const p = await payload(unit, sale(lot, "14.000001"));
  await expect(direct(owner, p)).rejects.toMatchObject({ code: "23514" });
  const s = await payload(unit, sale(lot, "1"));
  s.date = "2024-02-04";
  await post(owner, "broilers/products", s);
  const q = await payload(unit, loss(lot));
  await expect(direct(owner, q)).rejects.toMatchObject({ code: "23514" });
  const v = await payload(unit, voided(s.eventId));
  v.date = "2024-02-04";
  await post(owner, "broilers/products", v);
  await expect(direct(owner, v)).rejects.toMatchObject({ code: "23505" });
  const dup = {
    ...s,
    ...(await payload(unit, s.data)),
    date: "2024-02-04",
  };
  await expect(direct(owner, dup)).rejects.toMatchObject({ code: "23505" });
  await expect(
    direct(owner, {
      ...(await payload(unit, receipt(reviewId, 1))),
      data: { ...receipt(reviewId, 1), extra: true },
    } as unknown as ProductInput),
  ).rejects.toMatchObject({ code: "23514" });
});
it("checks revised guidance for original administrations while retaining observations and permitting loss/corrections", async () => {
  const { unit, reviewId } = await setup(owner, org, farm, true),
    lot = await saved(unit, receipt(reviewId)),
    stale = await payload(unit, sale(lot)),
    h = await source(unit),
    t = h.events.find((e) => e.kind === "treatment")!;
  await post(owner, "broilers/recovery", {
    organizationId: org,
    unitId: unit,
    eventId: randomUUID(),
    kind: "withdrawal",
    date: "2024-02-04",
    previousId: null,
    treatmentId: t.id,
    earliestHarvestOn: null,
    reason: "Synthetic later unknown original treatment guidance",
    evidence: "Synthetic revised veterinary source",
    expectedPosition: h.summary.expectedPosition,
    expectedDailyId: h.summary.expectedDailyId,
  });
  await expect(post(owner, "broilers/products", stale)).rejects.toMatchObject({
    status: 409,
  });
  await expect(
    direct(owner, await payload(unit, sale(lot))),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    direct(owner, await payload(unit, receipt(reviewId, 1))),
  ).rejects.toMatchObject({ code: "23514" });
  await saved(unit, loss(lot));
  const r = await report(unit);
  expect(r.events[0].weight_kg).toBe("14.000000");
  expect(r.results.lots[0].concerns).toHaveLength(1);
});
it("does not apply treatment of remaining birds after harvest to products from birds already removed", async () => {
  const { unit, reviewId } = await setup(),
    lot = await saved(unit, receipt(reviewId)),
    stale = await payload(unit, sale(lot)),
    h = await source(unit);
  await post(owner, "broilers/lifecycle", {
    organizationId: org,
    unitId: unit,
    eventId: randomUUID(),
    kind: "treatment",
    date: "2024-02-04",
    quantity: 1,
    product: "Synthetic later actual treatment",
    administration: "Synthetic remaining birds only",
    earliestHarvestOn: null,
    description: "Synthetic later treatment after harvested birds removed",
    reason: "Synthetic later treatment of remaining birds",
    evidence: "Synthetic original veterinary source",
    expectedPosition: h.summary.expectedPosition,
    expectedDailyId: h.summary.expectedDailyId,
  });
  await expect(post(owner, "broilers/products", stale)).rejects.toMatchObject({
    status: 409,
  });
  await saved(unit, sale(lot));
  await saved(unit, receipt(reviewId, 1));
  expect((await report(unit)).results.lots[0].concerns).toEqual([]);
});
it("exports complete private source/movement/receipt evidence with exact digest and formula-safe CSV", async () => {
  const { unit, reviewId } = await setup(),
    d = receipt(reviewId);
  d.reason = "=Synthetic formula-looking evidence";
  const lot = await saved(unit, d);
  await saved(unit, sale(lot));
  const response = await get(unit),
    r: ProductReport = await response.json();
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-evidence-sha256")).toBe(r.evidenceSha256);
  expect(
    createHash("sha256")
      .update(
        JSON.stringify({
          modelVersion: r.modelVersion,
          source: r.source,
          events: r.events,
          results: r.results,
        }),
      )
      .digest("hex"),
  ).toBe(r.evidenceSha256);
  const csv = await (
    await get(unit, "broilers/products", auditor, org, "csv")
  ).text();
  expect(csv).toContain("'=Synthetic formula-looking evidence");
  expect(csv).toContain('"Original processing source"');
  expect(csv).toContain(reviewId);
  expect(r.events[0].submission.data).toEqual(d);
});
it("rolls back a movement and its audit when complete product evidence would exceed the report bound", async () => {
  const { unit, reviewId } = await setup(),
    p = await payload(unit, receipt(reviewId));
  await admin.query(
    "UPDATE broiler_processing_reviews SET harvest_snapshot=harvest_snapshot||jsonb_build_object('large_local_fixture',$2::text) WHERE id=$1",
    [reviewId, "x".repeat(600000)],
  );
  expect((await get(unit)).status).toBe(200);
  await expect(post(owner, "broilers/products", p)).rejects.toMatchObject({
    status: 422,
  });
  expect(
    (
      await admin.query("SELECT id FROM broiler_product_events WHERE id=$1", [
        p.eventId,
      ])
    ).rows,
  ).toEqual([]);
  expect(
    (
      await admin.query("SELECT id FROM audit_logs WHERE object_id=$1", [
        p.eventId,
      ])
    ).rows,
  ).toEqual([]);
});
it("rejects a sale outside numeric money storage before overflow and retains the original lot", async () => {
  const { unit } = await setup(),
    s = await source(unit),
    harvest = randomUUID();
  await post(owner, "broilers/lifecycle", {
    organizationId: org,
    unitId: unit,
    eventId: harvest,
    kind: "harvest",
    quantity: 1,
    weightKg: "100000000",
    priceBasis: "unpriced",
    pricePerUnit: null,
    reference: null,
    customer: null,
    date: "2024-02-01",
    description: "Synthetic storage boundary source",
    reason: "Synthetic numeric boundary measurement",
    evidence: "Synthetic boundary fixture only",
    expectedPosition: s.summary.expectedPosition,
    expectedDailyId: s.summary.expectedDailyId,
  });
  const h = await source(unit),
    reviewId = randomUUID(),
    data = processingFixture();
  data.products = [{ ...data.products[0], weightKg: "100000000" }];
  data.residualKg = "0";
  await post(owner, "broilers/processing", {
    organizationId: org,
    unitId: unit,
    reviewId,
    harvestId: harvest,
    previousId: null,
    expectedPosition: h.summary.expectedPosition,
    expectedDailyId: h.summary.expectedDailyId,
    data,
  });
  const lot = await saved(unit, receipt(reviewId));
  await expect(
    direct(owner, await payload(unit, sale(lot, "100000000", "100000000"))),
  ).rejects.toMatchObject({ code: "23514" });
  expect((await report(unit)).results.lots[0].balanceKg).toBe(
    "100000000.000000",
  );
});
