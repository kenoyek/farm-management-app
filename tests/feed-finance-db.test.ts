import { beforeAll, beforeEach, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { admin } from "./admin-db";
import { tenant, pool } from "../src/lib/db";
import { feedStockApi } from "../src/lib/feed-stock-api";
import { productionApi } from "../src/lib/production-api";
import {
  type FeedStockInput,
  type FeedStockData,
  type FeedStockWorkspace,
} from "../src/lib/feed-stock";
import { financialJournalApi } from "../src/lib/financial-journal-api";
import {
  journalInput,
  type JournalInput,
  type JournalData,
  type JournalWorkspace,
} from "../src/lib/financial-journal";
import { manualJournal } from "./financial-journal-fixture";
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
async function finGet(actor = owner, extra = "", organization = org) {
  return (await financialJournalApi(
    new NextRequest(
      `http://localhost/api/finance/journal?organizationId=${organization}${extra}`,
    ),
    { id: actor },
    "finance/journal",
  ))!;
}
async function fin(): Promise<JournalWorkspace> {
  return (await finGet()).json();
}
async function fp(data: JournalData): Promise<JournalInput> {
  return {
    organizationId: org,
    entryId: randomUUID(),
    expectedPosition: (await fin()).expectedPosition,
    data,
  };
}
async function fpost(p: JournalInput, actor = owner) {
  return (await financialJournalApi(
    new NextRequest("http://localhost/api/finance/journal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(p),
    }),
    { id: actor },
    "finance/journal",
  ))!;
}
async function fdirect(p: JournalInput, extra = "", values: unknown[] = []) {
  return tenant(owner, (c) =>
    c.query(
      `INSERT INTO financial_journal_entries(id,organization_id,expected_position,input${extra}) VALUES($1,$2,$3,$4${values.map((_, i) => ",$" + (i + 5)).join("")}) RETURNING *`,
      [
        p.entryId,
        p.organizationId,
        p.expectedPosition,
        JSON.stringify(p.data),
        ...values,
      ],
    ),
  );
}
function rec(
  sourceId: string,
  purchase: "payables" | "cash_bank" | null = "payables",
  treatment: "expense" | "work_in_progress" | null = null,
): JournalData {
  return {
    kind: "recognize_feed",
    sourceId,
    purchaseSettlement: purchase,
    consumptionTreatment: treatment,
    paymentEvidence:
      purchase === "cash_bank" ? "Synthetic original payment evidence" : null,
    policy: "recorded-feed-lot-value-v1",
    reason: "Synthetic evidenced feed financial recognition",
    evidence:
      "Synthetic original source and explicit accounting policy, no duplicate manual booking",
  };
}
const rev = (originalId: string, date = "2024-02-03"): JournalData => ({
  kind: "reverse",
  originalId,
  date,
  reason: "Synthetic original accounting entry correction",
  evidence: "Synthetic original book correction evidence; no physical movement",
});
async function booked(data: JournalData) {
  const p = await fp(data);
  expect((await fpost(p)).status).toBe(201);
  return p.entryId;
}
async function originals() {
  const lot = await save(),
    issue = await save(await consume(lot)),
    lost = await save(loss(lot, "2"));
  return { lot, issue, lost };
}
it("derives original purchase value/date/currency and complete immutable feed/receipt evidence", async () => {
  const lot = await save(),
    before = await (await get(owner, "&format=json")).text(),
    id = await booked(rec(lot)),
    w = await fin(),
    e = w.report.entries.find((e) => e.id === id)!;
  expect(e).toMatchObject({
    source_kind: "feed",
    source_id: lot,
    kind: "recognize_feed",
    posted_on: "2024-02-01",
    currency: "NGN",
    unit_id: null,
    lines: [
      { account: "1200", side: "debit", amount: "300.0001" },
      { account: "2000", side: "credit", amount: "300.0001" },
    ],
  });
  expect(e.source_snapshot).toMatchObject({
    event: { id: lot, amount: "300.0001" },
    lot: { id: lot },
    purchaseRecognitionId: null,
  });
  expect(await (await get(owner, "&format=json")).text()).toBe(before);
  expect(w.feedCoverage).toEqual({
    active: 1,
    recognized: 1,
    unknown: 0,
    changed: 0,
  });
});
it("uses explicit purchase cash evidence and preserves known zero while excluding unknown costs", async () => {
  const zero = await save({ ...feedReceipt(), totalCost: "0" }),
    unknown = await save({
      ...feedReceipt(),
      totalCost: null,
      costEvidence: null,
    });
  const id = await booked(rec(zero, "cash_bank"));
  expect((await fin()).report.entries.find((e) => e.id === id)?.lines).toEqual([
    { account: "1200", side: "debit", amount: "0.0000" },
    { account: "1000", side: "credit", amount: "0.0000" },
  ]);
  await expect(fpost(await fp(rec(unknown)))).rejects.toMatchObject({
    status: 409,
  });
  expect((await fin()).feedCoverage.unknown).toBe(1);
});
it("requires purchase recognition before consumption/loss and derives expense, WIP and stock-loss lines", async () => {
  const { lot, issue, lost } = await originals();
  await expect(
    fpost(await fp(rec(issue, null, "expense"))),
  ).rejects.toMatchObject({ status: 409 });
  const parent = await booked(rec(lot)),
    id = await booked(rec(issue, null, "work_in_progress"));
  await booked(rec(lost, null, null));
  const r = (await fin()).report;
  expect(r.entries.find((e) => e.id === id)).toMatchObject({
    unit_id: unit,
    lines: [
      { account: "1300", side: "debit", amount: "9.3704" },
      { account: "1200", side: "credit", amount: "9.3704" },
    ],
    source_snapshot: {
      purchaseRecognitionId: parent,
      event: { id: issue, source_snapshot: { record: { id: daily } } },
    },
  });
  expect(r.entries.at(-1)?.lines).toEqual([
    { account: "5200", side: "debit", amount: "6.0000" },
    { account: "1200", side: "credit", amount: "6.0000" },
  ]);
  expect(r.trialBalance[0]).toMatchObject({
    debits: "315.3705",
    credits: "315.3705",
  });
});
it("normalizes source receipts, audits once and replays after reversal and physical source void", async () => {
  const lot = await save(),
    p = await fp(rec(lot));
  p.data.reason = "  " + p.data.reason + "  ";
  await fpost(p);
  const audit = async () =>
    (
      await tenant(owner, (c) =>
        c.query("SELECT action,object_id FROM audit_logs WHERE object_id=$1", [
          p.entryId,
        ]),
      )
    ).rows;
  const original = await audit();
  expect((await fpost(p)).status).toBe(200);
  expect(await audit()).toEqual(original);
  await booked(rev(p.entryId));
  await save(voided(lot), "2024-02-03");
  expect((await fpost(p)).status).toBe(200);
  expect(await audit()).toEqual(original);
  await expect(
    fpost({
      ...p,
      data: { ...p.data, evidence: "Synthetic changed receipt claim" },
    }),
  ).rejects.toMatchObject({ status: 409 });
});
it("blocks inventory-officer physical voids without granting financial read access", async () => {
  const lot = await save();
  await booked(rec(lot));
  expect(
    (
      await tenant(inventory, (c) =>
        c.query(
          "SELECT id FROM financial_journal_entries WHERE organization_id=$1",
          [org],
        ),
      )
    ).rows,
  ).toEqual([]);
  expect(
    (
      await tenant(inventory, (c) =>
        c.query("SELECT feed_financial_is_booked($1,$2) AS booked", [org, lot]),
      )
    ).rows[0].booked,
  ).toBe(true);
  await expect(
    post(await payload(voided(lot)), inventory),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    direct(await payload(voided(lot)), inventory),
  ).rejects.toMatchObject({ code: "23514" });
  expect(
    (
      await tenant(outsider, (c) =>
        c.query("SELECT feed_financial_is_booked($1,$2) AS booked", [org, lot]),
      )
    ).rows[0].booked,
  ).toBe(false);
  for (const actor of [inventory, accounts, worker, outsider])
    await expect(finGet(actor)).rejects.toMatchObject({ status: 403 });
  expect((await finGet(auditor)).status).toBe(200);
  await expect(fpost(await fp(rec(lot)), auditor)).rejects.toMatchObject({
    status: 403,
  });
});
it("protects recognized consumption physically and reverses books separately from stock", async () => {
  const { lot, issue } = await originals();
  await booked(rec(lot));
  const id = await booked(rec(issue, null, "expense")),
    before = (await workspace()).report.results.lots[0];
  await expect(
    post(await payload(voided(issue)), inventory),
  ).rejects.toMatchObject({ status: 409 });
  await booked(rev(id));
  expect((await workspace()).report.results.lots[0]).toEqual(before);
  await post(await payload(voided(issue), "2024-02-03"), inventory);
  expect((await workspace()).report.results.lots[0].consumedKg).toBe(
    "0.000000",
  );
});
it("requires dependent accounting reversals first and rejects an earlier purchase reversal date", async () => {
  const { lot, issue, lost } = await originals(),
    parent = await booked(rec(lot)),
    child = await booked(rec(issue, null, "expense")),
    lossBook = await booked(rec(lost, null, null));
  await expect(fpost(await fp(rev(parent)))).rejects.toMatchObject({
    status: 409,
  });
  await booked(rev(child, "2024-02-04"));
  await booked(rev(lossBook, "2024-02-05"));
  await expect(
    fpost(await fp(rev(parent, "2024-02-04"))),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    fdirect(await fp(rev(parent, "2024-02-04"))),
  ).rejects.toMatchObject({ code: "23514" });
  await booked(rev(parent, "2024-02-05"));
  const next = await booked(rec(lot)),
    reb = await booked(rec(issue, null, "expense"));
  expect(
    (await fin()).report.entries.find((e) => e.id === reb)?.source_snapshot,
  ).toMatchObject({ purchaseRecognitionId: next });
});
it("refuses fresh source-changed/overlinked consumption while preserving already-booked historical evidence", async () => {
  const { lot, issue, lost } = await originals();
  await booked(rec(lot));
  const child = await booked(rec(issue, null, "expense")),
    before = await fin(),
    frozen = `&format=json&asOf=${before.report.asOf}&throughPosition=${before.expectedPosition}`,
    bytes = await (await finGet(owner, frozen)).text();
  expect((await correction(2)).status).toBe(201);
  expect(
    (await fin()).feedSources.find((s) => s.source_id === issue),
  ).toBeUndefined();
  const all: JournalWorkspace = await (
    await finGet(owner, "&sourceStatus=all")
  ).json();
  expect(
    all.feedSources.find((s) => s.source_id === issue)?.source_current,
  ).toBe(false);
  expect(all.feedCoverage.changed).toBe(1);
  expect(await (await finGet(owner, frozen)).text()).toBe(bytes);
  await booked(rev(child));
  await expect(
    fpost(await fp(rec(issue, null, "expense"))),
  ).rejects.toMatchObject({ status: 409 });
  await booked(rec(lost, null, null));
});
it("serializes competing direct/API recognition from one journal head", async () => {
  const lot = await save(),
    a = await fp(rec(lot)),
    b = await fp(rec(lot));
  const rr = await Promise.allSettled([fpost(a), fdirect(b)]);
  expect(rr.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await fin()).feedCoverage.recognized).toBe(1);
  await expect(fpost(await fp(rec(lot)))).rejects.toMatchObject({
    status: 409,
  });
});
it("keeps active source and recognition consistent when inventory void races finance recognition", async () => {
  const lot = await save(),
    f = await fp(rec(lot)),
    s = await payload(voided(lot));
  const rr = await Promise.allSettled([fpost(f), post(s, inventory)]);
  expect(rr.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const w = await fin(),
    stock = await workspace();
  expect(
    w.feedCoverage.recognized === 1 &&
      stock.report.results.lots[0].active === false,
  ).toBe(false);
});
it("serializes purchase reversal versus a new dependent loss recognition", async () => {
  const { lot, lost } = await originals(),
    parent = await booked(rec(lot)),
    a = await fp(rev(parent)),
    b = await fp(rec(lost, null, null));
  const rr = await Promise.allSettled([fpost(a), fdirect(b)]);
  expect(rr.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const rows = (await fin()).report.entries,
    child = rows.find(
      (e) => e.kind === "recognize_feed" && e.source_id === lost,
    );
  if (child) expect(rows.some((e) => e.reversal_of_id === parent)).toBe(false);
});
it("derives forged fields from the actual source and prevents cross-tenant recognition", async () => {
  const lot = await save(),
    p = await fp(rec(lot)),
    r = await fdirect(
      p,
      ",kind,unit_id,source_kind,source_id,source_snapshot,currency,lines",
      ["manual", unit, "live", randomUUID(), { invented: true }, "USD", []],
    );
  expect(r.rows[0]).toMatchObject({
    kind: "recognize_feed",
    source_kind: "feed",
    source_id: lot,
    currency: "NGN",
    unit_id: null,
  });
  const foreign = (
    await tenant(outsider, (c) =>
      c.query(
        "SELECT create_organization('Synthetic foreign financial feed') AS id",
      ),
    )
  ).rows[0].id;
  organizations.push(foreign);
  const receipt = {
    ...(await payload()),
    organizationId: foreign,
    data: feedReceipt(),
    expectedPosition: "0",
  };
  await post(receipt, outsider);
  await expect(fpost(await fp(rec(receipt.eventId)))).rejects.toMatchObject({
    status: 409,
  });
  await expect(fdirect(await fp(rec(receipt.eventId)))).rejects.toMatchObject({
    code: "23514",
  });
});
it("keeps source and dependency derivation fixed under temporary schema shadows", async () => {
  const lot = await save(),
    p = await fp(rec(lot));
  await tenant(owner, async (c) => {
    await c.query(
      "CREATE TEMP TABLE feed_stock_events AS SELECT * FROM feed_stock_events WHERE false",
    );
    await c.query(
      "CREATE TEMP TABLE financial_feed_sources AS SELECT * FROM financial_feed_sources WHERE false",
    );
    await c.query("SET LOCAL search_path=pg_temp,public");
    await c.query(
      "INSERT INTO financial_journal_entries(id,organization_id,expected_position,input) VALUES($1,$2,$3,$4)",
      [p.entryId, org, p.expectedPosition, JSON.stringify(p.data)],
    );
    await c.query(
      "DROP TABLE pg_temp.feed_stock_events,pg_temp.financial_feed_sources",
    );
  });
  expect((await fin()).report.entries[0].source_snapshot).toMatchObject({
    event: { id: lot },
  });
});
it("rejects direct policy/settlement/payment/treatment/shape forgeries", async () => {
  const { lot, issue, lost } = await originals();
  for (const patch of [
    { policy: "invent-cost" },
    { amount: "999" },
    { purchaseSettlement: null },
    { purchaseSettlement: "cash_bank", paymentEvidence: null },
    { consumptionTreatment: "expense" },
    { paymentEvidence: "unclaimed" },
  ]) {
    const p = await fp(rec(lot));
    p.data = { ...p.data, ...patch } as JournalData;
    await expect(fdirect(p)).rejects.toMatchObject({ code: "23514" });
  }
  await booked(rec(lot));
  await expect(fdirect(await fp(rec(issue, null, null)))).rejects.toMatchObject(
    { code: "23514" },
  );
  await expect(
    fdirect(await fp(rec(lost, null, "expense"))),
  ).rejects.toMatchObject({ code: "23514" });
});
it("retains old financial/feed JSON and CSV after settings, reversal, void and later entries", async () => {
  const { lot, issue } = await originals(),
    stock = await workspace(),
    feedQuery = `&format=json&asOf=${stock.report.asOf}&throughPosition=${stock.expectedPosition}`,
    feedBytes = await (await get(owner, feedQuery)).text();
  await booked(rec(lot));
  const child = await booked(rec(issue, null, "expense")),
    w = await fin(),
    query = `&asOf=2024-02-01&throughPosition=${w.expectedPosition}`,
    json = await (await finGet(owner, query + "&format=json")).text(),
    csv = await (await finGet(owner, query + "&format=csv")).text();
  await booked(rev(child));
  await save(voided(issue), "2024-02-03");
  await tenant(owner, (c) =>
    c.query(
      "UPDATE organizations SET currency='USD',timezone='UTC' WHERE id=$1",
      [org],
    ),
  );
  await booked({ ...manualJournal(), currency: "USD" });
  expect(await (await finGet(owner, query + "&format=json")).text()).toBe(json);
  expect(await (await finGet(auditor, query + "&format=csv")).text()).toBe(csv);
  expect(await (await get(owner, feedQuery)).text()).toBe(feedBytes);
});
it("rolls back feed recognition and audit if required full financial evidence exceeds its bound", async () => {
  const lot = await save({
    ...feedReceipt(),
    reason: "x".repeat(2000),
    evidence: "x".repeat(2000),
    costEvidence: "x".repeat(2000),
  });
  let bytes = 0;
  while (bytes < 1020000) {
    const p = await fp({
      ...manualJournal(),
      description: "x".repeat(1000),
      reason: "x".repeat(2000),
      evidence: "x".repeat(2000),
    });
    await fdirect(journalInput.parse(p));
    bytes = Buffer.byteLength(
      await (await finGet(owner, "&format=json")).text(),
    );
  }
  const p = await fp(rec(lot));
  await expect(fpost(p)).rejects.toMatchObject({ status: 422 });
  expect(
    (
      await admin.query(
        "SELECT id FROM financial_journal_entries WHERE id=$1",
        [p.entryId],
      )
    ).rows,
  ).toEqual([]);
  expect(
    (
      await admin.query("SELECT id FROM audit_logs WHERE object_id=$1", [
        p.entryId,
      ])
    ).rows,
  ).toEqual([]);
});
