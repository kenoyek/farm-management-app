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
const reversal = (originalId: string, date = "2024-02-04"): JournalData => ({
  kind: "reverse",
  originalId,
  date,
  reason: "Synthetic original reviewed cost correction",
  evidence: "Synthetic accounting-only correction evidence",
});
import { feedCountsApi } from "../src/lib/feed-counts-api";
import {
  type FeedCountData,
  type FeedCountInput,
  type FeedCountWorkspace,
  type FeedCountReport,
} from "../src/lib/feed-counts";
async function countsGet(actor = owner, extra = "", organization = org) {
  return (await feedCountsApi(
    new NextRequest(
      `http://localhost/api/inventory/feed/counts?organizationId=${organization}${extra}`,
    ),
    { id: actor },
    "inventory/feed/counts",
  ))!;
}
async function counts(lotId = "", id = ""): Promise<FeedCountWorkspace> {
  return (
    await countsGet(
      owner,
      (lotId ? "&lotId=" + lotId : "") + (id ? "&eventId=" + id : ""),
    )
  ).json();
}
async function countPost(p: FeedCountInput, actor = owner) {
  return (await feedCountsApi(
    new NextRequest("http://localhost/api/inventory/feed/counts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(p),
    }),
    { id: actor },
    "inventory/feed/counts",
  ))!;
}
async function measured(
  lotId: string,
  countedKg = "90",
): Promise<FeedCountData> {
  const w = await counts(lotId);
  return {
    kind: "count",
    lotId,
    date: "2024-02-03",
    previousId: w.selected!.latestId,
    reference: "SYNTHETIC-COUNT-" + randomUUID(),
    countedKg,
    scope: "actual-weighed-unused-feed-lot-count",
    reason: "Synthetic actual unused-feed stocktake measurement",
    evidence:
      "Synthetic original identified-lot physical scale and count register",
  };
}
const resolve = (countId: string): FeedCountData => ({
  kind: "resolve_shortage",
  countId,
  scope: "approve-weighed-shortage-as-feed-loss",
  reason: "Synthetic manager-approved unexplained physical shortage",
  evidence: "Synthetic count investigation and explicit approval as stock loss",
});
async function takePayload(data: FeedCountData): Promise<FeedCountInput> {
  const target =
      data.kind === "count"
        ? data.lotId
        : (
            (await (
              await countsGet(
                owner,
                "&eventId=" + data.countId + "&format=json",
              )
            ).json()) as FeedCountReport
          ).event.lot_id,
    w = await counts(target);
  return {
    organizationId: org,
    eventId: randomUUID(),
    expectedStockPosition: w.expectedStockPosition,
    expectedCountPosition: w.expectedCountPosition,
    expectedSourceSha256: w.selected!.sourceSha256!,
    data,
  };
}
async function savedCount(data: FeedCountData, actor = owner) {
  const p = await takePayload(data);
  expect((await countPost(p, actor)).status).toBe(201);
  return p.eventId;
}
async function countDirect(
  p: FeedCountInput,
  actor = owner,
  extra = "",
  values: unknown[] = [],
) {
  return tenant(actor, (c) =>
    c.query(
      `INSERT INTO feed_stocktakes(id,organization_id,expected_stock_position,expected_count_position,expected_source_sha256,input${extra}) VALUES($1,$2,$3,$4,$5,$6${values.map((_, i) => ",$" + (i + 7)).join("")}) RETURNING *`,
      [
        p.eventId,
        p.organizationId,
        p.expectedStockPosition,
        p.expectedCountPosition,
        p.expectedSourceSha256,
        JSON.stringify(p.data),
        ...values,
      ],
    ),
  );
}
it("records an immutable shortage observation without stock/finance writes and derives complete source/values", async () => {
  const { lot } = await originals(),
    before = await workspace(),
    books = (await fin()).report,
    id = await savedCount(await measured(lot, "90"), inventory),
    w = await counts(lot, id);
  expect(w.report).toMatchObject({
    results: {
      recordedKg: "94.876544",
      countedKg: "90.000000",
      varianceKg: "-4.876544",
      classification: "shortage",
      recordedValue: "284.6297",
      shortageValue: "14.6296",
      shortageKg: "4.876544",
      appliedLossId: null,
    },
  });
  expect(w.report!.event.source_snapshot).toMatchObject({
    receipt: { id: lot },
    events: before.report.events,
  });
  expect((await workspace()).report).toEqual(before.report);
  expect((await fin()).report).toEqual(books);
  expect(w.counts[0].canResolve).toBe(true);
});
it("only a manager can atomically append one exact current count shortage loss without Finance", async () => {
  const { lot } = await originals(),
    id = await savedCount(await measured(lot, "90")),
    p = await takePayload(resolve(id)),
    beforeBooks = (await fin()).report;
  await expect(countPost(p, inventory)).rejects.toMatchObject({ status: 403 });
  await expect(countDirect(p, inventory)).rejects.toMatchObject({
    code: "42501",
  });
  const r = await countPost(p),
    w = await workspace(),
    c = await counts(lot, p.eventId);
  expect(r.status).toBe(201);
  expect(w.report.events.at(-1)).toMatchObject({
    id: p.eventId,
    kind: "loss",
    weight_kg: "4.876544",
    amount: "14.6296",
    recorded_on: "2024-02-03",
  });
  expect(w.report.results.lots[0].balanceKg).toBe("90.000000");
  expect(c.report!.results.appliedLossId).toBe(p.eventId);
  expect((await fin()).report).toEqual(beforeBooks);
  expect(c.counts[0]).toMatchObject({
    resolutionId: p.eventId,
    lossActive: true,
    canResolve: false,
  });
});
it("keeps surplus and matching counts non-posting and refuses shortage approval for either", async () => {
  const lot = await save();
  for (const kg of ["105", "100"]) {
    const id = await savedCount(await measured(lot, kg));
    await expect(
      countPost(await takePayload(resolve(id))),
    ).rejects.toMatchObject({ status: 409 });
    expect((await workspace()).report.events).toHaveLength(1);
  }
  expect((await counts(lot)).counts[0]).toMatchObject({
    classification: "match",
    canResolve: false,
  });
});
it("preserves unknown/zero values and complete-depletion residuals without inventing costs", async () => {
  const unknown = await save({
      ...feedReceipt(),
      totalCost: null,
      costEvidence: null,
    }),
    zero = await save({ ...feedReceipt(), totalCost: "0" }),
    tiny = await save({ ...feedReceipt(), weightKg: "3", totalCost: "0.0001" });
  for (const [lot, kg, value] of [
    [unknown, "0", null],
    [zero, "0", "0.0000"],
    [tiny, "2", "0.0000"],
  ] as const) {
    const id = await savedCount(await measured(lot, kg)),
      ap = await savedCount(resolve(id)),
      w = await workspace();
    expect(w.report.events.find((e) => e.id === ap)!.amount).toBe(value);
  }
  const id = await savedCount(await measured(tiny, "0")),
    ap = await savedCount(resolve(id));
  expect(
    (await workspace()).report.events.find((e) => e.id === ap)!.amount,
  ).toBe("0.0001");
});
it("normalizes exact count/approval receipts and audits once after later events", async () => {
  const lot = await save(),
    p = await takePayload(await measured(lot));
  await countPost(p);
  const r = await takePayload(resolve(p.eventId));
  await countPost(r);
  await save(loss(lot), "2024-02-04");
  expect((await countPost(p)).status).toBe(200);
  expect((await countPost(r)).status).toBe(200);
  for (const id of [p.eventId, r.eventId])
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM audit_logs WHERE object_id=$1",
          [id],
        )
      ).rows[0].n,
    ).toBe(1);
  expect(
    (await workspace()).report.events.filter((e) => e.id === r.eventId),
  ).toHaveLength(1);
  await expect(
    countPost({
      ...r,
      data: { ...r.data, evidence: "Synthetic different approval evidence" },
    }),
  ).rejects.toMatchObject({ status: 409 });
});
it("requires latest count/source, exact heads and predecessor while another lot only requires reload", async () => {
  const lot = await save(),
    id = await savedCount(await measured(lot)),
    stale = await takePayload(resolve(id)),
    newId = await savedCount(await measured(lot, "95"));
  await expect(countPost(stale)).rejects.toMatchObject({ status: 409 });
  await expect(countPost(await takePayload(resolve(id)))).rejects.toMatchObject(
    { status: 409 },
  );
  await save(loss(lot));
  await expect(
    countPost(await takePayload(resolve(newId))),
  ).rejects.toMatchObject({ status: 409 });
  expect((await counts(lot)).counts[0].sourceCurrent).toBe(false);
  const fresh = await savedCount(await measured(lot, "90")),
    p = await takePayload(resolve(fresh));
  await save();
  await expect(countPost(p)).rejects.toMatchObject({ status: 409 });
  expect((await countPost(await takePayload(resolve(fresh)))).status).toBe(201);
});
it("serializes concurrent API/direct counts and approvals with one loss and no duplicate resolution", async () => {
  const lot = await save(),
    data = await measured(lot),
    a = await takePayload(data),
    b = { ...a, eventId: randomUUID() },
    race = await Promise.allSettled([countPost(a), countDirect(b)]);
  expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const current = (await counts(lot)).counts[0],
    x = await takePayload(resolve(current.id)),
    y = { ...x, eventId: randomUUID() },
    r = await Promise.allSettled([countPost(x), countDirect(y)]);
  expect(r.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(
    (await workspace()).report.events.filter((e) => e.kind === "loss"),
  ).toHaveLength(1);
});
it("serializes approval versus physical loss so a stale count never over-adjusts", async () => {
  const lot = await save(),
    id = await savedCount(await measured(lot)),
    a = await takePayload(resolve(id)),
    b = await payload(loss(lot, "20")),
    race = await Promise.allSettled([countPost(a), direct(b)]);
  expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(["90.000000", "80.000000"]).toContain(
    (await workspace()).report.results.lots[0].balanceKg,
  );
});
it("enforces populated reader/writer/tenant and immutable actor/time/derived-field guards", async () => {
  const lot = await save(),
    p = await takePayload(await measured(lot));
  for (const actor of [accounts, auditor, worker, outsider])
    await expect(countPost(p, actor)).rejects.toMatchObject({ status: 403 });
  for (const actor of [owner, inventory, accounts, auditor])
    expect((await countsGet(actor)).status).toBe(200);
  for (const actor of [worker, outsider])
    await expect(countsGet(actor)).rejects.toMatchObject({ status: 403 });
  for (const [extra, values] of [
    [",created_by", [worker]],
    [",created_at", ["2024-01-01"]],
  ] as [string, unknown[]][])
    await expect(countDirect(p, owner, extra, values)).rejects.toMatchObject({
      code: "42501",
    });
  const r = await countDirect(
    p,
    inventory,
    ",recorded_kg,counted_kg,variance_kg,currency,source_snapshot",
    ["1", "1", "0", "USD", { forged: true }],
  );
  expect(r.rows[0]).toMatchObject({
    recorded_kg: "100.000000",
    counted_kg: "90.000000",
    variance_kg: "-10.000000",
    currency: "NGN",
  });
  await expect(
    tenant(owner, (c) =>
      c.query("UPDATE feed_stocktakes SET counted_kg=99 WHERE id=$1", [
        p.eventId,
      ]),
    ),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    tenant(owner, (c) =>
      c.query("DELETE FROM feed_stocktakes WHERE id=$1", [p.eventId]),
    ),
  ).rejects.toMatchObject({ code: "42501" });
  const foreign = (
    await tenant(outsider, (c) =>
      c.query(
        "SELECT create_organization('Synthetic foreign stocktake') AS id",
      ),
    )
  ).rows[0].id;
  organizations.push(foreign);
  const fp: FeedStockInput = {
    organizationId: foreign,
    eventId: randomUUID(),
    date: "2024-02-01",
    expectedPosition: "0",
    data: feedReceipt(),
  };
  await post(fp, outsider);
  await expect(
    countDirect({
      ...p,
      eventId: randomUUID(),
      expectedCountPosition: (await counts()).expectedCountPosition,
      data: { ...p.data, lotId: fp.eventId } as FeedCountData,
    }),
  ).rejects.toMatchObject({ code: "23514" });
});
it("rejects malformed scope/quantity/date/hash/reference and wrong target declarations directly", async () => {
  const lot = await save(),
    p = await takePayload(await measured(lot));
  for (const patch of [
    { scope: "manufactured-opening-stock" },
    { countedKg: "-1" },
    { countedKg: "1.0000001" },
    { reference: "" },
    { date: "2099-01-01" },
    { date: "2024-01-31" },
  ])
    await expect(
      countDirect({ ...p, data: { ...p.data, ...patch } as FeedCountData }),
    ).rejects.toMatchObject({ code: "23514" });
  await expect(
    countDirect({ ...p, expectedSourceSha256: "0".repeat(64) }),
  ).rejects.toMatchObject({ code: "23505" });
  await countPost(p);
  await expect(
    countPost({ ...(await takePayload(await measured(lot))), data: p.data }),
  ).rejects.toMatchObject({ status: 409 });
});
it("retains full count authority in original loss recognition and protects physical voids until Finance reverses", async () => {
  const lot = await save(),
    id = await savedCount(await measured(lot)),
    lossId = await savedCount(resolve(id));
  await booked(rec(lot));
  const journal = await booked(rec(lossId, null, null)),
    e = (await fin()).report.entries.find((e) => e.id === journal)!;
  expect(e.source_snapshot).toMatchObject({
    countEvidence: {
      id: lossId,
      source_snapshot: { count: { id }, loss: { id: lossId } },
    },
  });
  await expect(
    post(await payload(voided(lossId)), owner),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    post(await payload(voided(lossId)), inventory),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    direct(await payload(voided(lossId), "2024-02-03"), inventory),
  ).rejects.toMatchObject({ code: "42501" });
  await booked(reversal(journal));
  await save(voided(lossId), "2024-02-04");
  expect((await counts(lot)).counts[0]).toMatchObject({
    lossActive: false,
    resolutionId: lossId,
    canResolve: false,
  });
});
it("retains count/manager proof in reviewed-cost loss components without changing earlier posted books", async () => {
  const lot = await save();
  await booked(rec(lot));
  await booked(priced(await savedReview("cost", lot)));
  const id = await savedCount(await measured(lot)),
    lossId = await savedCount(resolve(id)),
    review = await savedReview("cost", lot, "330"),
    journal = await booked(priced(review)),
    e = (await fin()).report.entries.find((e) => e.id === journal)!;
  expect(e.source_snapshot).toMatchObject({ purchaseDelta: "0.0000" });
  expect(e.lines).toEqual([
    { account: "1200", side: "credit", amount: "33.0000" },
    { account: "5200", side: "debit", amount: "33.0000" },
  ]);
  expect(
    (
      e.source_snapshot as {
        components: { eventId: string; countEvidence?: { id: string } }[];
      }
    ).components.find((c) => c.eventId === lossId)!.countEvidence!.id,
  ).toBe(lossId);
});
it("preserves exact observation, approval and old stock/finance/review exports through recounts, settings and reversal", async () => {
  const lot = await save();
  await booked(rec(lot));
  const review = await savedReview("cost", lot),
    stock = await workspace(),
    finance = await fin(),
    sf = `&asOf=${stock.report.asOf}&throughPosition=${stock.expectedPosition}&format=json`,
    ff = `&asOf=${finance.report.asOf}&throughPosition=${finance.expectedPosition}&format=json`,
    sb = await (await get(owner, sf)).text(),
    fb = await (await finGet(owner, ff)).text(),
    rb = await (
      await reviewGet(owner, "&reviewId=" + review + "&format=json")
    ).text(),
    count = await savedCount(await measured(lot)),
    cb = await (
      await countsGet(owner, "&eventId=" + count + "&format=json")
    ).text(),
    approval = await savedCount(resolve(count)),
    ab = await (
      await countsGet(owner, "&eventId=" + approval + "&format=json")
    ).text();
  await savedCount(await measured(lot, "90"));
  await save(voided(approval), "2024-02-04");
  await tenant(owner, (c) =>
    c.query(
      "UPDATE organizations SET currency='USD',timezone='UTC' WHERE id=$1",
      [org],
    ),
  );
  await booked({ ...manualJournal(), currency: "USD" });
  expect(await (await get(owner, sf)).text()).toBe(sb);
  expect(await (await finGet(owner, ff)).text()).toBe(fb);
  expect(
    await (
      await reviewGet(owner, "&reviewId=" + review + "&format=json")
    ).text(),
  ).toBe(rb);
  expect(
    await (await countsGet(owner, "&eventId=" + count + "&format=json")).text(),
  ).toBe(cb);
  expect(
    await (
      await countsGet(owner, "&eventId=" + approval + "&format=json")
    ).text(),
  ).toBe(ab);
});
it("keeps count and approval SQL fixed under caller temporary schema shadows", async () => {
  const lot = await save(),
    p = await takePayload(await measured(lot));
  await tenant(owner, async (c) => {
    await c.query(
      "CREATE TEMP TABLE feed_stock_events AS SELECT * FROM feed_stock_events WHERE false",
    );
    await c.query(
      "CREATE TEMP TABLE feed_stocktakes AS SELECT * FROM feed_stocktakes WHERE false",
    );
    await c.query("SET LOCAL search_path=pg_temp,public");
    await c.query(
      "INSERT INTO public.feed_stocktakes(id,organization_id,expected_stock_position,expected_count_position,expected_source_sha256,input) VALUES($1,$2,$3,$4,$5,$6)",
      [
        p.eventId,
        org,
        p.expectedStockPosition,
        p.expectedCountPosition,
        p.expectedSourceSha256,
        JSON.stringify(p.data),
      ],
    );
    await c.query(
      "DROP TABLE pg_temp.feed_stock_events,pg_temp.feed_stocktakes",
    );
  });
  expect((await counts(lot, p.eventId)).report!.results.recordedKg).toBe(
    "100.000000",
  );
});
it("keeps actual-source changes visible and counts only unused physical stock", async () => {
  const { lot } = await originals();
  await correction(2, "Synthetic truthful lower actual consumed feed");
  const before = await workspace(),
    id = await savedCount(await measured(lot, "90"));
  await savedCount(resolve(id));
  const after = await workspace();
  expect(after.changedSources).toEqual(before.changedSources);
  expect(after.report.results.lots[0].consumedKg).toBe("3.123456");
});
it("rolls back approval, its derived loss and audit when the required physical report exceeds its bound", async () => {
  const lot = await save(),
    id = await savedCount(await measured(lot));
  let filler = lot;
  const bytes = async () =>
    Buffer.byteLength(JSON.stringify((await workspace()).report));
  while ((await bytes()) < 1_020_000) {
    try {
      filler = await save({
        ...feedReceipt(),
        reason: "R".repeat(2000),
        evidence: "E".repeat(2000),
        costEvidence: "C".repeat(2000),
      });
    } catch (e) {
      if ((e as { status?: number }).status === 422) break;
      throw e;
    }
  }
  while ((await bytes()) < 1_038_000) {
    try {
      await save({
        ...loss(filler, "0.000001"),
        reason: "R".repeat(2000),
        evidence: "E".repeat(2000),
      });
    } catch (e) {
      if ((e as { status?: number }).status === 422) break;
      throw e;
    }
  }
  const before = await bytes();
  await save(loss(filler, "0.000001"));
  const now = await bytes(),
    baseSize = now - before,
    pad = Math.max(
      0,
      Math.min(3800, Math.floor((1_048_000 - now - baseSize) / 2)),
    );
  if (now < 1_044_000) {
    const data = loss(filler, "0.000001");
    await save({
      ...data,
      reason: data.reason + "R".repeat(Math.min(1900, pad)),
      evidence: data.evidence + "E".repeat(Math.max(0, pad - 1900)),
    });
  }
  const p = await takePayload(resolve(id));
  p.data = { ...p.data, reason: "R".repeat(1000), evidence: "E".repeat(1500) };
  await expect(countPost(p)).rejects.toMatchObject({ status: 422 });
  for (const table of ["feed_stocktakes", "feed_stock_events", "audit_logs"]) {
    const column = table === "audit_logs" ? "object_id" : "id";
    expect(
      (
        await admin.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1`,
          [p.eventId],
        )
      ).rows[0].n,
    ).toBe(0);
  }
  expect((await counts(lot)).counts[0].canResolve).toBe(true);
});
it("refuses oversized current sources while exact saved count evidence stays readable", async () => {
  const lot = await save(),
    id = await savedCount(await measured(lot)),
    exact = "&eventId=" + id + "&format=json",
    before = await (await countsGet(owner, exact)).text();
  while (
    Buffer.byteLength(JSON.stringify((await workspace()).report.events)) <
    280_000
  )
    await save({
      ...loss(lot, "1"),
      reason: "R".repeat(2000),
      evidence: "E".repeat(2000),
    });
  const w = await counts(lot, id);
  expect(w.selected).toMatchObject({
    sourceTooLarge: true,
    source: null,
    sourceSha256: null,
  });
  expect(await (await countsGet(owner, exact)).text()).toBe(before);
  const p: FeedCountInput = {
    organizationId: org,
    eventId: randomUUID(),
    expectedStockPosition: w.expectedStockPosition,
    expectedCountPosition: w.expectedCountPosition,
    expectedSourceSha256: w.report!.event.source_sha256,
    data: resolve(id),
  };
  await expect(countPost(p)).rejects.toMatchObject({ status: 422 });
  expect((await counts(lot)).counts[0].resolutionId).toBeNull();
});
it("counts remaining unused stock after genuine supplier returns without recategorizing returned feed", async () => {
  const lot = await save();
  await save({
    kind: "supplier_return",
    lotId: lot,
    weightKg: "10",
    returnReference: "SYNTHETIC-RETURN-" + randomUUID(),
    supplierEvidence: "Synthetic supplier signed unused-feed handover",
    scope: "actual-unused-feed-return-to-original-supplier",
    reason: "Synthetic actual unused-feed return",
    evidence: "Synthetic scale and original supplier dispatch",
  });
  const id = await savedCount(await measured(lot, "85")),
    ap = await savedCount(resolve(id)),
    w = await workspace();
  expect(w.report.results.lots[0]).toMatchObject({
    returnedKg: "10.000000",
    lostKg: "5.000000",
    balanceKg: "85.000000",
  });
  expect(w.report.events.find((e) => e.id === ap)!.amount).toBe("15.0000");
});
