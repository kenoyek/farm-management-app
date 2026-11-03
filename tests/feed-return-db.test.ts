import { manualJournal } from "./financial-journal-fixture";
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
import { feedCostPreviewApi } from "../src/lib/feed-cost-posting-api";
import { feedReviewApi } from "../src/lib/feed-review-api";
import {
  type FeedReviewInput,
  type FeedReviewWorkspace,
} from "../src/lib/feed-review";
import { financialJournalApi } from "../src/lib/financial-journal-api";
import {
  type JournalInput,
  type JournalData,
  type JournalWorkspace,
} from "../src/lib/financial-journal";
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
        previousId:
          (
            await tenant(owner, (c) =>
              c.query(
                "SELECT id FROM current_broiler_reviews WHERE unit_id=$1 AND kind='daily' AND observed_on='2024-02-01'",
                [unit],
              ),
            )
          ).rows[0]?.id ?? null,
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
async function reviewGet(actor = owner, extra = "", organization = org) {
  return (await feedReviewApi(
    new NextRequest(
      `http://localhost/api/inventory/feed/reviews?organizationId=${organization}${extra}`,
    ),
    { id: actor },
    "inventory/feed/reviews",
  ))!;
}
async function rw(
  kind: "source" | "cost",
  target: string,
): Promise<FeedReviewWorkspace> {
  return (await reviewGet(owner, `&kind=${kind}&targetId=${target}`)).json();
}
async function rp(
  kind: "source" | "cost",
  target: string,
  totalCost = "330",
): Promise<FeedReviewInput> {
  const w = await rw(kind, target),
    common = {
      targetId: target,
      previousId: w.selected!.latestId,
      reason: "Synthetic reviewed current feed evidence",
      evidence:
        "Synthetic original lot, current daily and revised cost authority",
    };
  return {
    organizationId: org,
    reviewId: randomUUID(),
    date: "2024-02-03",
    expectedStockPosition: w.expectedStockPosition,
    expectedReviewPosition: w.expectedReviewPosition,
    expectedSourceSha256: w.selected!.sourceSha256!,
    data:
      kind === "source"
        ? {
            kind,
            ...common,
            policy: "same-quantity-current-feed-evidence-v1",
            scope: "unchanged-physical-consumption",
          }
        : {
            kind,
            ...common,
            totalCost,
            costEvidence:
              "Synthetic final complete actual invoice and landed-cost boundary",
            policy: "reviewed-specific-lot-cost-v1",
            scope: "actual-purchase-cost-revision",
          },
  };
}
async function reviewPost(p: FeedReviewInput, actor = owner) {
  return (await feedReviewApi(
    new NextRequest("http://localhost/api/inventory/feed/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(p),
    }),
    { id: actor },
    "inventory/feed/reviews",
  ))!;
}
async function savedReview(
  kind: "source" | "cost",
  target: string,
  total = "330",
) {
  const p = await rp(kind, target, total);
  expect((await reviewPost(p)).status).toBe(201);
  return p.reviewId;
}
const priced = (
  reviewId: string,
  settlement: "payables" | "cash_bank" = "payables",
  consumptionTreatment: "expense" | "work_in_progress" = "expense",
): JournalData => ({
  kind: "recognize_feed_cost",
  reviewId,
  settlement,
  consumptionTreatment,
  paymentEvidence:
    settlement === "cash_bank"
      ? "Synthetic actual payment/refund evidence"
      : null,
  policy: "reviewed-feed-cost-ledger-v1",
  reason: "Synthetic reviewed complete feed cost book adjustment",
  evidence:
    "Synthetic current cost authority and original linked books; no duplicated manual postings",
});
async function preview(p: JournalInput, actor = owner) {
  return (await feedCostPreviewApi(
    new NextRequest("http://localhost/api/finance/feed-costs/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(p),
    }),
    { id: actor },
    "finance/feed-costs/preview",
  ))!;
}
const reversal = (originalId: string, date = "2024-02-04"): JournalData => ({
  kind: "reverse",
  originalId,
  date,
  reason: "Synthetic original reviewed cost correction",
  evidence: "Synthetic accounting-only correction evidence",
});
async function fDirect(
  p: JournalInput,
  actor = owner,
  extra = "",
  values: unknown[] = [],
) {
  return tenant(actor, (c) =>
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
const returned = (
  lotId: string,
  weightKg = "10",
): Extract<FeedStockData, { kind: "supplier_return" }> => ({
  kind: "supplier_return",
  lotId,
  weightKg,
  returnReference: "SYNTHETIC-RETURN-" + randomUUID(),
  supplierEvidence:
    "Synthetic original supplier signed handover and unused-feed weight",
  scope: "actual-unused-feed-return-to-original-supplier",
  reason: "Synthetic actual unused feed returned to supplier",
  evidence:
    "Synthetic weighed unused stock physically dispatched to original supplier",
});
function recReturn(
  sourceId: string,
  purchase: "payables" | "cash_bank" = "payables",
): JournalData {
  return {
    ...rec(sourceId, purchase),
    policy: "recorded-feed-return-carrying-value-v1",
  } as JournalData;
}
function returnCost(
  reviewId: string,
  returnSettlement: "payables" | "cash_bank" = "payables",
): JournalData {
  return {
    ...priced(reviewId),
    policy: "reviewed-feed-cost-ledger-v2",
    returnSettlement,
    returnAccountingEvidence:
      "Synthetic full supplier credit/refund basis and actual accounting authority",
  } as JournalData;
}
it("records genuine returns independently of consumption/loss and preserves original supplier, source and stock prefixes", async () => {
  const { lot } = await originals(),
    before = await workspace(),
    prefix = `&asOf=${before.report.asOf}&throughPosition=${before.expectedPosition}&format=json`,
    bytes = await (await get(owner, prefix)).text();
  const id = await save(returned(lot)),
    w = await workspace(),
    l = w.report.results.lots[0],
    e = w.report.events.find((e) => e.id === id)!;
  expect(e).toMatchObject({
    kind: "supplier_return",
    model_version: "specific-feed-lot-stock-v2",
    weight_kg: "10.000000",
    amount: "30.0000",
    currency: "NGN",
    unit_id: null,
    source_snapshot: null,
  });
  expect(l).toMatchObject({
    returnedKg: "10.000000",
    returnedValue: "30.0000",
    balanceKg: "84.876544",
    consumedKg: "3.123456",
    lostKg: "2.000000",
    remainingValue: "254.6297",
  });
  expect(w.report.modelVersion).toBe("specific-feed-lot-stock-v2");
  expect(w.sources).toEqual(before.sources);
  expect((await fin()).report.entries).toHaveLength(0);
  expect(await (await get(owner, prefix)).text()).toBe(bytes);
  expect(
    (await get(owner, "&format=csv")).headers.get("content-type"),
  ).toContain("text/csv");
});
it("uses the remaining original cost including final depletion residual through mixed returns, loss and actual consumption", async () => {
  const lot = await save({
    ...feedReceipt(),
    weightKg: "3",
    totalCost: "0.0001",
  });
  const a = await save(returned(lot, "1")),
    b = await save(loss(lot, "1")),
    c = await save(await consume(lot, "1")),
    w = await workspace();
  expect(
    [a, b, c].map((id) => w.report.events.find((e) => e.id === id)!.amount),
  ).toEqual(["0.0000", "0.0001", "0.0000"]);
  expect(w.report.results.lots[0]).toMatchObject({
    returnedKg: "1.000000",
    returnedValue: "0.0000",
    balanceKg: "0.000000",
    remainingValue: "0.0000",
  });
  await expect(
    post(await payload(returned(lot, "0.000001"))),
  ).rejects.toMatchObject({ code: "23514" });
});
it("keeps unknown and explicit zero return amounts distinct in stock and financial eligibility", async () => {
  const unknown = await save({
      ...feedReceipt(),
      totalCost: null,
      costEvidence: null,
    }),
    zero = await save({ ...feedReceipt(), totalCost: "0" }),
    a = await save(returned(unknown)),
    b = await save(returned(zero)),
    w = await workspace();
  expect(w.report.events.find((e) => e.id === a)!.amount).toBeNull();
  expect(w.report.events.find((e) => e.id === b)!.amount).toBe("0.0000");
  await booked(rec(zero));
  await expect(fpost(await fp(recReturn(a)))).rejects.toMatchObject({
    status: 409,
  });
  const id = await booked(recReturn(b));
  expect(
    (await fin()).report.entries
      .find((e) => e.id === id)!
      .lines.every((l) => l.amount === "0.0000"),
  ).toBe(true);
});
it("normalizes exact supplier-return receipts/audits once and reserves the business reference", async () => {
  const lot = await save(),
    p = await payload(returned(lot));
  expect((await post(p, inventory)).status).toBe(201);
  await save(loss(lot));
  expect((await post(p, inventory)).status).toBe(200);
  expect(
    (
      await admin.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE object_id=$1",
        [p.eventId],
      )
    ).rows[0].n,
  ).toBe(1);
  await expect(
    post({
      ...p,
      eventId: randomUUID(),
      expectedPosition: (await workspace()).expectedPosition,
    }),
  ).rejects.toMatchObject({ code: "23505" });
  await expect(
    post({
      ...p,
      data: { ...p.data, evidence: "Synthetic changed handover evidence" },
    }),
  ).rejects.toMatchObject({ status: 409 });
});
it("enforces populated reader/writer/tenant and forged actor/time/derived-field boundaries", async () => {
  const lot = await save(),
    p = await payload(returned(lot));
  for (const actor of [worker, outsider, accounts, auditor])
    await expect(post(p, actor)).rejects.toMatchObject({ status: 403 });
  for (const actor of [owner, inventory, accounts, auditor])
    expect((await get(actor)).status).toBe(200);
  for (const actor of [worker, outsider])
    await expect(get(actor)).rejects.toMatchObject({ status: 403 });
  for (const [extra, values] of [
    [",created_by", [worker]],
    [",created_at", ["2024-01-01"]],
  ] as [string, unknown[]][])
    await expect(direct(p, owner, extra, values)).rejects.toMatchObject({
      code: "42501",
    });
  const r = await direct(
    p,
    inventory,
    ",kind,weight_kg,amount,currency,unit_id",
    ["consume", "999", "999", "USD", unit],
  );
  expect(r.rows[0]).toMatchObject({
    kind: "supplier_return",
    weight_kg: "10.000000",
    amount: "30.0000",
    currency: "NGN",
    unit_id: null,
  });
  const foreign = (
    await tenant(outsider, (c) =>
      c.query(
        "SELECT create_organization('Synthetic foreign supplier lot') AS id",
      ),
    )
  ).rows[0].id;
  organizations.push(foreign);
  const foreignReceipt: FeedStockInput = {
    organizationId: foreign,
    eventId: randomUUID(),
    date: "2024-02-01",
    expectedPosition: "0",
    data: feedReceipt(),
  };
  expect((await post(foreignReceipt, outsider)).status).toBe(201);
  await expect(
    direct(await payload(returned(foreignReceipt.eventId)), owner),
  ).rejects.toMatchObject({ code: "23514" });
});
it("serializes concurrent direct/API returns and returns versus loss without overdraw", async () => {
  const lot = await save({ ...feedReceipt(), weightKg: "10", totalCost: "20" }),
    a = await payload(returned(lot, "7")),
    b = await payload(returned(lot, "7"));
  const results = await Promise.allSettled([post(a), direct(b, inventory)]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await workspace()).report.results.lots[0].balanceKg).toBe("3.000000");
  const c = await payload(returned(lot, "3")),
    d = await payload(loss(lot, "3")),
    race = await Promise.allSettled([direct(c), post(d)]);
  expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await workspace()).report.results.lots[0].balanceKg).toBe("0.000000");
});
it("blocks wrong dates/scopes/references/precision and protects dependent original receipts", async () => {
  const lot = await save(),
    p = await payload(returned(lot));
  for (const patch of [
    { scope: "return-from-consumption" },
    { supplierEvidence: "" },
    { weightKg: "0" },
    { weightKg: "0.0000001" },
    { returnReference: "" },
  ])
    await expect(
      direct({ ...p, data: { ...p.data, ...patch } as FeedStockData }),
    ).rejects.toMatchObject({ code: "23514" });
  await expect(direct({ ...p, date: "2099-01-01" })).rejects.toMatchObject({
    code: "23514",
  });
  const id = await save(returned(lot), "2024-02-03");
  await expect(
    post(await payload(returned(lot), "2024-02-02")),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    post(await payload(voided(lot), "2024-02-03")),
  ).rejects.toMatchObject({ code: "23514" });
  await save(voided(id), "2024-02-04");
  expect((await workspace()).report.results.lots[0].returnedKg).toBe(
    "0.000000",
  );
  await save(voided(lot), "2024-02-04");
  expect((await workspace()).report.results.lots[0].active).toBe(false);
});
it("recognizes an original-value supplier credit/refund only after the purchase and freezes complete original return evidence", async () => {
  const lot = await save(),
    ret = await save(returned(lot));
  await expect(fpost(await fp(recReturn(ret)))).rejects.toMatchObject({
    status: 409,
  });
  await booked(rec(lot));
  await expect(fpost(await fp(rec(ret)))).rejects.toMatchObject({
    code: "23514",
  });
  const id = await booked(recReturn(ret, "cash_bank")),
    entry = (await fin()).report.entries.find((e) => e.id === id)!;
  expect(entry.lines).toEqual([
    { account: "1000", side: "debit", amount: "30.0000" },
    { account: "1200", side: "credit", amount: "30.0000" },
  ]);
  expect(entry.source_snapshot).toMatchObject({
    event: { id: ret, kind: "supplier_return" },
    lot: { id: lot, input: { supplier: "Synthetic feed supplier" } },
  });
  await expect(
    post(await payload(voided(ret)), inventory),
  ).rejects.toMatchObject({ status: 409 });
  const physical = (await workspace()).report;
  await booked(reversal(id));
  expect((await workspace()).report).toEqual(physical);
  await save(voided(ret), "2024-02-04");
  expect((await workspace()).report.results.lots[0].balanceKg).toBe(
    "100.000000",
  );
});
it("protects a recognized purchase from reversal until return recognition reverses and enforces dependent dates", async () => {
  const lot = await save(),
    ret = await save(returned(lot)),
    parent = await booked(rec(lot)),
    child = await booked(recReturn(ret));
  await expect(fpost(await fp(reversal(parent)))).rejects.toMatchObject({
    status: 409,
  });
  await booked(reversal(child, "2024-02-05"));
  await expect(
    fpost(await fp(reversal(parent, "2024-02-04"))),
  ).rejects.toMatchObject({ status: 409 });
  await booked(reversal(parent, "2024-02-05"));
});
it("revalues supplier returns separately from loss/consumption with complete conserved revised cost and unchanged original values", async () => {
  const { lot } = await originals(),
    ret = await save(returned(lot)),
    id = await savedReview("cost", lot, "330"),
    w: FeedReviewWorkspace = await (
      await reviewGet(owner, "&reviewId=" + id)
    ).json();
  expect(w.report).toMatchObject({
    modelVersion: "feed-reconciliation-v2",
    results: {
      returnedKg: "10.000000",
      originalReturnedValue: "30.0000",
      reviewedReturnedValue: "33.0000",
      returnedDelta: "3.0000",
      reviewedConsumedValue: "10.3074",
      reviewedLostValue: "6.6000",
      reviewedRemainingValue: "280.0926",
    },
  });
  expect(
    (await workspace()).report.events.find((e) => e.id === ret)!.amount,
  ).toBe("30.0000");
});
it("posts return-aware price differences incrementally and preserves original cash-return classification", async () => {
  const { lot, issue, lost } = await originals(),
    ret = await save(returned(lot));
  await booked(rec(lot));
  await booked(rec(issue, null, "work_in_progress"));
  await booked(rec(lost, null, null));
  await booked(recReturn(ret, "cash_bank"));
  const review = await savedReview("cost", lot, "330");
  await expect(preview(await fp(priced(review)))).rejects.toMatchObject({
    status: 409,
  });
  const invalid = await fp(returnCost(review));
  await expect(
    fDirect({
      ...invalid,
      data: { ...invalid.data, returnAccountingEvidence: "" } as JournalData,
    }),
  ).rejects.toMatchObject({ code: "23514" });
  const id = await booked(returnCost(review, "payables")),
    entry = (await fin()).report.entries.find((e) => e.id === id)!;
  expect(entry.source_snapshot).toMatchObject({
    policy: "reviewed-feed-cost-ledger-v2",
    purchaseDelta: "29.9999",
  });
  expect(entry.lines).toEqual([
    { account: "1000", side: "debit", amount: "3.0000" },
    { account: "1200", side: "debit", amount: "25.4629" },
    { account: "1300", side: "debit", amount: "0.9370" },
    { account: "2000", side: "credit", amount: "29.9999" },
    { account: "5200", side: "debit", amount: "0.6000" },
  ]);
  const next = await booked(returnCost(await savedReview("cost", lot, "360"))),
    e = (await fin()).report.entries.find((e) => e.id === next)!;
  expect(e.source_snapshot).toMatchObject({
    purchaseDelta: "30.0000",
    parentPostingId: id,
  });
  expect(e.lines).toContainEqual({
    account: "1000",
    side: "debit",
    amount: "3.0000",
  });
  const decreased = await booked(
      returnCost(await savedReview("cost", lot, "240")),
    ),
    negative = (await fin()).report.entries.find((e) => e.id === decreased)!;
  expect(negative.source_snapshot).toMatchObject({
    purchaseDelta: "-120.0000",
  });
  expect(negative.lines).toContainEqual({
    account: "1000",
    side: "credit",
    amount: "12.0000",
  });
});
it("initially books unknown return allocations and records a fully returned zero-net authority with physical protection", async () => {
  const lot = await save({
      ...feedReceipt(),
      totalCost: null,
      costEvidence: null,
    }),
    ret = await save(returned(lot, "100")),
    rev = await savedReview("cost", lot, "300"),
    id = await booked(returnCost(rev));
  expect((await fin()).report.entries.find((e) => e.id === id)!.lines).toEqual([
    { account: "1200", side: "debit", amount: "0.0000" },
    { account: "2000", side: "credit", amount: "0.0000" },
  ]);
  expect(
    (await workspace()).report.events.find((e) => e.id === ret)!.amount,
  ).toBeNull();
  await expect(
    post(await payload(voided(ret)), inventory),
  ).rejects.toMatchObject({ status: 409 });
  await booked(reversal(id));
  await save(voided(ret), "2024-02-04");
});
it("allows later actual returns after cost postings only via a new current return-aware cost authority", async () => {
  const lot = await save();
  await booked(rec(lot));
  await booked(priced(await savedReview("cost", lot)));
  const ret = await save(returned(lot), "2024-02-04");
  await expect(fpost(await fp(recReturn(ret)))).rejects.toMatchObject({
    status: 409,
  });
  const rp2 = await rp("cost", lot, "330");
  rp2.date = "2024-02-04";
  await reviewPost(rp2);
  const id = await booked(returnCost(rp2.reviewId)),
    e = (await fin()).report.entries.find((e) => e.id === id)!;
  expect(e.source_snapshot).toMatchObject({ purchaseDelta: "0.0000" });
  expect(e.lines).toEqual([
    { account: "1200", side: "credit", amount: "33.0000" },
    { account: "2000", side: "debit", amount: "33.0000" },
  ]);
});
it("keeps v1 journal receipts replayable after a lot gains a return-aware review and posting", async () => {
  const lot = await save(),
    first = await fp(rec(lot));
  await fpost(first);
  await save(returned(lot));
  await booked(returnCost(await savedReview("cost", lot)));
  expect((await fpost(first)).status).toBe(200);
  expect(
    (await fin()).report.entries.find((e) => e.id === first.entryId)!.input,
  ).toEqual(first.data);
});
it("serializes return recognition versus physical void and derives forged financial return fields", async () => {
  const lot = await save(),
    ret = await save(returned(lot));
  await booked(rec(lot));
  const a = await fp(recReturn(ret)),
    b = await payload(voided(ret)),
    race = await Promise.allSettled([
      fDirect(a, owner, ",lines,currency,source_snapshot", [
        [],
        "USD",
        { fake: true },
      ]),
      direct(b, inventory),
    ]);
  expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
});
it("preserves original stock/finance/review bytes through returns, refund reversals, cost versions and settings", async () => {
  const { lot } = await originals();
  await booked(rec(lot));
  const review = await savedReview("cost", lot),
    stock = await workspace(),
    finance = await fin(),
    sf = `&asOf=${stock.report.asOf}&throughPosition=${stock.expectedPosition}`,
    ff = `&asOf=${finance.report.asOf}&throughPosition=${finance.expectedPosition}`,
    sb = await (await get(owner, sf + "&format=json")).text(),
    fb = await (await finGet(owner, ff + "&format=json")).text(),
    rb = await (
      await reviewGet(owner, "&reviewId=" + review + "&format=json")
    ).text();
  await save(returned(lot));
  await booked(returnCost(await savedReview("cost", lot, "360")));
  await tenant(owner, (c) =>
    c.query(
      "UPDATE organizations SET currency='USD',timezone='UTC' WHERE id=$1",
      [org],
    ),
  );
  await booked({ ...manualJournal(), currency: "USD" });
  expect(await (await get(owner, sf + "&format=json")).text()).toBe(sb);
  expect(await (await finGet(owner, ff + "&format=json")).text()).toBe(fb);
  expect(
    await (
      await reviewGet(owner, "&reviewId=" + review + "&format=json")
    ).text(),
  ).toBe(rb);
});
it("keeps fixed-schema return validation safe under temporary caller tables", async () => {
  const lot = await save(),
    p = await payload(returned(lot));
  await tenant(owner, async (c) => {
    await c.query(
      "CREATE TEMP TABLE feed_stock_events AS SELECT * FROM feed_stock_events WHERE false",
    );
    await c.query("SET LOCAL search_path=pg_temp,public");
    await c.query(
      "INSERT INTO public.feed_stock_events(id,organization_id,lot_id,recorded_on,expected_position,input) VALUES($1,$2,$1,$3,$4,$5)",
      [p.eventId, org, p.date, p.expectedPosition, JSON.stringify(p.data)],
    );
    await c.query("DROP TABLE pg_temp.feed_stock_events");
  });
  expect((await workspace()).report.results.lots[0].returnedValue).toBe(
    "30.0000",
  );
});
it("never treats warehouse supplier returns as a correction of overlinked actual consumed feed", async () => {
  const { lot } = await originals();
  await save(returned(lot));
  await correction(2, "Synthetic genuine lower actual consumed-feed record");
  const w = await workspace();
  expect(w.changedSources[0].overlinkedKg).toBe("1.123456");
  expect(w.report.results.lots[0].consumedKg).toBe("3.123456");
  expect(w.report.results.lots[0].returnedKg).toBe("10.000000");
  await expect(
    preview(await fp(returnCost(await savedReview("cost", lot)))),
  ).rejects.toMatchObject({ status: 409 });
});
