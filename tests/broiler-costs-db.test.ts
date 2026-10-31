import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { admin } from "./admin-db";
import { tenant, pool } from "../src/lib/db";
import { productionApi } from "../src/lib/production-api";
import type { BroilerSnapshot } from "../src/lib/broiler-lifecycle";
import type { ProductInput, ProductReport } from "../src/lib/broiler-products";
import { costFixture } from "./broiler-costs-fixture";
import {
  actualCostInput,
  costSnapshot,
  type ActualCostInput,
  type ActualCostWorkspace,
  type ActualCostReport,
} from "../src/lib/broiler-costs";
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
const productReport = async (u: string): Promise<ProductReport> =>
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
        name: "Synthetic actual cost batch " + randomUUID(),
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
async function productPayload(
  u: string,
  data: ProductInput["data"],
): Promise<ProductInput> {
  const r = await productReport(u);
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
async function saveProduct(u: string, d: ProductInput["data"]) {
  const p = await productPayload(u, d);
  expect((await post(owner, "broilers/products", p)).status).toBe(201);
  return p.eventId;
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
      c.query(
        "SELECT create_organization('Synthetic actual cost tests') AS id",
      ),
    )
  ).rows[0].id;
  foreign = (
    await tenant(outsider, (c) =>
      c.query("SELECT create_organization('Foreign actual cost tests') AS id"),
    )
  ).rows[0].id;
  await admin.query(
    "INSERT INTO memberships VALUES($1,$2,'worker'),($1,$3,'auditor')",
    [org, worker, auditor],
  );
  farm = (
    await tenant(owner, (c) =>
      c.query(
        "INSERT INTO farms(organization_id,name,kind) VALUES($1,'Synthetic actual cost farm','broilers') RETURNING id",
        [org],
      ),
    )
  ).rows[0].id;
  foreignFarm = (
    await tenant(outsider, (c) =>
      c.query(
        "INSERT INTO farms(organization_id,name,kind) VALUES($1,'Foreign actual cost farm','broilers') RETURNING id",
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
async function workspace(
  u: string,
  actor = owner,
): Promise<ActualCostWorkspace> {
  return (await costGet(u, actor)).json();
}
async function costGet(
  u: string,
  actor = owner,
  id?: string,
  format = "workspace",
) {
  return (await productionApi(
    new NextRequest(
      `http://localhost/api/broilers/costs?organizationId=${org}&unitId=${u}&format=${format}${id ? "&reviewId=" + id : ""}`,
    ),
    { id: actor },
    "broilers/costs",
  ))!;
}
async function payload(u: string, lotId?: string): Promise<ActualCostInput> {
  const w = await workspace(u);
  return {
    organizationId: org,
    unitId: u,
    reviewId: randomUUID(),
    previousId: w.latestId,
    expectedPosition: w.current!.results.expectedPosition,
    expectedSourcePosition: w.current!.expectedSourcePosition,
    expectedDailyId: w.current!.expectedDailyId,
    expectedSourceSha256: w.sourceToken!,
    data: costFixture(lotId),
  };
}
async function direct(
  actor: string,
  p: ActualCostInput,
  extra = "",
  values: unknown[] = [],
) {
  return tenant(actor, (c) =>
    c.query(
      `INSERT INTO broiler_cost_reviews(id,organization_id,unit_id,previous_id,expected_position,expected_source_position,expected_daily_id,expected_source_sha256,input${extra}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9${values.map((_, i) => ",$" + (i + 10)).join("")}) RETURNING *`,
      [
        p.reviewId,
        p.organizationId,
        p.unitId,
        p.previousId,
        p.expectedPosition,
        p.expectedSourcePosition,
        p.expectedDailyId,
        p.expectedSourceSha256,
        JSON.stringify(p.data),
        ...values,
      ],
    ),
  );
}
async function withLots() {
  const b = await setup(),
    lot = await saveProduct(b.unit, receipt(b.reviewId)),
    byproduct = await saveProduct(b.unit, receipt(b.reviewId, 1));
  await saveProduct(b.unit, sale(lot, "3.123456", "1.2345"));
  await saveProduct(b.unit, loss(lot, "0.123456"));
  return { ...b, lot, byproduct };
}
it("freezes the exact actual operational/product evidence and reconciles explicit costs without changing live or product records", async () => {
  const { unit, lot, byproduct } = await withLots(),
    before = await source(unit),
    products = await productReport(unit),
    p = await payload(unit, lot);
  p.data.allocations.push({
    lotId: byproduct,
    amount: "20",
    evidence: "Synthetic explicit by-product joint-cost share",
  });
  const r = await post(owner, "broilers/costs", p);
  expect(r.status).toBe(201);
  const w = await workspace(unit);
  expect(w.sourceCurrent).toBe(true);
  expect(w.report!.source.source_snapshot).toEqual(costSnapshot(products));
  expect(w.current).toEqual(products);
  expect(await source(unit)).toEqual(before);
  expect(w.report!.results).toMatchObject({
    knownCostSubtotal: "300.0000",
    totalDeclaredIncurredCost: "300.0000",
    allocatedCost: "170.0001",
    unallocatedKnownCost: "129.9999",
  });
  expect(w.report!.results.lots[0]).toMatchObject({
    remainingKg: "10.753088",
    allocatedCostPerKg: "10.71429286",
    recordedSales: { NGN: "3.8559" },
  });
  expect(w.report!.source.submission).toEqual(actualCostInput.parse(p));
});
it("replays normalized cost receipts once after later versions and source changes while refusing changed receipt data", async () => {
  const { unit, lot } = await withLots(),
    p = await payload(unit, lot);
  p.data.reason = "  Synthetic original incurred review  ";
  await post(owner, "broilers/costs", p);
  await post(owner, "broilers/costs", await payload(unit, lot));
  await saveProduct(unit, sale(lot));
  expect((await post(owner, "broilers/costs", p)).status).toBe(200);
  expect(
    (
      await tenant(owner, (c) =>
        c.query(
          "SELECT count(*)::int AS n FROM audit_logs WHERE object_id=$1",
          [p.reviewId],
        ),
      )
    ).rows[0].n,
  ).toBe(1);
  await expect(
    post(owner, "broilers/costs", {
      ...p,
      data: { ...p.data, reason: "Synthetic changed receipt meaning" },
    }),
  ).rejects.toMatchObject({ status: 409 });
});
it("serializes competing API and direct-runtime review predecessors without forks", async () => {
  const { unit, lot } = await withLots(),
    a = await payload(unit, lot),
    b = await payload(unit, lot);
  const r = await Promise.allSettled([
    post(owner, "broilers/costs", a),
    post(owner, "broilers/costs", b),
  ]);
  expect(r.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const x = await payload(unit, lot),
    y = await payload(unit, lot),
    s = await Promise.allSettled([
      direct(owner, actualCostInput.parse(x)),
      direct(owner, actualCostInput.parse(y)),
    ]);
  expect(s.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await workspace(unit)).history).toHaveLength(2);
});
it("rejects stale product, clinical and metadata-only source changes in the API and direct database guard", async () => {
  const { unit, lot } = await withLots();
  let p = actualCostInput.parse(await payload(unit, lot));
  await saveProduct(unit, loss(lot));
  await expect(post(owner, "broilers/costs", p)).rejects.toMatchObject({
    status: 409,
  });
  await expect(direct(owner, p)).rejects.toMatchObject({ code: "23505" });
  p = actualCostInput.parse(await payload(unit, lot));
  await admin.query("UPDATE organizations SET timezone='UTC' WHERE id=$1", [
    org,
  ]);
  await expect(post(owner, "broilers/costs", p)).rejects.toMatchObject({
    status: 409,
  });
  await expect(direct(owner, p)).rejects.toMatchObject({ code: "23505" });
  await admin.query(
    "UPDATE organizations SET timezone='Africa/Lagos' WHERE id=$1",
    [org],
  );
  p = actualCostInput.parse(await payload(unit, lot));
  const h = await source(unit);
  await post(owner, "broilers/lifecycle", {
    organizationId: org,
    unitId: unit,
    eventId: randomUUID(),
    kind: "health",
    date: "2024-02-04",
    quantity: 1,
    description: "Synthetic clinical observation",
    reason: "Synthetic later original health observation",
    evidence: "Synthetic real observation register",
    expectedPosition: h.summary.expectedPosition,
    expectedDailyId: h.summary.expectedDailyId,
  });
  await expect(direct(owner, p)).rejects.toMatchObject({ code: "23505" });
});
it("exports stable exact old review bytes after stock reversals, settings and later cost reviews", async () => {
  const { unit, lot } = await withLots(),
    p = await payload(unit, lot);
  await post(owner, "broilers/costs", p);
  const csv = await (await costGet(unit, owner, p.reviewId, "csv")).text(),
    json = await (await costGet(unit, owner, p.reviewId, "json")).text();
  const original = (await workspace(unit)).report!.source;
  const saleId = await saveProduct(unit, sale(lot));
  await saveProduct(unit, voided(saleId));
  await admin.query(
    "UPDATE organizations SET timezone='UTC',currency='USD' WHERE id=$1",
    [org],
  );
  const q = await payload(unit, lot);
  q.data.currency = "USD";
  await post(owner, "broilers/costs", q);
  expect(await (await costGet(unit, owner, p.reviewId, "csv")).text()).toBe(
    csv,
  );
  expect(await (await costGet(unit, owner, p.reviewId, "json")).text()).toBe(
    json,
  );
  const historical: ActualCostWorkspace = await (
    await costGet(unit, owner, p.reviewId)
  ).json();
  expect(historical.sourceCurrent).toBe(false);
  expect(historical.report!.source).toEqual(original);
  await admin.query(
    "UPDATE organizations SET timezone='Africa/Lagos',currency='NGN' WHERE id=$1",
    [org],
  );
});
it("allows populated auditor reads but denies outsider reads, wrong-role writes and forged actor/time claims", async () => {
  const { unit, lot } = await withLots(),
    p = actualCostInput.parse(await payload(unit, lot));
  await post(owner, "broilers/costs", p);
  expect((await workspace(unit, auditor)).report!.source.id).toBe(p.reviewId);
  await expect(workspace(unit, outsider)).rejects.toMatchObject({
    status: 404,
  });
  await expect(
    costGet(unit, outsider, p.reviewId, "json"),
  ).rejects.toMatchObject({ status: 404 });
  const q = actualCostInput.parse(await payload(unit, lot));
  for (const actor of [worker, auditor, outsider]) {
    await expect(post(actor, "broilers/costs", q)).rejects.toMatchObject({
      status: 403,
    });
    await expect(direct(actor, q)).rejects.toMatchObject({
      code: actor === outsider ? "23514" : "42501",
    });
  }
  await expect(direct(owner, q, ",created_by", [worker])).rejects.toMatchObject(
    { code: "42501" },
  );
  await expect(
    direct(owner, q, ",created_at", ["2000-01-01"]),
  ).rejects.toMatchObject({ code: "42501" });
  expect(
    (
      await tenant(outsider, (c) =>
        c.query("SELECT id FROM broiler_cost_reviews WHERE unit_id=$1", [unit]),
      )
    ).rows,
  ).toEqual([]);
});
it("derives snapshots, revisions and normalized receipts independently of forged stored derived columns, with no runtime updates/deletes", async () => {
  const { unit, lot } = await withLots(),
    p = actualCostInput.parse(await payload(unit, lot)),
    row = (
      await direct(owner, p, ",source_snapshot,submission,revision", [
        JSON.stringify({ forged: true }),
        "{}",
        99,
      ])
    ).rows[0];
  expect(row.source_snapshot.source.unit.id).toBe(unit);
  expect(row.revision).toBe(1);
  expect(row.submission).toEqual(p);
  await expect(
    tenant(owner, (c) =>
      c.query("UPDATE broiler_cost_reviews SET input=$2 WHERE id=$1", [
        p.reviewId,
        "{}",
      ]),
    ),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    tenant(owner, (c) =>
      c.query("DELETE FROM broiler_cost_reviews WHERE id=$1", [p.reviewId]),
    ),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    pool.query("SELECT * FROM broiler_cost_reviews"),
  ).rejects.toMatchObject({ code: "42501" });
});
it("refuses genuine foreign/cross-batch receipts and inactive lots while accepting fully sold active lots", async () => {
  const { unit, lot } = await withLots(),
    other = await withLots(),
    foreignBatch = await setup(outsider, foreign, foreignFarm),
    foreignProduct: ProductReport = await (
      await get(foreignBatch.unit, "broilers/products", outsider, foreign)
    ).json();
  const fp = {
    organizationId: foreign,
    unitId: foreignBatch.unit,
    eventId: randomUUID(),
    date: "2024-02-03",
    expectedPosition: foreignProduct.results.expectedPosition,
    expectedSourcePosition: foreignProduct.expectedSourcePosition,
    expectedDailyId: foreignProduct.expectedDailyId,
    data: receipt(foreignBatch.reviewId),
  };
  await post(outsider, "broilers/products", fp);
  for (const id of [other.lot, fp.eventId]) {
    const p = actualCostInput.parse(await payload(unit, id));
    await expect(direct(owner, p)).rejects.toMatchObject({ code: "23514" });
    await expect(post(owner, "broilers/costs", p)).rejects.toMatchObject({
      status: 400,
    });
  }
  const fresh = await setup(),
    empty = await saveProduct(fresh.unit, receipt(fresh.reviewId));
  await saveProduct(fresh.unit, voided(empty));
  await expect(
    direct(owner, actualCostInput.parse(await payload(fresh.unit, empty))),
  ).rejects.toMatchObject({ code: "23514" });
  await saveProduct(unit, sale(lot, "10.753088"));
  const p = await payload(unit, lot);
  expect((await post(owner, "broilers/costs", p)).status).toBe(201);
  expect((await workspace(unit)).report!.results.lots[0].remainingKg).toBe(
    "0.000000",
  );
});
it("checks allocation/cost/evidence/shape boundaries independently for direct runtime writes", async () => {
  const { unit, lot } = await withLots(),
    base = actualCostInput.parse(await payload(unit, lot));
  for (const patch of [
    { allocations: [{ ...base.data.allocations[0], amount: "300.0001" }] },
    { costs: Array(10).fill(base.data.costs[0]) },
    { allocations: [base.data.allocations[0], base.data.allocations[0]] },
    { costs: base.data.costs.map((c) => ({ ...c, evidence: "" })) },
    { currency: "ngn" },
    { policy: "sale-value-weighting" },
    { costs: [] },
    { extra: true },
  ])
    await expect(
      direct(owner, {
        ...base,
        reviewId: randomUUID(),
        data: { ...base.data, ...patch },
      } as unknown as ActualCostInput),
    ).rejects.toMatchObject({ code: "23514" });
});
it("preserves unknown totals and explicit zero allocations without filling them from saved plans or operational quantities", async () => {
  const { unit, lot } = await withLots(),
    p = await payload(unit, lot);
  p.data.costs[1].amount = null;
  p.data.costs[1].evidence = "";
  p.data.allocations[0].amount = "0";
  await post(owner, "broilers/costs", p);
  const r = (await workspace(unit)).report!.results;
  expect(r).toMatchObject({
    knownCostSubtotal: "100.0000",
    totalDeclaredIncurredCost: null,
    unknownCategories: ["feed"],
    unallocatedKnownCost: "100.0000",
  });
  expect(r.lots[0].allocatedCost).toBe("0.0000");
  expect(r).not.toHaveProperty("profit");
});
it("shares a reproducible immutable digest across genuine private JSON/CSV with complete actor and source evidence", async () => {
  const { unit, lot } = await withLots(),
    p = await payload(unit, lot);
  p.data.costs[0].evidence = "=Synthetic category voucher";
  p.data.allocations[0].evidence = "=Synthetic allocation authority";
  await post(owner, "broilers/costs", p);
  const response = await costGet(unit, auditor, p.reviewId, "json"),
    r: ActualCostReport = await response.json();
  expect(
    createHash("sha256")
      .update(
        JSON.stringify({
          modelVersion: r.modelVersion,
          source: r.source,
          results: r.results,
        }),
      )
      .digest("hex"),
  ).toBe(r.evidenceSha256);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-evidence-sha256")).toBe(r.evidenceSha256);
  const csv = await (await costGet(unit, auditor, p.reviewId, "csv")).text();
  expect(csv).toContain("'=Synthetic category voucher");
  expect(csv).toContain("'=Synthetic allocation authority");
  expect(csv).toContain('"Complete immutable source"');
  expect(csv).toContain(r.source.created_by);
  expect(csv).toContain(
    r.source.source_snapshot.source.processingReviews[0].id,
  );
});
it("keeps old exports readable when later source exceeds snapshot limits and refuses a new oversized save without audit", async () => {
  const { unit, lot, reviewId } = await withLots(),
    p = await payload(unit, lot);
  await post(owner, "broilers/costs", p);
  const csv = await (await costGet(unit, owner, p.reviewId, "csv")).text(),
    q = actualCostInput.parse(await payload(unit, lot));
  await admin.query(
    "UPDATE broiler_processing_reviews SET harvest_snapshot=harvest_snapshot||jsonb_build_object('large_local_fixture',$2::text) WHERE id=$1",
    [reviewId, "x".repeat(550000)],
  );
  const unavailable = await workspace(unit);
  expect(unavailable.current).toBeNull();
  expect(unavailable.currentError).toContain("512 KiB");
  expect(unavailable.history).toHaveLength(1);
  await expect(direct(owner, q)).rejects.toMatchObject({ code: "23514" });
  expect(await (await costGet(unit, owner, p.reviewId, "csv")).text()).toBe(
    csv,
  );
  expect(
    (
      await admin.query("SELECT id FROM broiler_cost_reviews WHERE id=$1", [
        q.reviewId,
      ])
    ).rows,
  ).toEqual([]);
  expect(
    (
      await admin.query("SELECT id FROM audit_logs WHERE object_id=$1", [
        q.reviewId,
      ])
    ).rows,
  ).toEqual([]);
});
it("binds independently derived source evidence to real application tables under caller-controlled temporary schemas", async () => {
  const { unit, lot } = await withLots(),
    p = actualCostInput.parse(await payload(unit, lot)),
    before = await productReport(unit);
  const row = await tenant(owner, async (c) => {
    await c.query(
      "CREATE TEMP TABLE production_units (LIKE public.production_units) ON COMMIT DROP",
    );
    await c.query(
      "CREATE TEMP TABLE broiler_product_events (LIKE public.broiler_product_events) ON COMMIT DROP",
    );
    await c.query("SET LOCAL search_path=pg_temp,public");
    return (
      await c.query(
        "INSERT INTO public.broiler_cost_reviews(id,organization_id,unit_id,previous_id,expected_position,expected_source_position,expected_daily_id,expected_source_sha256,input) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING source_snapshot",
        [
          p.reviewId,
          org,
          unit,
          p.previousId,
          p.expectedPosition,
          p.expectedSourcePosition,
          p.expectedDailyId,
          p.expectedSourceSha256,
          JSON.stringify(p.data),
        ],
      )
    ).rows[0];
  });
  expect(row.source_snapshot).toEqual(costSnapshot(before));
});
