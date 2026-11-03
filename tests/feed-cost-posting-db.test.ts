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
it("previews and posts only changes from original linked bookings at the cost review date", async () => {
  const { lot, issue, lost } = await originals();
  await booked(rec(lot));
  await booked(rec(issue, null, "expense"));
  await booked(rec(lost, null, null));
  const review = await savedReview("cost", lot),
    p = await fp(priced(review)),
    v = await (await preview(p)).json();
  expect(v).toMatchObject({
    bookedPurchaseValue: "300.0001",
    reviewedPurchaseValue: "330.0000",
    purchaseDelta: "29.9999",
    postedOn: "2024-02-03",
  });
  expect((await fin()).report.entries).toHaveLength(3);
  const id = await booked(priced(review)),
    e = (await fin()).report.entries.find((e) => e.id === id)!;
  expect(e.lines).toEqual([
    { account: "1200", side: "debit", amount: "28.4629" },
    { account: "2000", side: "credit", amount: "29.9999" },
    { account: "5000", side: "debit", amount: "0.9370" },
    { account: "5200", side: "debit", amount: "0.6000" },
  ]);
  expect(e.source_snapshot).toMatchObject({
    lotId: lot,
    review: { id: review },
    parentPostingId: null,
  });
});
it("posts subsequent changes against already adjusted books, not original review deltas", async () => {
  const { lot, issue, lost } = await originals();
  await booked(rec(lot));
  await booked(rec(issue, null, "work_in_progress"));
  await booked(rec(lost, null, null));
  const first = await booked(
      priced(await savedReview("cost", lot), "payables", "expense"),
    ),
    second = await booked(
      priced(await savedReview("cost", lot, "360"), "payables", "expense"),
    ),
    e = (await fin()).report.entries.find((e) => e.id === second)!;
  expect(e.source_snapshot).toMatchObject({
    parentPostingId: first,
    bookedPurchaseValue: "330.0000",
    purchaseDelta: "30.0000",
  });
  expect(e.lines).toContainEqual({
    account: "1300",
    side: "debit",
    amount: "0.9370",
  });
  expect(e.lines.some((l) => l.account === "5000")).toBe(false);
});
it("initially books a reviewed formerly unknown lot and its actual consumption/loss without inventing original zero cost", async () => {
  const lot = await save({
    ...feedReceipt(),
    totalCost: null,
    costEvidence: null,
  });
  await save(await consume(lot));
  await save(loss(lot, "2"));
  const r = await savedReview("cost", lot, "100"),
    id = await booked(priced(r, "payables", "work_in_progress")),
    e = (await fin()).report.entries.find((e) => e.id === id)!;
  expect(e.source_snapshot).toMatchObject({
    bookedPurchaseValue: "0.0000",
    review: { source_snapshot: { receipt: { amount: null } } },
    purchaseDelta: "100.0000",
  });
  expect(e.lines).toEqual([
    { account: "1200", side: "debit", amount: "94.8765" },
    { account: "1300", side: "debit", amount: "3.1235" },
    { account: "2000", side: "credit", amount: "100.0000" },
    { account: "5200", side: "debit", amount: "2.0000" },
  ]);
  expect((await workspace()).report.results.lots[0].receivedValue).toBeNull();
});
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
it("posts negative price changes as credit notes/refunds with explicit cash evidence", async () => {
  const { lot } = await originals();
  await booked(priced(await savedReview("cost", lot, "330")));
  const id = await booked(
      priced(await savedReview("cost", lot, "240"), "cash_bank"),
    ),
    e = (await fin()).report.entries.find((e) => e.id === id)!;
  expect(e.lines).toContainEqual({
    account: "1000",
    side: "debit",
    amount: "90.0000",
  });
  expect(e.source_snapshot).toMatchObject({
    purchaseDelta: "-90.0000",
    bookedPurchaseValue: "330.0000",
  });
});
it("normalizes exact receipts/audits once after newer reviews and cost postings", async () => {
  const { lot } = await originals(),
    p = await fp(priced(await savedReview("cost", lot)));
  p.data.reason = "  " + p.data.reason + "  ";
  await fpost(p);
  await booked(priced(await savedReview("cost", lot, "360")));
  expect((await fpost(p)).status).toBe(200);
  expect(
    (
      await admin.query("SELECT id FROM audit_logs WHERE object_id=$1", [
        p.entryId,
      ])
    ).rows,
  ).toHaveLength(1);
  await expect(
    fpost({ ...p, data: { ...p.data, evidence: "Synthetic changed claims" } }),
  ).rejects.toMatchObject({ status: 409 });
});
it("restricts populated cost posting/preview data to current financial roles", async () => {
  const { lot } = await originals(),
    p = await fp(priced(await savedReview("cost", lot)));
  await fpost(p);
  for (const actor of [inventory, accounts, worker, outsider]) {
    await expect(finGet(actor)).rejects.toMatchObject({ status: 403 });
    await expect(
      preview(await fp(priced(await savedReview("cost", lot, "360"))), actor),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      fDirect({ ...p, entryId: randomUUID() }, actor),
    ).rejects.toMatchObject({ code: "42501" });
  }
  expect((await finGet(auditor)).status).toBe(200);
  await expect(
    fpost({ ...p, entryId: randomUUID() }, auditor),
  ).rejects.toMatchObject({ status: 403 });
  expect(
    (
      await tenant(outsider, (c) =>
        c.query("SELECT feed_cost_is_managed($1,$2) AS managed", [org, lot]),
      )
    ).rows[0].managed,
  ).toBe(false);
});
it("serializes concurrent API/direct cost recognition from one journal head", async () => {
  const { lot } = await originals(),
    review = await savedReview("cost", lot),
    a = await fp(priced(review)),
    b = await fp(priced(review)),
    r = await Promise.allSettled([fpost(a), fDirect(b)]);
  expect(r.filter((v) => v.status === "fulfilled")).toHaveLength(1);
  await expect(fpost(await fp(priced(review)))).rejects.toMatchObject({
    status: 409,
  });
});
it("prevents inventory physical voids and original financial changes while cost postings are active", async () => {
  const { lot, issue } = await originals(),
    parent = await booked(rec(lot));
  await booked(priced(await savedReview("cost", lot)));
  await expect(
    post(await payload(voided(issue)), inventory),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    direct(await payload(voided(issue)), inventory),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(fDirect(await fp(reversal(parent)))).rejects.toMatchObject({
    code: "23514",
  });
  await expect(
    fpost(await fp(rec(issue, null, "expense"))),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (
      await tenant(inventory, (c) =>
        c.query("SELECT feed_financial_is_booked($1,$2) AS booked", [
          org,
          issue,
        ]),
      )
    ).rows[0].booked,
  ).toBe(true);
});
it("requires newest-first cost reversals and no earlier dependent reversal dates", async () => {
  const { lot } = await originals(),
    a = await booked(priced(await savedReview("cost", lot))),
    b = await booked(priced(await savedReview("cost", lot, "360")));
  await expect(fDirect(await fp(reversal(a)))).rejects.toMatchObject({
    code: "23514",
  });
  await booked(reversal(b, "2024-02-05"));
  await expect(
    fDirect(await fp(reversal(a, "2024-02-04"))),
  ).rejects.toMatchObject({ code: "23514" });
  await booked(reversal(a, "2024-02-05"));
  expect(
    (
      await tenant(owner, (c) =>
        c.query("SELECT feed_cost_is_managed($1,$2) AS managed", [org, lot]),
      )
    ).rows[0].managed,
  ).toBe(false);
  expect((await fin()).report.trialBalance[0]).toMatchObject({
    debitBalances: "0.0000",
    creditBalances: "0.0000",
  });
});
it("keeps cost posting and inventory void consistent under a direct/API race", async () => {
  const lot = await save({
      ...feedReceipt(),
      totalCost: null,
      costEvidence: null,
    }),
    r = await savedReview("cost", lot, "100"),
    p = await fp(priced(r)),
    v = await payload(voided(lot)),
    rr = await Promise.allSettled([fpost(p), post(v, inventory)]);
  expect(rr.filter((v) => v.status === "fulfilled")).toHaveLength(1);
  const active = (await workspace()).report.results.lots[0].active,
    managed = (
      await tenant(owner, (c) =>
        c.query("SELECT feed_cost_is_managed($1,$2) AS managed", [org, lot]),
      )
    ).rows[0].managed;
  expect(!active && managed).toBe(false);
});
it("rejects superseded/physically stale reviews and unresolved actual source changes", async () => {
  const { lot } = await originals(),
    old = await savedReview("cost", lot),
    latest = await savedReview("cost", lot, "360");
  await expect(fpost(await fp(priced(old)))).rejects.toMatchObject({
    status: 409,
  });
  await save(loss(lot, "1"), "2024-02-04");
  await expect(fpost(await fp(priced(latest)))).rejects.toMatchObject({
    status: 409,
  });
  const r = await rp("cost", lot, "360");
  r.date = "2024-02-04";
  await reviewPost(r);
  await correction(10);
  await expect(fpost(await fp(priced(r.reviewId)))).rejects.toMatchObject({
    status: 409,
  });
});
it("books later actual movements only through another current cost review without duplicate original recognition", async () => {
  const { lot } = await originals();
  await booked(priced(await savedReview("cost", lot)));
  const later = await save(loss(lot, "1"), "2024-02-04");
  await expect(fpost(await fp(rec(later, null, null)))).rejects.toMatchObject({
    status: 409,
  });
  const r = await rp("cost", lot);
  r.date = "2024-02-04";
  await reviewPost(r);
  const id = await booked(priced(r.reviewId)),
    e = (await fin()).report.entries.find((e) => e.id === id)!;
  expect(e.source_snapshot).toMatchObject({ purchaseDelta: "0.0000" });
  expect(e.lines).toEqual([
    { account: "1200", side: "credit", amount: "3.3000" },
    { account: "5200", side: "debit", amount: "3.3000" },
  ]);
});
it("never posts a reviewed cost before prior accounting/reversal dates", async () => {
  const { lot } = await originals(),
    a = await booked(priced(await savedReview("cost", lot)));
  await booked(reversal(a, "2024-02-05"));
  const r = await savedReview("cost", lot, "360");
  await expect(fpost(await fp(priced(r)))).rejects.toMatchObject({
    status: 409,
  });
  const p = await rp("cost", lot, "360");
  p.date = "2024-02-05";
  await reviewPost(p);
  expect((await fpost(await fp(priced(p.reviewId)))).status).toBe(201);
});
it("derives forged source/lines/currency and denies actor/time/cross-tenant bypasses", async () => {
  const { lot } = await originals(),
    p = await fp(priced(await savedReview("cost", lot))),
    r = await fDirect(
      p,
      owner,
      ",kind,source_id,source_kind,source_snapshot,lines,currency,unit_id",
      ["manual", randomUUID(), "feed", { forged: true }, [], "USD", unit],
    );
  expect(r.rows[0]).toMatchObject({
    kind: "recognize_feed_cost",
    source_kind: "feed_cost",
    currency: "NGN",
    unit_id: null,
  });
  for (const [extra, values] of [
    [",created_by", [worker]],
    [",created_at", ["2024-01-01"]],
  ] as [string, unknown[]][])
    await expect(
      fDirect(
        await fp(priced(await savedReview("cost", lot, "360"))),
        owner,
        extra,
        values,
      ),
    ).rejects.toMatchObject({ code: "42501" });
  const foreign = (
    await tenant(outsider, (c) =>
      c.query(
        "SELECT create_organization('Synthetic foreign cost authority') AS id",
      ),
    )
  ).rows[0].id;
  organizations.push(foreign);
  await expect(
    fpost({ ...(await fp(priced(randomUUID()))), organizationId: foreign }),
  ).rejects.toMatchObject({ status: 403 });
});
it("keeps SQL basis fixed under caller temporary schema shadows", async () => {
  const { lot } = await originals(),
    p = await fp(priced(await savedReview("cost", lot)));
  await tenant(owner, async (c) => {
    await c.query(
      "CREATE TEMP TABLE feed_stock_events AS SELECT * FROM feed_stock_events WHERE false",
    );
    await c.query(
      "CREATE TEMP TABLE financial_journal_entries AS SELECT * FROM financial_journal_entries WHERE false",
    );
    await c.query(
      "CREATE TEMP TABLE feed_reconciliation_reviews AS SELECT * FROM feed_reconciliation_reviews WHERE false",
    );
    await c.query("SET LOCAL search_path=pg_temp,public");
    await c.query(
      "INSERT INTO public.financial_journal_entries(id,organization_id,expected_position,input) VALUES($1,$2,$3,$4)",
      [p.entryId, org, p.expectedPosition, JSON.stringify(p.data)],
    );
    await c.query(
      "DROP TABLE pg_temp.feed_stock_events,pg_temp.financial_journal_entries,pg_temp.feed_reconciliation_reviews",
    );
  });
  expect((await fin()).report.entries[0].source_snapshot).toMatchObject({
    lotId: lot,
  });
});
it("preserves exact old finance/stock/review reports after later priced postings, reversals and settings", async () => {
  const { lot } = await originals(),
    review = await savedReview("cost", lot),
    stock = await workspace(),
    stockQ = `&format=json&asOf=${stock.report.asOf}&throughPosition=${stock.expectedPosition}`,
    stockBytes = await (await get(owner, stockQ)).text(),
    reviewQ = `&reviewId=${review}&format=json`,
    reviewBytes = await (await reviewGet(owner, reviewQ)).text(),
    id = await booked(priced(review)),
    w = await fin(),
    q = `&asOf=${w.report.asOf}&throughPosition=${w.expectedPosition}`,
    json = await (await finGet(owner, q + "&format=json")).text(),
    csv = await (await finGet(owner, q + "&format=csv")).text();
  await booked(reversal(id));
  await tenant(owner, (c) =>
    c.query(
      "UPDATE organizations SET currency='USD',timezone='UTC' WHERE id=$1",
      [org],
    ),
  );
  await booked({ ...manualJournal(), currency: "USD" });
  expect(await (await finGet(owner, q + "&format=json")).text()).toBe(json);
  expect(await (await finGet(auditor, q + "&format=csv")).text()).toBe(csv);
  expect(await (await get(owner, stockQ)).text()).toBe(stockBytes);
  expect(await (await reviewGet(owner, reviewQ)).text()).toBe(reviewBytes);
});
it("records known-zero reviewed authority as a protected zero-line marker", async () => {
  const lot = await save({
      ...feedReceipt(),
      totalCost: null,
      costEvidence: null,
    }),
    id = await booked(priced(await savedReview("cost", lot, "0"))),
    e = (await fin()).report.entries.find((e) => e.id === id)!;
  expect(e.lines).toEqual([
    { account: "1200", side: "debit", amount: "0.0000" },
    { account: "2000", side: "credit", amount: "0.0000" },
  ]);
  await expect(
    post(await payload(voided(lot)), inventory),
  ).rejects.toMatchObject({ status: 409 });
});
it("rolls back required large journal evidence and its audit without changing source books", async () => {
  const lot = await save({
      ...feedReceipt(),
      reason: "x".repeat(2000),
      evidence: "x".repeat(2000),
      costEvidence: "x".repeat(2000),
    }),
    review = await savedReview("cost", lot);
  let bytes = 0;
  while (bytes < 1020000) {
    await fDirect(
      await fp({
        ...manualJournal(),
        description: "x".repeat(1000),
        reason: "x".repeat(2000),
        evidence: "x".repeat(2000),
      }),
    );
    bytes = Buffer.byteLength(
      await (await finGet(owner, "&format=json")).text(),
    );
  }
  const p = await fp(priced(review));
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
  expect(
    (
      await tenant(owner, (c) =>
        c.query("SELECT feed_cost_is_managed($1,$2) AS managed", [org, lot]),
      )
    ).rows[0].managed,
  ).toBe(false);
});
it("refuses a newly linked unit that appeared while waiting for the original lot source locks", async () => {
  const { lot } = await originals(),
    review = await savedReview("cost", lot),
    p = await fp(priced(review)),
    other = (
      await tenant(owner, (c) =>
        c.query(
          "INSERT INTO production_units(organization_id,farm_id,name,kind,stocked_on,opening_count,initial_weight_g) VALUES($1,$2,'Synthetic second source','broilers','2024-02-01',100,1000) RETURNING id",
          [org, farm],
        ),
      )
    ).rows[0].id;
  await tenant(owner, (c) =>
    c.query(
      "INSERT INTO daily_records(organization_id,unit_id,recorded_on,mortality,eggs,cracked,feed_kg,average_weight_g,sample_size,notes) VALUES($1,$2,'2024-02-01',0,0,0,10,2000,10,'Synthetic second actual source')",
      [org, other],
    ),
  );
  const blocker = await admin.connect();
  let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [unit]);
    pending = Promise.allSettled([fpost(p)]);
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      waiting = (
        await admin.query(
          "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND objid=(hashtext($1)::bigint & 4294967295)::oid) AS waiting",
          [unit],
        )
      ).rows[0].waiting;
      if (waiting) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    await save(await consume(lot, "1", other));
    await blocker.query("COMMIT");
    const result = await pending;
    expect(result[0]).toMatchObject({
      status: "rejected",
      reason: { code: "23505" },
    });
    expect((await fin()).report.entries).toHaveLength(0);
    expect(
      (await fpost(await fp(priced(await savedReview("cost", lot))))).status,
    ).toBe(201);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    if (pending) await pending;
  }
});
