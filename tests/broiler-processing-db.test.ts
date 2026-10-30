import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { admin } from "./admin-db";
import { tenant, pool } from "../src/lib/db";
import { productionApi } from "../src/lib/production-api";
import type { BroilerSnapshot } from "../src/lib/broiler-lifecycle";
import type {
  ProcessingInput,
  ProcessingReport,
} from "../src/lib/broiler-processing";
import { processingFixture } from "./broiler-processing-fixture";
import { planFixture } from "./broiler-planning-fixture";
import { economicsFixture } from "./broiler-economics-fixture";
let owner: string,
  worker: string,
  auditor: string,
  outsider: string,
  org: string,
  foreign: string,
  farm: string,
  unit: string,
  harvest: string,
  priced: string,
  foreignHarvest: string,
  planPath: string,
  budgetPath: string,
  oldPlan: string,
  oldBudget: string;
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
  actor = owner,
  u = unit,
  format = "json",
  path = "broilers/lifecycle",
) =>
  (await productionApi(
    new NextRequest(
      `http://localhost/api/${path}?organizationId=${org}&unitId=${u}&format=${format}`,
    ),
    { id: actor },
    path,
  ))!;
const snapshot = async (u = unit): Promise<BroilerSnapshot> =>
  (await get(owner, u)).json();
const report = async (u = unit, actor = owner): Promise<ProcessingReport> =>
  (await get(actor, u, "json", "broilers/processing")).json();
async function stocked(actor = owner, o = org, f = farm) {
  return (
    await (
      await post(actor, "units", {
        organizationId: o,
        farmId: f,
        name: "Synthetic processing batch " + randomUUID(),
        kind: "broilers",
        stockedOn: "2024-02-01",
        openingCount: 100,
        initialWeightG: 1000,
      })
    ).json()
  ).id;
}
async function daily(
  u = unit,
  date = "2024-02-01",
  mortality = 0,
  weight = 2000,
) {
  return post(owner, "records", {
    organizationId: org,
    unitId: u,
    recordedOn: date,
    mortality,
    feedKg: date === "2024-02-01" ? 10 : 20,
    averageWeightG: weight,
    sampleSize: 10,
    eggs: 0,
    cracked: 0,
    waterQuality: null,
    notes: "Synthetic original processing cohort observation",
  });
}
async function event(values: Record<string, unknown> = {}, u = unit) {
  const h = await snapshot(u);
  return {
    organizationId: org,
    unitId: u,
    eventId: randomUUID(),
    kind: "harvest",
    quantity: 10,
    weightKg: "20",
    priceBasis: "unpriced",
    pricePerUnit: null,
    reference: null,
    customer: null,
    date: h.summary.asOf,
    description: "Synthetic weighed source harvest",
    reason: "Synthetic reviewed source event",
    evidence: "Synthetic harvest register",
    expectedPosition: h.summary.expectedPosition,
    expectedDailyId: h.summary.expectedDailyId,
    ...values,
  };
}
async function newHarvest(u = unit, values: Record<string, unknown> = {}) {
  return (
    await (
      await post(owner, "broilers/lifecycle", await event(values, u))
    ).json()
  ).id;
}
async function payload(
  harvestId = harvest,
  u = unit,
): Promise<ProcessingInput> {
  const h = await snapshot(u);
  return {
    organizationId: org,
    unitId: u,
    reviewId: randomUUID(),
    harvestId,
    previousId:
      (h.processingReviews ?? [])
        .filter((r) => r.harvest_id === harvestId)
        .at(-1)?.id ?? null,
    expectedPosition: h.summary.expectedPosition,
    expectedDailyId: h.summary.expectedDailyId,
    data: processingFixture(),
  };
}
const direct = (
  actor: string,
  p: ProcessingInput,
  extra = "",
  values: unknown[] = [],
) =>
  tenant(actor, (c) =>
    c.query(
      `INSERT INTO broiler_processing_reviews(id,organization_id,unit_id,harvest_id,previous_id,expected_position,expected_daily_id,input${extra}) VALUES($1,$2,$3,$4,$5,$6,$7,$8${values.map((_, i) => ",$" + (i + 9)).join("")}) RETURNING *`,
      [
        p.reviewId,
        p.organizationId,
        p.unitId,
        p.harvestId,
        p.previousId,
        p.expectedPosition,
        p.expectedDailyId,
        JSON.stringify(p.data),
        ...values,
      ],
    ),
  );
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
        "SELECT create_organization('Synthetic measured processing') AS id",
      ),
    )
  ).rows[0].id;
  foreign = (
    await tenant(outsider, (c) =>
      c.query(
        "SELECT create_organization('Foreign measured processing') AS id",
      ),
    )
  ).rows[0].id;
  await admin.query(
    "INSERT INTO memberships VALUES($1,$2,'worker'),($1,$3,'auditor')",
    [org, worker, auditor],
  );
  farm = (
    await tenant(owner, (c) =>
      c.query(
        "INSERT INTO farms(organization_id,name,kind) VALUES($1,'Synthetic processing farm','broilers') RETURNING id",
        [org],
      ),
    )
  ).rows[0].id;
  unit = await stocked();
  await daily();
  harvest = await newHarvest();
  priced = await newHarvest(unit, {
    quantity: 5,
    weightKg: "10",
    priceBasis: "kg",
    pricePerUnit: "0",
    reference: "SYNTHETIC-PRICED-ZERO",
    customer: "Synthetic buyer",
  });
  await daily(unit, "2024-02-02", 0, 2500);
  const ff = (
      await tenant(outsider, (c) =>
        c.query(
          "INSERT INTO farms(organization_id,name,kind) VALUES($1,'Foreign processing farm','broilers') RETURNING id",
          [foreign],
        ),
      )
    ).rows[0].id,
    fu = await stocked(outsider, foreign, ff);
  foreignHarvest = (
    await (
      await post(outsider, "broilers/lifecycle", {
        organizationId: foreign,
        unitId: fu,
        eventId: randomUUID(),
        kind: "harvest",
        date: "2024-02-01",
        quantity: 10,
        weightKg: "20",
        priceBasis: "unpriced",
        pricePerUnit: null,
        reference: null,
        customer: null,
        description: "Foreign weighed source",
        reason: "Foreign synthetic reviewed source",
        evidence: "Foreign synthetic record",
        expectedPosition: "0",
        expectedDailyId: null,
      })
    ).json()
  ).id;
  const plan = await (
      await post(owner, "broilers/plans", {
        organizationId: org,
        unitId: unit,
        planId: randomUUID(),
        previousId: null,
        data: planFixture(),
      })
    ).json(),
    budget = await (
      await post(owner, "broilers/economics", {
        organizationId: org,
        unitId: unit,
        scenarioId: randomUUID(),
        previousId: null,
        planId: plan.source.id,
        data: economicsFixture(),
      })
    ).json();
  planPath = `broilers/plans?organizationId=${org}&unitId=${unit}&planId=${plan.source.id}&format=csv`;
  budgetPath = `broilers/economics?organizationId=${org}&unitId=${unit}&scenarioId=${budget.source.id}&format=csv`;
  const fetchPath = async (path: string) =>
    (await productionApi(
      new NextRequest("http://localhost/api/" + path),
      { id: owner },
      path.split("?")[0],
    ))!;
  oldPlan = await (await fetchPath(planPath)).text();
  oldBudget = await (await fetchPath(budgetPath)).text();
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
it("saves measured full-harvest outputs once without additional birds, feed, live weights, sales or FCR changes", async () => {
  const before = await snapshot(),
    p = await payload(),
    r = await post(owner, "broilers/processing", p);
  expect(r.status).toBe(201);
  const after = await snapshot(),
    out = await report();
  expect(after.records).toEqual(before.records);
  expect(after.events).toEqual(before.events);
  expect(after.originalRecords).toEqual(before.originalRecords);
  expect(after.summary).toMatchObject({
    balance: 85,
    feedKg: "30.000000",
    cohortGainKg: "142.500000",
    fcr: "0.210526",
    asOf: "2024-02-02",
  });
  expect(after.summary.expectedPosition).not.toBe(
    before.summary.expectedPosition,
  );
  expect(out.results.lots[0].metrics).toMatchObject({
    inputBirds: 10,
    inputLiveKg: "20.000000",
    totalOutputKg: "17.000000",
    intendedSaleKg: "16.000000",
    primaryYieldFraction: "0.70000000",
    massState: "balanced",
    unreconciledKg: "0.000000",
  });
  expect(after.processingReviews![0].harvest_snapshot).toEqual(
    before.events.find((e) => e.id === harvest),
  );
});
it("normalizes receipt retries with one audit and refuses changed claims against the same receipt", async () => {
  const p = await payload();
  expect((await post(owner, "broilers/processing", p)).status).toBe(201);
  const count = async () =>
      (
        await tenant(owner, (c) =>
          c.query(
            "SELECT count(*) FROM audit_logs WHERE organization_id=$1 AND action='broiler.processing_record'",
            [org],
          ),
        )
      ).rows[0].count,
    before = await count();
  if (p.data.kind === "record") {
    p.data.residualKg = "3.000000";
    p.data.products[0].weightKg = "14.000000";
  }
  expect((await post(owner, "broilers/processing", p)).status).toBe(200);
  expect(await count()).toBe(before);
  await expect(
    post(owner, "broilers/processing", {
      ...p,
      data: { ...p.data, reason: "Different measured source" },
    }),
  ).rejects.toMatchObject({ status: 409 });
});
it("denies priced including zero-priced and real foreign/cross-batch sources, invalid mass, dates or fabricated outputs", async () => {
  const p = await payload();
  for (const id of [priced, foreignHarvest, randomUUID()])
    await expect(
      post(owner, "broilers/processing", { ...p, harvestId: id }),
    ).rejects.toMatchObject({ status: 404 });
  const other = await stocked();
  await expect(
    post(owner, "broilers/processing", {
      ...p,
      unitId: other,
      expectedPosition: "0",
      expectedDailyId: null,
    }),
  ).rejects.toMatchObject({ status: 404 });
  const data = processingFixture();
  data.products[0].weightKg = "14.000001";
  await expect(
    post(owner, "broilers/processing", { ...p, data }),
  ).rejects.toMatchObject({ status: 400 });
  for (const date of ["2024-01-31", "2999-01-01"])
    await expect(
      post(owner, "broilers/processing", {
        ...p,
        data: { ...processingFixture(), processedOn: date },
      }),
    ).rejects.toMatchObject({ status: 400 });
  await expect(
    post(owner, "broilers/processing", { ...p, profit: 900 }),
  ).rejects.toHaveProperty("issues");
});
it("proves populated owner/auditor RLS versus outsiders and write-role boundaries", async () => {
  expect(
    (await report(unit, auditor)).source.processingReviews!.length,
  ).toBeGreaterThan(0);
  expect(
    (
      await tenant(outsider, (c) =>
        c.query(
          "SELECT * FROM broiler_processing_reviews WHERE organization_id=$1",
          [org],
        ),
      )
    ).rowCount,
  ).toBe(0);
  await expect(report(unit, outsider)).rejects.toMatchObject({ status: 404 });
  for (const actor of [worker, auditor, outsider])
    await expect(
      post(actor, "broilers/processing", await payload()),
    ).rejects.toMatchObject({ status: 403 });
});
it("appends complete corrections preserving original mass and explicit unknown versus unreconciled states", async () => {
  const before = await snapshot(),
    p = await payload();
  if (p.data.kind === "record") p.data.products[0].weightKg = "13.5";
  await post(owner, "broilers/processing", p);
  let out = await report();
  expect(out.results.lots[0].metrics).toMatchObject({
    unreconciledKg: "0.500000",
    measuredResidualKg: "3.000000",
    massState: "unreconciled",
  });
  expect(out.source.processingReviews!.slice(0, 2)).toEqual(
    before.processingReviews,
  );
  const next = await payload();
  if (next.data.kind === "record") {
    next.data.products[0].weightKg = null;
    next.data.residualKg = "0";
  }
  await post(owner, "broilers/processing", next);
  out = await report();
  expect(out.results.lots[0].metrics).toMatchObject({
    primaryOutputKg: null,
    intendedSaleKg: null,
    totalOutputKg: null,
    knownAccountedKg: "3.000000",
    unreconciledKg: null,
    massState: "incomplete",
  });
});
it("serializes API and distinct direct-runtime harvest targets against one loaded unit state", async () => {
  const u = await stocked();
  await daily(u);
  const a = await newHarvest(u),
    b = await newHarvest(u),
    pa = await payload(a, u),
    pb = await payload(b, u),
    r = await Promise.allSettled([
      post(owner, "broilers/processing", pa),
      post(owner, "broilers/processing", pb),
    ]);
  expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(r.find((x) => x.status === "rejected")).toMatchObject({
    reason: { status: 409 },
  });
  const da = await payload(a, u),
    db = await payload(b, u),
    directRace = await Promise.allSettled([
      direct(owner, da),
      direct(owner, db),
    ]);
  expect(directRace.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(directRace.find((x) => x.status === "rejected")).toMatchObject({
    reason: { code: "23505" },
  });
});
it("withdraws erroneous measurements without physically returning birds and re-records through the same harvest chain", async () => {
  const p = await payload(),
    before = await snapshot();
  p.data = {
    kind: "withdraw",
    reason: "Synthetic erroneous measurement withdrawn",
    evidence: "Synthetic correction register",
  };
  await post(owner, "broilers/processing", p);
  let h = await snapshot();
  expect(h.summary.balance).toBe(before.summary.balance);
  expect(h.events).toEqual(before.events);
  expect((await report()).results.lots[0]).toMatchObject({
    sourceState: "withdrawn",
    metrics: null,
  });
  await expect(
    post(owner, "broilers/processing", { ...(await payload()), data: p.data }),
  ).rejects.toMatchObject({ status: 409 });
  const next = await payload();
  await post(owner, "broilers/processing", next);
  h = await snapshot();
  expect(h.processingReviews!.at(-1)?.previous_id).toBe(p.reviewId);
  expect((await report()).results.lots).toHaveLength(1);
});
it("blocks API and direct source-harvest voids until erroneous processing is withdrawn and preserves inactive lineage", async () => {
  const u = await stocked();
  await daily(u);
  const hid = await newHarvest(u),
    p = await payload(hid, u);
  await post(owner, "broilers/processing", p);
  const h = await snapshot(u);
  expect(h.summary.voidable).not.toContain(hid);
  const v = await event(
    {
      kind: "void",
      voidOfId: hid,
      quantity: undefined,
      weightKg: undefined,
      priceBasis: undefined,
      pricePerUnit: undefined,
      reference: undefined,
      customer: undefined,
    },
    u,
  );
  await expect(post(owner, "broilers/lifecycle", v)).rejects.toMatchObject({
    status: 409,
  });
  await expect(
    tenant(owner, (c) =>
      c.query(
        "INSERT INTO broiler_events(id,organization_id,unit_id,kind,recorded_on,expected_position,expected_daily_id,void_of_id,description,reason,evidence,submission) VALUES($1,$2,$3,'void','2024-02-01',$4,$5,$6,'Synthetic direct void','Synthetic source guard','Synthetic evidence','{}')",
        [
          randomUUID(),
          org,
          u,
          h.summary.expectedPosition,
          h.summary.expectedDailyId,
          hid,
        ],
      ),
    ),
  ).rejects.toMatchObject({ code: "23514" });
  const withdraw = await payload(hid, u);
  withdraw.data = {
    kind: "withdraw",
    reason: "Synthetic record was erroneous",
    evidence: "Synthetic correction source",
  };
  await post(owner, "broilers/processing", withdraw);
  await post(
    owner,
    "broilers/lifecycle",
    await event(
      {
        ...v,
        eventId: randomUUID(),
        expectedPosition: (await snapshot(u)).summary.expectedPosition,
      },
      u,
    ),
  );
  expect((await snapshot(u)).summary.balance).toBe(100);
  expect((await report(u)).results.lots[0].sourceState).toBe("inactive");
  await expect(
    post(owner, "broilers/processing", await payload(hid, u)),
  ).rejects.toMatchObject({ status: 404 });
  expect((await post(owner, "broilers/processing", p)).status).toBe(200);
});
it("independently validates direct shape, mass, actor/time, immutable rows and database-derived source/receipt snapshots", async () => {
  const p = await payload();
  for (const actor of [worker, auditor, outsider])
    await expect(direct(actor, p)).rejects.toHaveProperty("code");
  for (const [field, value] of [
    [",created_by", auditor],
    [",created_at", "2024-01-01"],
  ])
    await expect(direct(owner, p, field, [value])).rejects.toMatchObject({
      code: "42501",
    });
  const excess = processingFixture();
  excess.products[0].weightKg = "14.000001";
  for (const data of [
    excess,
    { ...processingFixture(), scope: "partial-harvest" },
    { ...processingFixture(), residualKg: "-1" },
    {
      ...processingFixture(),
      products: [
        processingFixture().products[0],
        processingFixture().products[0],
      ],
    },
    { ...processingFixture(), processedOn: "2024-01-31" },
    { ...processingFixture(), profit: 1 },
  ])
    await expect(
      direct(owner, { ...p, data } as ProcessingInput),
    ).rejects.toHaveProperty("code");
  const row = (
    await direct(
      owner,
      p,
      ",harvest_snapshot,unit_snapshot,submission,position,revision,timezone",
      [
        '{"weight_kg":"999"}',
        '{"opening_count":999}',
        '{"profit":99}',
        999999,
        99,
        "forged",
      ],
    )
  ).rows[0];
  expect(row.harvest_snapshot.weight_kg).toBe("20.000000");
  expect(row.unit_snapshot.opening_count).toBe(100);
  expect(row.submission.data.products[0].weightKg).toBe("14.000000");
  expect(row.submission.profit).toBeUndefined();
  expect(row.position).not.toBe("999999");
  expect(row.timezone).toBe("Africa/Lagos");
  for (const sql of [
    "UPDATE broiler_processing_reviews SET input='{}' WHERE unit_id=$1",
    "DELETE FROM broiler_processing_reviews WHERE unit_id=$1",
  ])
    await expect(
      tenant(owner, (c) => c.query(sql, [unit])),
    ).rejects.toMatchObject({ code: "42501" });
  await expect(
    pool.query("SELECT * FROM broiler_processing_reviews LIMIT 1"),
  ).rejects.toMatchObject({ code: "42501" });
});
it("records observed measurements despite later clinical concerns while preserving the original harvest and live feed window", async () => {
  const u = await stocked();
  await daily(u);
  const treatment = await event(
    {
      kind: "treatment",
      quantity: 1,
      weightKg: undefined,
      priceBasis: undefined,
      pricePerUnit: undefined,
      reference: undefined,
      customer: undefined,
      product: "Synthetic actual product",
      administration: "Synthetic label record",
      earliestHarvestOn: "2024-02-01",
    },
    u,
  );
  await post(owner, "broilers/lifecycle", treatment);
  const hid = await newHarvest(u);
  await post(owner, "broilers/processing", await payload(hid, u));
  const before = await snapshot(u);
  await post(owner, "broilers/recovery", {
    organizationId: org,
    unitId: u,
    eventId: randomUUID(),
    kind: "withdrawal",
    date: "2024-02-02",
    previousId: null,
    treatmentId: treatment.eventId,
    earliestHarvestOn: null,
    reason: "Synthetic later unknown guidance",
    evidence: "Synthetic clinical source",
    expectedPosition: before.summary.expectedPosition,
    expectedDailyId: before.summary.expectedDailyId,
  });
  await post(owner, "broilers/processing", await payload(hid, u));
  const out = await report(u);
  expect(out.results.lots[0].guidance?.currentConcerns).toHaveLength(1);
  expect(out.results.lots[0].metrics?.primaryOutputKg).toBe("14.000000");
  expect((await snapshot(u)).events).toEqual(before.events);
  expect((await snapshot(u)).summary.asOf).toBe("2024-02-02");
});
it("rejects stale lifecycle/recovery/loss writers after processing and enforces the per-harvest version limit", async () => {
  const u = await stocked();
  await daily(u, "2024-02-01", 1);
  const hid = await newHarvest(u),
    h = await snapshot(u),
    oldEvent = await event(
      {
        kind: "health",
        quantity: 1,
        weightKg: undefined,
        priceBasis: undefined,
        pricePerUnit: undefined,
        reference: undefined,
        customer: undefined,
      },
      u,
    );
  await post(owner, "broilers/processing", await payload(hid, u));
  await expect(
    post(owner, "broilers/lifecycle", oldEvent),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    post(owner, "broilers/loss-biomass", {
      organizationId: org,
      unitId: u,
      reviewId: randomUUID(),
      kind: "daily",
      date: "2024-02-01",
      targetEventId: null,
      sourceId: h.records[0].id,
      sourceCount: 1,
      weightKg: "1.2",
      measurementBasis: "whole-bird-at-loss",
      previousId: null,
      expectedPosition: h.summary.expectedPosition,
      expectedDailyId: h.summary.expectedDailyId,
      reason: "Synthetic prior source review",
      evidence: "Synthetic scale record",
    }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    post(owner, "broilers/recovery", {
      organizationId: org,
      unitId: u,
      eventId: randomUUID(),
      kind: "daily",
      date: "2024-02-01",
      previousId: null,
      baseRecordId: h.records[0].id,
      mortality: 1,
      feedKg: "10",
      averageWeightG: "2000",
      sampleSize: 10,
      notes: "Synthetic earlier edit",
      reason: "Synthetic prior observation review",
      evidence: "Synthetic register",
      expectedPosition: h.summary.expectedPosition,
      expectedDailyId: h.summary.expectedDailyId,
    }),
  ).rejects.toMatchObject({ status: 409 });
  await admin.query(
    "UPDATE broiler_processing_reviews SET revision=100 WHERE unit_id=$1",
    [u],
  );
  await expect(
    post(owner, "broilers/processing", await payload(hid, u)),
  ).rejects.toMatchObject({ status: 422 });
  await expect(direct(owner, await payload(hid, u))).rejects.toMatchObject({
    code: "23514",
  });
});
it("rolls back a measurement when its required current source report would exceed the export bound", async () => {
  const u = await stocked();
  await daily(u);
  const hid = await newHarvest(u);
  await post(owner, "broilers/processing", await payload(hid, u));
  await admin.query(
    "UPDATE broiler_processing_reviews SET harvest_snapshot=harvest_snapshot||jsonb_build_object('syntheticSizeFixture',repeat('x',1100000)) WHERE unit_id=$1",
    [u],
  );
  await expect(report(u)).rejects.toMatchObject({ status: 422 });
  const p = await payload(hid, u),
    before = (await snapshot(u)).processingReviews!.length;
  await expect(post(owner, "broilers/processing", p)).rejects.toMatchObject({
    status: 422,
  });
  expect((await snapshot(u)).processingReviews).toHaveLength(before);
  expect(
    (
      await admin.query(
        "SELECT count(*) FROM audit_logs WHERE organization_id=$1 AND object_id=$2",
        [org, p.reviewId],
      )
    ).rows[0].count,
  ).toBe("0");
});
it("exports complete private current-history evidence and keeps original plan/budget bytes after settings and processing revisions", async () => {
  const p = await payload();
  p.data.reason = "=Synthetic original processing scale record";
  await post(owner, "broilers/processing", p);
  const r = await get(auditor, unit, "csv", "broilers/processing"),
    out = await report(unit, auditor),
    { evidenceSha256, ...normalized } = out;
  expect(evidenceSha256).toBe(
    createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
  );
  expect(r.headers.get("cache-control")).toBe("private, no-store");
  expect(r.headers.get("x-evidence-sha256")).toBe(evidenceSha256);
  expect(await r.text()).toContain(
    "'=Synthetic original processing scale record",
  );
  const before = (await snapshot()).processingReviews;
  await tenant(owner, (c) =>
    c.query(
      "UPDATE organizations SET currency='USD',timezone='UTC' WHERE id=$1",
      [org],
    ),
  );
  expect((await snapshot()).processingReviews).toEqual(before);
  for (const [path, old] of [
    [planPath, oldPlan],
    [budgetPath, oldBudget],
  ]) {
    const response = (await productionApi(
      new NextRequest("http://localhost/api/" + path),
      { id: owner },
      path.split("?")[0],
    ))!;
    expect(await response.text()).toBe(old);
  }
  expect((await snapshot()).summary.sales).toEqual({ NGN: "0.0000" });
  expect((await snapshot()).summary.balance).toBe(85);
});
