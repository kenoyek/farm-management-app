import { beforeAll, beforeEach, afterAll, it, expect } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { admin } from "./admin-db";
import { tenant, pool } from "../src/lib/db";
import { feedStockApi } from "../src/lib/feed-stock-api";
import { productionApi } from "../src/lib/production-api";
import {
  feedStockInput,
  type FeedStockInput,
  type FeedStockData,
  type FeedStockWorkspace,
} from "../src/lib/feed-stock";
import { feedReceipt } from "./feed-stock-fixture";
let owner: string,
  outsider: string,
  auditor: string,
  worker: string,
  inventory: string,
  accounts: string,
  org: string,
  farm: string,
  unit: string,
  daily: string;
const organizations: string[] = [];
async function post(p: FeedStockInput, actor = owner) {
  return (await feedStockApi(
    new NextRequest("http://localhost/api/inventory/feed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(p),
    }),
    { id: actor },
    "inventory/feed",
  ))!;
}
async function get(actor = owner, extra = "", organization = org) {
  return (await feedStockApi(
    new NextRequest(
      `http://localhost/api/inventory/feed?organizationId=${organization}${extra}`,
    ),
    { id: actor },
    "inventory/feed",
  ))!;
}
async function workspace(actor = owner): Promise<FeedStockWorkspace> {
  return (await get(actor)).json();
}
async function payload(
  data: FeedStockData = feedReceipt(),
  date = "2024-02-01",
): Promise<FeedStockInput> {
  return {
    organizationId: org,
    eventId: randomUUID(),
    date,
    expectedPosition: (await workspace()).expectedPosition,
    data,
  };
}
async function save(data: FeedStockData = feedReceipt(), date = "2024-02-01") {
  const p = await payload(data, date);
  expect((await post(p)).status).toBe(201);
  return p.eventId;
}
async function consume(
  lotId: string,
  weightKg = "3.123456",
  u = unit,
  date = "2024-02-01",
): Promise<FeedStockData> {
  const w: FeedStockWorkspace = await (
      await get(owner, `&unitId=${u}&sourceDate=${date}`)
    ).json(),
    s = w.sources.find((s) => s.unitId === u && s.date === date)!;
  return {
    kind: "consume",
    lotId,
    unitId: u,
    weightKg,
    expectedSourceSha256: s.sourceSha256,
    scope: "actual-recorded-feed-consumption",
    reason: "Synthetic actual consumed feed allocation",
    evidence:
      "Synthetic exact daily weigh-out record and selected physical lot",
  };
}
const loss = (lotId: string, weightKg = "1"): FeedStockData => ({
  kind: "loss",
  lotId,
  weightKg,
  reason: "Synthetic measured spoiled feed quantity",
  evidence: "Synthetic original loss scale register",
});
const voided = (voidOfId: string): FeedStockData => ({
  kind: "void",
  voidOfId,
  reason: "Synthetic erroneous feed entry did not occur",
  evidence: "Synthetic original corrected physical movement evidence",
});
async function direct(
  p: FeedStockInput,
  actor = owner,
  extra = "",
  values: unknown[] = [],
) {
  return tenant(actor, (c) =>
    c.query(
      `INSERT INTO feed_stock_events(id,organization_id,lot_id,recorded_on,expected_position,input${extra}) VALUES($1,$2,$1,$3,$4,$5${values.map((_, i) => ",$" + (i + 6)).join("")}) RETURNING *`,
      [
        p.eventId,
        p.organizationId,
        p.date,
        p.expectedPosition,
        JSON.stringify(p.data),
        ...values,
      ],
    ),
  );
}
async function correction(
  feedKg: number,
  notes = "Synthetic corrected actual feed observation",
) {
  const s = await (await productionApi(
    new NextRequest(
      `http://localhost/api/broilers/lifecycle?organizationId=${org}&unitId=${unit}`,
    ),
    { id: owner },
    "broilers/lifecycle",
  ))!.json();
  return (await productionApi(
    new NextRequest("http://localhost/api/broilers/recovery", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        organizationId: org,
        unitId: unit,
        eventId: randomUUID(),
        date: "2024-02-01",
        expectedPosition: s.summary.expectedPosition,
        expectedDailyId: s.summary.expectedDailyId,
        kind: "daily",
        baseRecordId: daily,
        previousId: null,
        mortality: 0,
        feedKg: String(feedKg),
        averageWeightG: "2000",
        sampleSize: 10,
        notes,
        reason: "Synthetic reviewed complete daily correction",
        evidence: "Synthetic original corrected complete daily record",
      }),
    }),
    { id: owner },
    "broilers/recovery",
  ))!;
}
beforeAll(async () => {
  [owner, outsider, auditor, worker, inventory, accounts] = (
    await admin.query(
      "INSERT INTO users(email,password_hash) SELECT x,'fixture' FROM unnest($1::text[]) x RETURNING id",
      [Array.from({ length: 6 }, () => randomUUID() + "@test.invalid")],
    )
  ).rows.map((r) => r.id);
});
beforeEach(async () => {
  org = (
    await tenant(owner, (c) =>
      c.query(
        "SELECT create_organization('Synthetic feed stock fixture') AS id",
      ),
    )
  ).rows[0].id;
  organizations.push(org);
  await admin.query(
    "INSERT INTO memberships VALUES($1,$2,'auditor'),($1,$3,'worker'),($1,$4,'inventory'),($1,$5,'accounts')",
    [org, auditor, worker, inventory, accounts],
  );
  farm = (
    await tenant(owner, (c) =>
      c.query(
        "INSERT INTO farms(organization_id,name,kind) VALUES($1,'Synthetic feed farm','broilers') RETURNING id",
        [org],
      ),
    )
  ).rows[0].id;
  unit = (
    await tenant(owner, (c) =>
      c.query(
        "INSERT INTO production_units(organization_id,farm_id,name,kind,stocked_on,opening_count,initial_weight_g) VALUES($1,$2,'Synthetic feed batch','broilers','2024-02-01',100,1000) RETURNING id",
        [org, farm],
      ),
    )
  ).rows[0].id;
  daily = (
    await tenant(owner, (c) =>
      c.query(
        "INSERT INTO daily_records(organization_id,unit_id,recorded_on,mortality,eggs,cracked,feed_kg,average_weight_g,sample_size,notes) VALUES($1,$2,'2024-02-01',0,0,0,10,2000,10,'Synthetic original feed record') RETURNING id",
        [org, unit],
      ),
    )
  ).rows[0].id;
});
afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])", [
    organizations,
  ]);
  await admin.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
    [owner, outsider, auditor, worker, inventory, accounts],
  ]);
  await pool.end();
  await admin.end();
});
it("derives exact lot quantities/cost, immutable actual daily source and original currency", async () => {
  const lot = await save(),
    before = (
      await tenant(owner, (c) =>
        c.query("SELECT * FROM effective_daily_records WHERE unit_id=$1", [
          unit,
        ]),
      )
    ).rows;
  const id = await save(await consume(lot));
  const w = await workspace(),
    e = w.report.events.find((e) => e.id === id)!;
  expect(e).toMatchObject({
    weight_kg: "3.123456",
    amount: "9.3704",
    currency: "NGN",
    unit_id: unit,
  });
  const source = await tenant(owner, (c) =>
    c.query(
      "SELECT feed_consumption_source($1,$2,'2024-02-01') AS source,encode(sha256(convert_to(feed_consumption_source($1,$2,'2024-02-01')::text,'UTF8')),'hex') AS sha",
      [org, unit],
    ),
  );
  expect(e.source_snapshot).toEqual(source.rows[0].source);
  expect(e.source_sha256).toBe(source.rows[0].sha);
  expect(w.report.results.lots[0]).toMatchObject({
    balanceKg: "96.876544",
    remainingValue: "290.6297",
  });
  expect(w.sources[0]).toMatchObject({
    issuedKg: "3.123456",
    unlinkedKg: "6.876544",
    sourceChanged: false,
  });
  expect(
    (
      await tenant(owner, (c) =>
        c.query("SELECT * FROM effective_daily_records WHERE unit_id=$1", [
          unit,
        ]),
      )
    ).rows,
  ).toEqual(before);
  expect(
    (
      await tenant(owner, (c) =>
        c.query(
          "SELECT * FROM financial_journal_entries WHERE organization_id=$1",
          [org],
        ),
      )
    ).rows,
  ).toEqual([]);
});
it("normalizes exact receipts, audits once and refuses changed retry values", async () => {
  const p = await payload({
    ...feedReceipt(),
    reason: "  Synthetic exact purchase review  ",
  });
  await post(p);
  const count = async () =>
    (
      await tenant(owner, (c) =>
        c.query(
          "SELECT action,object_id FROM audit_logs WHERE organization_id=$1 ORDER BY id",
          [org],
        ),
      )
    ).rows;
  const before = await count();
  expect((await post(p)).status).toBe(200);
  expect(await count()).toEqual(before);
  expect((await workspace()).report.events).toHaveLength(1);
  await expect(
    post({ ...p, data: { ...p.data, evidence: "Synthetic changed evidence" } }),
  ).rejects.toMatchObject({ status: 409 });
});
it("enforces populated RLS and role-specific purchase/valuation access", async () => {
  await save();
  for (const actor of [owner, inventory, auditor, accounts])
    expect((await workspace(actor)).report.events).toHaveLength(1);
  for (const actor of [worker, outsider]) {
    await expect(get(actor)).rejects.toMatchObject({ status: 403 });
    expect(
      (
        await tenant(actor, (c) =>
          c.query("SELECT id FROM feed_stock_events WHERE organization_id=$1", [
            org,
          ]),
        )
      ).rows,
    ).toEqual([]);
  }
  const p = await payload();
  expect((await post(p, inventory)).status).toBe(201);
  for (const actor of [worker, auditor, accounts, outsider])
    await expect(direct(await payload(), actor)).rejects.toMatchObject({
      code: "42501",
    });
});
it("reserves unique purchase references across voids and rejects future/older lot movement dates", async () => {
  const r = feedReceipt(),
    lot = await save(r);
  await expect(direct(await payload(r))).rejects.toMatchObject({
    code: "23505",
  });
  await save(loss(lot), "2024-02-03");
  await expect(
    direct(await payload(loss(lot), "2024-02-02")),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    direct(await payload(feedReceipt(), "2999-01-01")),
  ).rejects.toMatchObject({ code: "23514" });
});
it("serializes API and direct competing organization heads without double depletion", async () => {
  const lot = await save(),
    a = await payload(loss(lot, "60")),
    b = await payload(loss(lot, "60"));
  const results = await Promise.allSettled([post(a), direct(b)]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await workspace()).report.results.lots[0].balanceKg).toBe(
    "40.000000",
  );
  await expect(
    direct(await payload(loss(lot, "40.000001"))),
  ).rejects.toMatchObject({ code: "23514" });
});
it("conserves the four-place residual across complete depletion and erroneous reversal/reissue", async () => {
  const lot = await save({
    ...feedReceipt(),
    weightKg: "3",
    totalCost: "0.0001",
  });
  await save(loss(lot, "1"));
  const second = await save(loss(lot, "1"));
  await save(voided(second));
  await save(loss(lot, "1"));
  await save(loss(lot, "1"));
  const w = await workspace();
  expect(w.report.results.lots[0]).toMatchObject({
    balanceKg: "0.000000",
    lostKg: "3.000000",
    lostValue: "0.0001",
    remainingValue: "0.0000",
  });
  expect(w.report.events.filter((e) => e.kind === "void")[0].amount).toBe(
    "0.0001",
  );
});
it("keeps unknown lots and evidenced-zero lots distinct in full consumed/stock coverage", async () => {
  const unknown = await save({
      ...feedReceipt(),
      totalCost: null,
      costEvidence: null,
    }),
    zero = await save({ ...feedReceipt(), totalCost: "0" });
  await save(await consume(unknown, "4"));
  await save(await consume(zero, "6"));
  const w = await workspace();
  expect(w.report.results.currencies[0]).toMatchObject({
    unknownValueLots: 1,
    unknownConsumedKg: "4.000000",
    knownConsumedValue: "0.0000",
    unknownRemainingKg: "96.000000",
  });
  expect(w.report.results.lots[0].consumedValue).toBeNull();
  expect(w.report.results.lots[1].consumedValue).toBe("0.0000");
  await expect(
    direct(await payload(await consume(zero, "0.000001"))),
  ).rejects.toMatchObject({ code: "23514" });
});
it("prevents overlinking one actual feed record across different lots under a current head", async () => {
  const a = await save(),
    b = await save();
  await save(await consume(a, "6"));
  await expect(
    direct(await payload(await consume(b, "4.000001"))),
  ).rejects.toMatchObject({ code: "23514" });
  await save(await consume(b, "4"));
  expect((await workspace()).sources[0]).toMatchObject({
    issuedKg: "10.000000",
    unlinkedKg: "0.000000",
  });
});
it("requires exact current source metadata and exposes later corrected overlinked feed honestly", async () => {
  const lot = await save(),
    stale = await payload(await consume(lot, "5"));
  expect(
    (await correction(10, "Synthetic metadata-only daily correction")).status,
  ).toBe(201);
  await expect(post(stale)).rejects.toMatchObject({ status: 409 });
  const fresh = await payload(await consume(lot, "9"));
  await post(fresh);
  const exact = await (await get(owner, "&format=json")).text();
  const w = await workspace();
  await tenant(owner, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [unit]);
    await c.query(
      "INSERT INTO broiler_reviews(id,organization_id,unit_id,kind,observed_on,previous_id,base_record_id,mortality,feed_kg,average_weight_g,sample_size,notes,expected_position,expected_daily_id,reason,evidence,submission) SELECT $1,$2,$3,'daily','2024-02-01',r.id,$4,0,4,2000,10,'Synthetic corrected lower feed',broiler_latest_position($3),(SELECT id FROM effective_daily_records WHERE unit_id=$3 ORDER BY recorded_on DESC LIMIT 1),'Synthetic reviewed complete lower feed record','Synthetic original complete correction evidence','{}' FROM current_broiler_reviews r WHERE r.unit_id=$3 AND r.kind='daily'",
      [randomUUID(), org, unit, daily],
    );
  });
  const after = await workspace();
  expect(after.changedSources[0]).toMatchObject({
    feedKg: "4.000000",
    issuedKg: "9.000000",
    overlinkedKg: "5.000000",
    sourceChanged: true,
  });
  expect(after.report.events).toEqual(w.report.events);
  expect(
    await (
      await get(
        owner,
        `&format=json&asOf=${w.report.asOf}&throughPosition=${w.report.throughPosition}`,
      )
    ).text(),
  ).toBe(exact);
  await expect(
    direct(await payload(await consume(lot, "1"))),
  ).rejects.toMatchObject({ code: "23514" });
});
it("preserves frozen JSON/CSV bytes through source correction, settings, voids and later backdating", async () => {
  const lot = await save(),
    id = await save(await consume(lot)),
    w = await workspace(),
    query = `&asOf=2024-02-01&throughPosition=${w.expectedPosition}`,
    json = await (await get(owner, query + "&format=json")).text(),
    csv = await (await get(owner, query + "&format=csv")).text();
  await save(voided(id), "2024-02-03");
  await tenant(owner, (c) =>
    c.query(
      "UPDATE organizations SET currency='USD',timezone='UTC' WHERE id=$1",
      [org],
    ),
  );
  await save({ ...feedReceipt(), currency: "USD" });
  await correction(7);
  expect(await (await get(owner, query + "&format=json")).text()).toBe(json);
  expect(await (await get(auditor, query + "&format=csv")).text()).toBe(csv);
  expect(
    (await get(auditor, query + "&format=csv")).headers.get("Cache-Control"),
  ).toBe("private, no-store");
  const r = JSON.parse(json),
    { evidenceSha256, ...normalized } = r;
  expect(
    createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
  ).toBe(evidenceSha256);
  expect((await workspace()).report.results.currencies).toHaveLength(2);
});
it("forbids voids of voids and receipts with genuine dependent consumption/loss", async () => {
  const lot = await save(),
    id = await save(await consume(lot));
  await expect(direct(await payload(voided(lot)))).rejects.toMatchObject({
    code: "23514",
  });
  const v = await save(voided(id));
  await expect(direct(await payload(voided(v)))).rejects.toMatchObject({
    code: "23514",
  });
  await save(voided(lot));
  expect((await workspace()).report.results.lots[0].active).toBe(false);
});
it("derives all forged fields and denies role, actor, time, update and delete bypasses", async () => {
  const p = await payload(),
    r = await direct(
      p,
      owner,
      ",kind,position,amount,currency,source_snapshot,source_sha256,unit_id",
      ["consume", 999999, "999", "USD", { forged: true }, "a".repeat(64), unit],
    );
  expect(r.rows[0]).toMatchObject({
    kind: "receipt",
    amount: "300.0001",
    currency: "NGN",
    source_snapshot: null,
    source_sha256: null,
    unit_id: null,
  });
  for (const [extra, values] of [
    [",created_by", [worker]],
    [",created_at", ["2024-01-01"]],
  ] as [string, unknown[]][])
    await expect(
      direct(await payload(), owner, extra, values),
    ).rejects.toMatchObject({ code: "42501" });
  await expect(
    tenant(owner, (c) =>
      c.query("UPDATE feed_stock_events SET amount=0 WHERE id=$1", [p.eventId]),
    ),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    tenant(owner, (c) =>
      c.query("DELETE FROM feed_stock_events WHERE id=$1", [p.eventId]),
    ),
  ).rejects.toMatchObject({ code: "42501" });
});
it("rejects real cross-tenant lots, units and claimed source snapshots", async () => {
  const foreign = (
    await tenant(outsider, (c) =>
      c.query("SELECT create_organization('Synthetic foreign feed') AS id"),
    )
  ).rows[0].id;
  organizations.push(foreign);
  const fp = {
    ...(await payload()),
    organizationId: foreign,
    data: feedReceipt(),
  };
  await post(fp, outsider);
  await expect(direct(await payload(loss(fp.eventId)))).rejects.toMatchObject({
    code: "23514",
  });
  const lot = await save(),
    data = await consume(lot);
  if (data.kind !== "consume") throw Error();
  await expect(
    direct(await payload({ ...data, unitId: randomUUID() })),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(get(owner, "&format=json", foreign)).rejects.toMatchObject({
    status: 403,
  });
});
it("keeps source derivation fixed to the real schema under caller temporary shadow tables", async () => {
  const lot = await save(),
    p = await payload(await consume(lot));
  await tenant(owner, async (c) => {
    await c.query(
      "CREATE TEMP TABLE effective_daily_records AS SELECT * FROM effective_daily_records WHERE false",
    );
    await c.query(
      "CREATE TEMP TABLE production_units AS SELECT * FROM production_units WHERE false",
    );
    await c.query("SET LOCAL search_path=pg_temp,public");
    await c.query(
      "INSERT INTO feed_stock_events(id,organization_id,lot_id,recorded_on,expected_position,input) VALUES($1,$2,$1,$3,$4,$5)",
      [p.eventId, org, p.date, p.expectedPosition, JSON.stringify(p.data)],
    );
    await c.query(
      "DROP TABLE pg_temp.effective_daily_records,pg_temp.production_units",
    );
  });
  expect(
    (await workspace()).report.events.at(-1)?.source_snapshot,
  ).toMatchObject({
    unit: { id: unit },
    record: { id: daily, feed_kg: "10.000000" },
  });
});
it("rejects malformed direct quantities, source scopes, receipt costs and extra fields", async () => {
  for (const patch of [
    { weightKg: "0" },
    { weightKg: "1.0000001" },
    { totalCost: null },
    { totalCost: "-1" },
    { currency: "ngn" },
    { scope: "forecast" },
    { totalCost: "1.00001" },
    { extra: "invented" },
  ]) {
    const p = await payload();
    p.data = { ...p.data, ...patch } as FeedStockData;
    await expect(direct(p)).rejects.toMatchObject({ code: "23514" });
  }
  const p = await payload();
  expect(feedStockInput.safeParse({ ...p, date: "2024-02-30" }).success).toBe(
    false,
  );
});
it("rolls back stock and audit when its mandatory frozen report would exceed the evidence bound", async () => {
  await save();
  const first = await workspace(),
    frozen = `&asOf=${first.report.asOf}&throughPosition=${first.expectedPosition}&format=json`,
    original = await (await get(owner, frozen)).text();
  let bytes = 0;
  while (bytes < 1010000) {
    const p = await payload({
      ...feedReceipt(),
      reason: "x".repeat(2000),
      evidence: "x".repeat(2000),
      costEvidence: "x".repeat(2000),
    });
    await direct(feedStockInput.parse(p));
    bytes = Buffer.byteLength(await (await get(owner, "&format=json")).text());
  }
  const p = await payload({
    ...feedReceipt(),
    feedName: "田".repeat(200),
    supplier: "田".repeat(200),
    reason: "田".repeat(1300),
    evidence: "x".repeat(2000),
    costEvidence: "x".repeat(2000),
  });
  // Input remains below its independent JSONB bound; repeated full evidence takes the report over 1 MiB.
  await expect(post(p)).rejects.toMatchObject({ status: 422 });
  expect(
    (
      await admin.query("SELECT id FROM feed_stock_events WHERE id=$1", [
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
  expect(await (await get(auditor, frozen)).text()).toBe(original);
});
