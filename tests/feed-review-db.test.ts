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
import { feedReviewApi } from "../src/lib/feed-review-api";
import {
  feedReviewInput,
  type FeedReviewData,
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
async function reviewDirect(
  p: FeedReviewInput,
  actor = owner,
  extra = "",
  values: unknown[] = [],
) {
  return tenant(actor, (c) =>
    c.query(
      `INSERT INTO feed_reconciliation_reviews(id,organization_id,kind,target_id,reviewed_on,expected_stock_position,expected_review_position,expected_source_sha256,input${extra}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9${values.map((_, i) => ",$" + (i + 10)).join("")}) RETURNING *`,
      [
        p.reviewId,
        p.organizationId,
        p.data.kind,
        p.data.targetId,
        p.date,
        p.expectedStockPosition,
        p.expectedReviewPosition,
        p.expectedSourceSha256,
        JSON.stringify(p.data),
        ...values,
      ],
    ),
  );
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
it("derives complete lot source, original currency and exact revised consumed/loss/remaining allocation", async () => {
  const { lot } = await originals(),
    before = (await workspace()).report,
    id = await savedReview("cost", lot),
    w = await rw("cost", lot);
  expect(w.report?.review.id).toBe(id);
  expect(w.report?.results).toMatchObject({
    kind: "cost",
    originalTotalCost: "300.0001",
    reviewedTotalCost: "330.0000",
    reviewedConsumedValue: "10.3074",
    reviewedLostValue: "6.6000",
    reviewedRemainingValue: "313.0926",
    totalDelta: "29.9999",
  });
  expect(w.report?.review.source_snapshot.events).toEqual(before.events);
  expect((await workspace()).report).toEqual(before);
  expect((await fin()).report.entries).toEqual([]);
});
it("reviews originally unknown costs without pretending their deltas start from zero", async () => {
  const lot = await save({
    ...feedReceipt(),
    totalCost: null,
    costEvidence: null,
  });
  await save(await consume(lot, "3"));
  await savedReview("cost", lot, "0");
  const w = await rw("cost", lot);
  expect(w.report?.results).toMatchObject({
    originalTotalCost: null,
    reviewedTotalCost: "0.0000",
    totalDelta: null,
    consumedDelta: null,
    reviewedConsumedValue: "0.0000",
    reviewedRemainingValue: "0.0000",
  });
  expect((await workspace()).report.results.lots[0].receivedValue).toBeNull();
  await expect(fpost(await fp(rec(lot)))).rejects.toMatchObject({
    status: 409,
  });
});
it("reaffirms unchanged consumption against corrected evidence and enables source-linked Finance with full review proof", async () => {
  const { lot, issue } = await originals();
  await booked(rec(lot));
  await correction(10, "Synthetic metadata-only current daily review");
  expect(
    (await fin()).feedSources.find((s) => s.source_id === issue)?.eligible,
  ).toBe(false);
  const before = (await workspace()).report,
    id = await savedReview("source", issue);
  expect(
    (await fin()).feedSources.find((s) => s.source_id === issue)?.eligible,
  ).toBe(true);
  expect((await workspace()).changedSources).toHaveLength(0);
  expect((await workspace()).report).toEqual(before);
  const child = await booked(rec(issue, null, "expense"));
  expect(
    (await fin()).report.entries.find((e) => e.id === child)?.source_snapshot,
  ).toMatchObject({
    sourceReview: {
      id,
      kind: "source",
      source_snapshot: {
        event: { id: issue },
        currentSource: { record: { feed_kg: "10.000000" } },
      },
    },
  });
});
it("does not reaffirm overlinked or unchanged-current evidence and never changes physical kg", async () => {
  const { issue } = await originals();
  await expect(reviewDirect(await rp("source", issue))).rejects.toMatchObject({
    code: "23505",
  });
  await correction(2);
  const before = (await workspace()).report;
  await expect(reviewPost(await rp("source", issue))).rejects.toMatchObject({
    code: "23514",
  });
  expect((await workspace()).report).toEqual(before);
});
it("keeps approved sources stale again after another correction and preserves original journal bytes", async () => {
  const { lot, issue } = await originals();
  await booked(rec(lot));
  await correction(10);
  await savedReview("source", issue);
  const id = await booked(rec(issue, null, "expense")),
    w = await fin(),
    frozen = `&format=json&asOf=${w.report.asOf}&throughPosition=${w.expectedPosition}`,
    bytes = await (await finGet(owner, frozen)).text();
  const before = await rw("source", issue);
  await correction(
    10,
    "Synthetic later metadata-only corrected daily evidence",
  );
  expect((await rw("source", issue)).sourceCurrent).toBe(false);
  expect((await finGet(owner, "&sourceStatus=all")).status).toBe(200);
  expect(await (await finGet(owner, frozen)).text()).toBe(bytes);
  expect(before.report?.review.id).toBeDefined();
  expect((await fin()).report.entries.find((e) => e.id === id)).toBeDefined();
});
it("normalizes exact review receipt retries and audits once after later source/head changes", async () => {
  const { lot } = await originals(),
    p = await rp("cost", lot);
  p.data.reason = "  " + p.data.reason + "  ";
  await reviewPost(p);
  await save(loss(lot, "1"), "2024-02-04");
  expect((await reviewPost(p)).status).toBe(200);
  expect(
    (
      await tenant(owner, (c) =>
        c.query("SELECT id FROM audit_logs WHERE object_id=$1", [p.reviewId]),
      )
    ).rows,
  ).toHaveLength(1);
  await expect(
    reviewPost({
      ...p,
      data: { ...p.data, evidence: "Synthetic different authority" },
    }),
  ).rejects.toMatchObject({ status: 409 });
});
it("serializes API/direct review roots and successor races with exact predecessor chains", async () => {
  const { lot } = await originals(),
    a = await rp("cost", lot),
    b = await rp("cost", lot, "340");
  const result = await Promise.allSettled([reviewPost(a), reviewDirect(b)]);
  expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const c = await rp("cost", lot, "350"),
    d = await rp("cost", lot, "360"),
    rr = await Promise.allSettled([reviewPost(c), reviewDirect(d)]);
  expect(rr.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await rw("cost", lot)).report?.review.revision).toBe(2);
});
it("rejects stale stock and metadata-only source tokens while retaining saved versions", async () => {
  const { lot, issue } = await originals(),
    p = await rp("cost", lot);
  await save(loss(lot, "1"), "2024-02-03");
  await expect(reviewPost(p)).rejects.toMatchObject({ status: 409 });
  await correction(10);
  const s = await rp("source", issue);
  await correction(10, "Synthetic newer complete daily source metadata");
  await expect(reviewPost(s)).rejects.toMatchObject({ status: 409 });
});
it("enforces populated tenant/role reads and manager-only immutable review inserts", async () => {
  const { lot } = await originals();
  await savedReview("cost", lot);
  for (const actor of [owner, inventory, accounts, auditor])
    expect((await reviewGet(actor)).status).toBe(200);
  for (const actor of [worker, outsider]) {
    await expect(reviewGet(actor)).rejects.toMatchObject({ status: 403 });
    expect(
      (
        await tenant(actor, (c) =>
          c.query(
            "SELECT id FROM feed_reconciliation_reviews WHERE organization_id=$1",
            [org],
          ),
        )
      ).rows,
    ).toEqual([]);
  }
  for (const actor of [inventory, accounts, auditor, worker, outsider])
    await expect(
      reviewDirect(await rp("cost", lot), actor),
    ).rejects.toMatchObject({ code: "42501" });
});
it("ignores forged derived fields and denies actor/time/update/delete bypasses", async () => {
  const { lot } = await originals(),
    p = await rp("cost", lot),
    r = await reviewDirect(
      p,
      owner,
      ",currency,source_snapshot,source_sha256,revision",
      ["USD", { forged: true }, "b".repeat(64), 99],
    );
  expect(r.rows[0]).toMatchObject({
    currency: "NGN",
    revision: 1,
    source_snapshot: { receipt: { id: lot } },
  });
  for (const [extra, values] of [
    [",created_by", [worker]],
    [",created_at", ["2024-01-01"]],
  ] as [string, unknown[]][])
    await expect(
      reviewDirect(await rp("cost", lot), owner, extra, values),
    ).rejects.toMatchObject({ code: "42501" });
  await expect(
    tenant(owner, (c) =>
      c.query("UPDATE feed_reconciliation_reviews SET input=$2 WHERE id=$1", [
        p.reviewId,
        {},
      ]),
    ),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    tenant(owner, (c) =>
      c.query("DELETE FROM feed_reconciliation_reviews WHERE id=$1", [
        p.reviewId,
      ]),
    ),
  ).rejects.toMatchObject({ code: "42501" });
});
it("binds source/receipt/previous versions to genuine same-tenant and matching-kind targets", async () => {
  const { lot, issue } = await originals(),
    id = await savedReview("cost", lot),
    foreign = (
      await tenant(outsider, (c) =>
        c.query(
          "SELECT create_organization('Synthetic foreign feed review') AS id",
        ),
      )
    ).rows[0].id;
  organizations.push(foreign);
  const original = {
    ...(await payload()),
    organizationId: foreign,
    expectedPosition: "0",
    data: feedReceipt(),
  };
  await post(original, outsider);
  const p = await rp("cost", lot);
  p.data.targetId = original.eventId;
  await expect(reviewDirect(p)).rejects.toMatchObject({ code: "23514" });
  const s = await rp("cost", issue);
  s.expectedSourceSha256 = "a".repeat(64);
  await expect(reviewDirect(s)).rejects.toMatchObject({ code: "23514" });
  const wrong = await rp("cost", lot);
  wrong.data.previousId = id === wrong.data.previousId ? randomUUID() : id;
  await expect(reviewDirect(wrong)).rejects.toMatchObject({ code: "23505" });
});
it("fixes independent snapshot and validator schema lookups under caller temp shadows", async () => {
  const { lot } = await originals(),
    p = await rp("cost", lot);
  await tenant(owner, async (c) => {
    await c.query(
      "CREATE TEMP TABLE feed_stock_events AS SELECT * FROM feed_stock_events WHERE false",
    );
    await c.query(
      "CREATE TEMP TABLE active_feed_stock_events AS SELECT * FROM active_feed_stock_events WHERE false",
    );
    await c.query("SET LOCAL search_path=pg_temp,public");
    await c.query(
      "INSERT INTO feed_reconciliation_reviews(id,organization_id,kind,target_id,reviewed_on,expected_stock_position,expected_review_position,expected_source_sha256,input) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        p.reviewId,
        org,
        p.data.kind,
        p.data.targetId,
        p.date,
        p.expectedStockPosition,
        p.expectedReviewPosition,
        p.expectedSourceSha256,
        JSON.stringify(p.data),
      ],
    );
    await c.query(
      "DROP TABLE pg_temp.feed_stock_events,pg_temp.active_feed_stock_events",
    );
  });
  expect(
    (await rw("cost", lot)).report?.review.source_snapshot.receipt?.id,
  ).toBe(lot);
});
it("keeps exact saved cost JSON/CSV immutable after movements, revisions, settings and source voids", async () => {
  const lot = await save(),
    id = await savedReview("cost", lot),
    json = await (await reviewGet(owner, `&reviewId=${id}&format=json`)).text(),
    csv = await (await reviewGet(owner, `&reviewId=${id}&format=csv`)).text();
  await savedReview("cost", lot, "340");
  await save(voided(lot), "2024-02-04");
  await tenant(owner, (c) =>
    c.query(
      "UPDATE organizations SET currency='USD',timezone='UTC' WHERE id=$1",
      [org],
    ),
  );
  expect(
    await (await reviewGet(auditor, `&reviewId=${id}&format=json`)).text(),
  ).toBe(json);
  expect(
    await (await reviewGet(accounts, `&reviewId=${id}&format=csv`)).text(),
  ).toBe(csv);
  expect(
    (await reviewGet(auditor, `&reviewId=${id}&format=csv`)).headers.get(
      "Cache-Control",
    ),
  ).toBe("private, no-store");
});
it("supports fully dispatched lot cost reviews with exact complete-depletion residuals", async () => {
  const lot = await save({ ...feedReceipt(), weightKg: "3", totalCost: "3" });
  await save(loss(lot, "1"));
  await save(loss(lot, "2"));
  await savedReview("cost", lot, "0.0001");
  expect((await rw("cost", lot)).report?.results).toMatchObject({
    remainingKg: "0.000000",
    reviewedRemainingValue: "0.0000",
    reviewedLostValue: "0.0001",
  });
});
it("rejects unsupported review scope, extra price claims, date and precision in direct writes", async () => {
  const { lot } = await originals();
  for (const patch of [
    { totalCost: "-1" },
    { totalCost: "1.00001" },
    { costEvidence: "" },
    { scope: "forecast" },
    { amount: "999" },
  ]) {
    const p = await rp("cost", lot);
    p.data = { ...p.data, ...patch } as FeedReviewData;
    await expect(reviewDirect(p)).rejects.toMatchObject({ code: "23514" });
  }
  const p = await rp("cost", lot);
  p.date = "2024-01-01";
  await expect(reviewDirect(p)).rejects.toMatchObject({ code: "23514" });
  expect(feedReviewInput.safeParse({ ...p, date: "2024-02-30" }).success).toBe(
    false,
  );
});
it("refuses oversized current source without a review/audit and preserves earlier exact exports", async () => {
  const { lot } = await originals(),
    id = await savedReview("cost", lot),
    frozen = `&reviewId=${id}&format=json`,
    bytes = await (await reviewGet(owner, frozen)).text(),
    p = await rp("cost", lot);
  let size = 0;
  while (size <= 524288) {
    await direct(
      await payload(
        {
          ...loss(lot, "0.1"),
          reason: "x".repeat(2000),
          evidence: "x".repeat(2000),
        },
        "2024-02-03",
      ),
    );
    size = (
      await tenant(owner, (c) =>
        c.query(
          "SELECT octet_length(feed_review_snapshot($1,'cost',$2)::text) AS n",
          [org, lot],
        ),
      )
    ).rows[0].n;
  }
  const row = (
    await tenant(owner, (c) =>
      c.query(
        "SELECT (SELECT max(position)::text FROM feed_stock_events WHERE organization_id=$1) AS head,encode(sha256(convert_to(feed_review_snapshot($1,'cost',$2)::text,'UTF8')),'hex') AS sha",
        [org, lot],
      ),
    )
  ).rows[0];
  p.expectedStockPosition = row.head;
  p.expectedSourceSha256 = row.sha;
  await expect(reviewPost(p)).rejects.toMatchObject({ code: "23514" });
  await expect(rw("cost", lot)).rejects.toMatchObject({ status: 422 });
  expect(
    (
      await admin.query(
        "SELECT id FROM feed_reconciliation_reviews WHERE id=$1",
        [p.reviewId],
      )
    ).rows,
  ).toEqual([]);
  expect(
    (
      await admin.query("SELECT id FROM audit_logs WHERE object_id=$1", [
        p.reviewId,
      ])
    ).rows,
  ).toEqual([]);
  expect(await (await reviewGet(auditor, frozen)).text()).toBe(bytes);
});
