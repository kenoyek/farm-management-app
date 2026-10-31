import { beforeAll, beforeEach, afterAll, it, expect } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { admin } from "./admin-db";
import { tenant, pool } from "../src/lib/db";
import { financialJournalApi } from "../src/lib/financial-journal-api";
import {
  journalInput,
  reverseLines,
  type JournalInput,
  type JournalData,
  type JournalWorkspace,
  type JournalReport,
} from "../src/lib/financial-journal";
import { manualJournal } from "./financial-journal-fixture";
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
  (await (path === "finance/journal" ? financialJournalApi : productionApi)(
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
const organizations: string[] = [];
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
  foreign = (
    await tenant(outsider, (c) =>
      c.query("SELECT create_organization('Foreign synthetic finance') AS id"),
    )
  ).rows[0].id;
  organizations.push(foreign);
  foreignFarm = (
    await tenant(outsider, (c) =>
      c.query(
        "INSERT INTO farms(organization_id,name,kind) VALUES($1,'Foreign finance farm','broilers') RETURNING id",
        [foreign],
      ),
    )
  ).rows[0].id;
});
beforeEach(async () => {
  org = (
    await tenant(owner, (c) =>
      c.query(
        "SELECT create_organization('Synthetic financial journal') AS id",
      ),
    )
  ).rows[0].id;
  organizations.push(org);
  await admin.query(
    "INSERT INTO memberships VALUES($1,$2,'worker'),($1,$3,'auditor')",
    [org, worker, auditor],
  );
  farm = (
    await tenant(owner, (c) =>
      c.query(
        "INSERT INTO farms(organization_id,name,kind) VALUES($1,'Synthetic journal farm','broilers') RETURNING id",
        [org],
      ),
    )
  ).rows[0].id;
});
afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])", [
    organizations,
  ]);
  await admin.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
    [owner, worker, auditor, outsider],
  ]);
  await pool.end();
  await admin.end();
});
async function financialGet(
  actor = owner,
  format = "workspace",
  asOf?: string,
  through?: string,
  organization = org,
) {
  return (await financialJournalApi(
    new NextRequest(
      `http://localhost/api/finance/journal?organizationId=${organization}&format=${format}${asOf ? "&asOf=" + asOf : ""}${through ? "&throughPosition=" + through : ""}`,
    ),
    { id: actor },
    "finance/journal",
  ))!;
}
async function workspace(actor = owner): Promise<JournalWorkspace> {
  return (await financialGet(actor)).json();
}
async function payload(
  data: JournalData = manualJournal(),
): Promise<JournalInput> {
  const w = await workspace();
  return {
    organizationId: org,
    entryId: randomUUID(),
    expectedPosition: w.expectedPosition,
    data,
  };
}
async function direct(
  actor: string,
  p: JournalInput,
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
const recognize = (
  id: string,
  kind: "live" | "product",
  cash = false,
): JournalData => ({
  kind: "recognize_sale",
  sourceKind: kind,
  sourceId: id,
  settlement: cash ? "cash_bank" : "receivables",
  cashEvidence: cash ? "Synthetic original cash receipt" : null,
  policy: "recorded-dispatch-value-v1",
  reason: "Synthetic evidenced sale accounting recognition",
  evidence: "Synthetic recorded dispatch and accounting recognition source",
});
const reversal = (id: string, date = "2024-02-04"): JournalData => ({
  kind: "reverse",
  originalId: id,
  date,
  reason: "Synthetic accounting correction with original lines",
  evidence: "Synthetic original journal correction authority",
});
async function posted(data: JournalData = manualJournal()) {
  const p = await payload(data);
  expect((await post(owner, "finance/journal", p)).status).toBe(201);
  return p.entryId;
}
async function sales() {
  const b = await setup(),
    h = await source(b.unit),
    liveId = randomUUID();
  await post(owner, "broilers/lifecycle", {
    organizationId: org,
    unitId: b.unit,
    eventId: liveId,
    kind: "harvest",
    date: "2024-02-01",
    quantity: 5,
    weightKg: "10",
    priceBasis: "kg",
    pricePerUnit: "2.5555",
    reference: "SYNTHETIC-LIVE-" + randomUUID(),
    customer: "Synthetic live buyer",
    description: "Synthetic priced live harvest",
    reason: "Synthetic actual weighed dispatch",
    evidence: "Synthetic original live sale register",
    expectedPosition: h.summary.expectedPosition,
    expectedDailyId: h.summary.expectedDailyId,
  });
  const lot = await saveProduct(b.unit, receipt(b.reviewId)),
    saleId = await saveProduct(b.unit, sale(lot, "3.123456", "1.2345"));
  return { ...b, liveId, lot, saleId };
}
it("posts exact manual debits/credits once and produces a genuine original-currency trial balance", async () => {
  const p = await payload();
  expect((await post(owner, "finance/journal", p)).status).toBe(201);
  const w = await workspace();
  expect(w.report.entries).toHaveLength(1);
  expect(w.report.entries[0].submission).toEqual(journalInput.parse(p));
  expect(w.report.trialBalance[0]).toMatchObject({
    currency: "NGN",
    debits: "100.0000",
    credits: "100.0000",
    debitBalances: "100.0000",
    creditBalances: "100.0000",
  });
  expect(w.report.entries[0].created_by).toBe(owner);
});
it("recognizes exact live and product values with original snapshots without changing operational rows or cost sources", async () => {
  const b = await sales(),
    before = await source(b.unit),
    products = await productReport(b.unit);
  const liveId = await posted(recognize(b.liveId, "live")),
    productId = await posted(recognize(b.saleId, "product", true)),
    w = await workspace();
  expect(w.unrecognizedSales).toBe(0);
  expect(w.activeSales).toBe(2);
  expect(w.report.entries.find((e) => e.id === liveId)).toMatchObject({
    posted_on: "2024-02-01",
    currency: "NGN",
    lines: [
      { account: "1100", side: "debit", amount: "25.5550" },
      { account: "4000", side: "credit", amount: "25.5550" },
    ],
  });
  const e = w.report.entries.find((e) => e.id === productId)!;
  expect(e.lines).toEqual([
    { account: "1000", side: "debit", amount: "3.8559" },
    { account: "4100", side: "credit", amount: "3.8559" },
  ]);
  expect(e.source_snapshot!.event).toEqual(
    products.events.find((x) => x.id === b.saleId),
  );
  expect(e.source_snapshot!.lot).toEqual(
    products.events.find((x) => x.id === b.lot),
  );
  expect(await source(b.unit)).toEqual(before);
  expect(await productReport(b.unit)).toEqual(products);
});
it("preserves explicit zero-valued sale recognition and rejects unpriced, voided and genuine foreign sources", async () => {
  const b = await setup(),
    zero = await saveProduct(
      b.unit,
      sale(await saveProduct(b.unit, receipt(b.reviewId)), "1", "0"),
    );
  await posted(recognize(zero, "product"));
  expect(
    (await workspace()).report.entries[0].lines.every(
      (l) => l.amount === "0.0000",
    ),
  ).toBe(true);
  await expect(
    post(owner, "finance/journal", await payload(recognize(b.harvest, "live"))),
  ).rejects.toMatchObject({ status: 409 });
  const v = await saveProduct(
    b.unit,
    sale((await productReport(b.unit)).events[0].id),
  );
  await saveProduct(b.unit, voided(v));
  await expect(
    direct(owner, journalInput.parse(await payload(recognize(v, "product")))),
  ).rejects.toMatchObject({ code: "23514" });
  const f = await setup(outsider, foreign, foreignFarm);
  await expect(
    direct(
      owner,
      journalInput.parse(await payload(recognize(f.harvest, "live"))),
    ),
  ).rejects.toMatchObject({ code: "23514" });
});
it("replays normalized receipts after later entries and reversals with one audit while refusing changed receipt data", async () => {
  const p = await payload();
  if (p.data.kind !== "manual") throw Error();
  p.data.reason = "  Synthetic original opening book review  ";
  await post(owner, "finance/journal", p);
  await posted();
  await posted(reversal(p.entryId));
  expect((await post(owner, "finance/journal", p)).status).toBe(200);
  expect(
    (
      await tenant(owner, (c) =>
        c.query(
          "SELECT count(*)::int AS n FROM audit_logs WHERE object_id=$1",
          [p.entryId],
        ),
      )
    ).rows[0].n,
  ).toBe(1);
  await expect(
    post(owner, "finance/journal", {
      ...p,
      data: { ...p.data, reason: "Synthetic different receipt claim" },
    }),
  ).rejects.toMatchObject({ status: 409 });
});
it("serializes competing API and direct-runtime journal heads across different units", async () => {
  const a = await sales(),
    b = await sales(),
    x = await payload(recognize(a.liveId, "live")),
    y = await payload(recognize(b.saleId, "product"));
  const r = await Promise.allSettled([
    post(owner, "finance/journal", x),
    post(owner, "finance/journal", y),
  ]);
  expect(r.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const p = journalInput.parse(await payload()),
    q = journalInput.parse(await payload());
  const d = await Promise.allSettled([direct(owner, p), direct(owner, q)]);
  expect(d.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await workspace()).report.entries).toHaveLength(2);
});
it("prevents duplicate active recognition, then permits exact re-recognition after an opposite accounting reversal", async () => {
  const b = await sales(),
    first = await posted(recognize(b.saleId, "product"));
  await expect(
    post(
      owner,
      "finance/journal",
      await payload(recognize(b.saleId, "product")),
    ),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    direct(
      owner,
      journalInput.parse(await payload(recognize(b.saleId, "product"))),
    ),
  ).rejects.toMatchObject({ code: "23505" });
  await posted(reversal(first));
  expect((await workspace()).unrecognizedSales).toBe(2);
  await posted(recognize(b.saleId, "product"));
  const w = await workspace();
  expect(w.report.entries).toHaveLength(3);
  expect(w.unrecognizedSales).toBe(1);
  expect(
    w.report.trialBalance[0].accounts.find((a) => a.code === "4100")!
      .creditBalance,
  ).toBe("3.8559");
});
it("protects recognized operational sales from API/direct voids until accounting reversal, without refunding cash or returning stock", async () => {
  const b = await sales(),
    j = await posted(recognize(b.saleId, "product", true)),
    p = await productPayload(b.unit, voided(b.saleId));
  await expect(post(owner, "broilers/products", p)).rejects.toMatchObject({
    status: 409,
  });
  await expect(
    tenant(owner, (c) =>
      c.query(
        "INSERT INTO broiler_product_events(id,organization_id,unit_id,lot_id,recorded_on,expected_position,expected_source_position,expected_daily_id,input) VALUES($1,$2,$3,$1,$4,$5,$6,$7,$8)",
        [
          p.eventId,
          org,
          b.unit,
          p.date,
          p.expectedPosition,
          p.expectedSourcePosition,
          p.expectedDailyId,
          JSON.stringify(p.data),
        ],
      ),
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await posted(reversal(j));
  expect((await productReport(b.unit)).results.lots[0].balanceKg).toBe(
    "10.876544",
  );
  await saveProduct(b.unit, voided(b.saleId));
  expect((await productReport(b.unit)).results.lots[0].balanceKg).toBe(
    "14.000000",
  );
  expect((await workspace()).report.trialBalance[0].debitBalances).toBe(
    "0.0000",
  );
});
it("protects recognized live-sale voids and keeps original currency on reversals after settings changes", async () => {
  const b = await sales(),
    j = await posted(recognize(b.liveId, "live")),
    h = await source(b.unit),
    v = {
      organizationId: org,
      unitId: b.unit,
      eventId: randomUUID(),
      kind: "void",
      date: h.summary.asOf,
      voidOfId: b.liveId,
      description: "Synthetic erroneous live sale correction",
      reason: "Synthetic reviewed erroneous original dispatch",
      evidence: "Synthetic original correction record",
      expectedPosition: h.summary.expectedPosition,
      expectedDailyId: h.summary.expectedDailyId,
    };
  await expect(post(owner, "broilers/lifecycle", v)).rejects.toMatchObject({
    status: 409,
  });
  await admin.query(
    "UPDATE organizations SET currency='USD',timezone='UTC' WHERE id=$1",
    [org],
  );
  const rev = await posted(reversal(j));
  const w = await workspace(),
    e = w.report.entries.find((e) => e.id === rev)!;
  expect(e.currency).toBe("NGN");
  expect(e.lines).toEqual(
    reverseLines(w.report.entries.find((e) => e.id === j)!.lines),
  );
  await expect(
    post(owner, "finance/journal", await payload(reversal(rev))),
  ).rejects.toMatchObject({ code: "23514" });
});
it("keeps as-of dates and append cutoffs reproducible after later reversals, backdated posts and settings", async () => {
  const first = await posted(),
    head = (await workspace()).expectedPosition,
    json = await (await financialGet(owner, "json", "2024-02-01", head)).text(),
    csv = await (await financialGet(auditor, "csv", "2024-02-01", head)).text();
  await posted(reversal(first, "2024-02-02"));
  const back = manualJournal();
  back.date = "2024-01-31";
  back.currency = "USD";
  await posted(back);
  await admin.query(
    "UPDATE organizations SET currency='USD',timezone='UTC' WHERE id=$1",
    [org],
  );
  expect(
    await (await financialGet(owner, "json", "2024-02-01", head)).text(),
  ).toBe(json);
  expect(
    await (await financialGet(auditor, "csv", "2024-02-01", head)).text(),
  ).toBe(csv);
  const before: JournalReport = await (
      await financialGet(owner, "json", "2024-02-01")
    ).json(),
    after: JournalReport = await (
      await financialGet(owner, "json", "2024-02-02")
    ).json();
  expect(
    before.trialBalance.find((c) => c.currency === "NGN")!.debitBalances,
  ).toBe("100.0000");
  expect(
    after.trialBalance.find((c) => c.currency === "NGN")!.debitBalances,
  ).toBe("0.0000");
});
it("denies worker/outsider financial reads, auditor writes and forged actor/time values against real owner rows", async () => {
  const id = await posted();
  expect((await workspace(auditor)).report.entries[0].id).toBe(id);
  for (const actor of [worker, outsider]) {
    await expect(workspace(actor)).rejects.toMatchObject({ status: 403 });
    expect(
      (
        await tenant(actor, (c) =>
          c.query(
            "SELECT id FROM financial_journal_entries WHERE organization_id=$1",
            [org],
          ),
        )
      ).rows,
    ).toEqual([]);
  }
  const p = journalInput.parse(await payload());
  for (const actor of [worker, auditor, outsider]) {
    await expect(post(actor, "finance/journal", p)).rejects.toMatchObject({
      status: 403,
    });
    await expect(direct(actor, p)).rejects.toMatchObject({ code: "42501" });
  }
  await expect(direct(owner, p, ",created_by", [worker])).rejects.toMatchObject(
    { code: "42501" },
  );
  await expect(
    direct(owner, p, ",created_at", ["2000-01-01"]),
  ).rejects.toMatchObject({ code: "42501" });
});
it("independently derives source/account/date/currency/position/receipt and refuses runtime update/delete or direct server access", async () => {
  const b = await sales(),
    p = journalInput.parse(await payload(recognize(b.saleId, "product"))),
    row = (
      await direct(
        owner,
        p,
        ",source_snapshot,lines,currency,posted_on,position,source_id,unit_id,submission",
        [
          JSON.stringify({ forged: true }),
          "[]",
          "USD",
          "2000-01-01",
          999999,
          randomUUID(),
          randomUUID(),
          "{}",
        ],
      )
    ).rows[0];
  expect(row.currency).toBe("NGN");
  expect(row.source_id).toBe(b.saleId);
  expect(row.unit_id).toBe(b.unit);
  expect(row.source_snapshot.event.id).toBe(b.saleId);
  expect(row.lines[0].amount).toBe("3.8559");
  expect(row.position).not.toBe("999999");
  expect(row.submission).toEqual(p);
  await expect(
    tenant(owner, (c) =>
      c.query(
        "UPDATE financial_journal_entries SET currency='USD' WHERE id=$1",
        [p.entryId],
      ),
    ),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    tenant(owner, (c) =>
      c.query("DELETE FROM financial_journal_entries WHERE id=$1", [p.entryId]),
    ),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    pool.query("SELECT * FROM financial_journal_entries"),
  ).rejects.toMatchObject({ code: "42501" });
});
it("enforces line shape, exact balance, reserved sales accounts, references, dates and cash evidence in direct runtime writes", async () => {
  const p = journalInput.parse(await payload());
  if (p.data.kind !== "manual") throw Error();
  for (const patch of [
    { lines: [p.data.lines[0], { ...p.data.lines[1], amount: "99.9999" }] },
    { lines: [p.data.lines[0], { ...p.data.lines[1], account: "4000" }] },
    { lines: [p.data.lines[0], { ...p.data.lines[1], account: "1000" }] },
    { lines: [{ ...p.data.lines[0], amount: "0" }, p.data.lines[1]] },
    { lines: [] },
    { date: "2099-01-01" },
    { extra: true },
  ])
    await expect(
      direct(owner, {
        ...p,
        entryId: randomUUID(),
        data: { ...p.data, ...patch },
      } as unknown as JournalInput),
    ).rejects.toMatchObject({ code: "23514" });
  await post(owner, "finance/journal", p);
  const q = await payload({ ...p.data });
  await expect(direct(owner, journalInput.parse(q))).rejects.toMatchObject({
    code: "23505",
  });
  const b = await sales(),
    cash = recognize(b.saleId, "product", true);
  if (cash.kind !== "recognize_sale") throw Error();
  await expect(
    direct(owner, {
      ...(await payload(cash)),
      data: { ...cash, cashEvidence: null },
    }),
  ).rejects.toMatchObject({ code: "23514" });
});
it("refuses earlier/repeated reversals and preserves original entries and source evidence", async () => {
  const d = manualJournal();
  d.date = "2024-02-03";
  const j = await posted(d),
    first = (await workspace()).report.entries[0];
  await expect(
    direct(owner, journalInput.parse(await payload(reversal(j, "2024-02-02")))),
  ).rejects.toMatchObject({ code: "23514" });
  await posted(reversal(j));
  await expect(
    direct(owner, journalInput.parse(await payload(reversal(j)))),
  ).rejects.toMatchObject({ code: "23505" });
  expect((await workspace()).report.entries[0]).toEqual(first);
});
it("exports genuine private source and line evidence with stable digest, formula-safe cells and no audit on reads", async () => {
  const d = manualJournal();
  d.reference = "=Synthetic book reference";
  d.description = "=Synthetic accounting memo";
  await posted(d);
  const w = await workspace(),
    r = await financialGet(
      auditor,
      "json",
      w.report.asOf,
      w.report.throughPosition,
    ),
    doc: JournalReport = await r.json();
  const { evidenceSha256, ...normalized } = doc;
  expect(
    createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
  ).toBe(evidenceSha256);
  expect(r.headers.get("cache-control")).toBe("private, no-store");
  expect(r.headers.get("x-evidence-sha256")).toBe(evidenceSha256);
  const csv = await (
    await financialGet(auditor, "csv", w.report.asOf, w.report.throughPosition)
  ).text();
  expect(csv).toContain("'=Synthetic book reference");
  expect(csv).toContain("'=Synthetic accounting memo");
  expect(csv).toContain(doc.entries[0].created_by);
  expect(csv).toContain('"Complete entry and source"');
  await expect(financialGet(owner, "json", "2099-01-01")).rejects.toMatchObject(
    { status: 400 },
  );
  await expect(
    financialGet(owner, "json", undefined, "999999999999"),
  ).rejects.toMatchObject({ status: 400 });
});
it("rolls back an entry and audit that would exceed mandatory complete-report bounds while preserving earlier-prefix export", async () => {
  const j = await posted(),
    first = await workspace(),
    before = await (
      await financialGet(
        owner,
        "json",
        first.report.asOf,
        first.report.throughPosition,
      )
    ).text();
  let bytes = 0;
  while (bytes < 1020000) {
    const head = (
      await tenant(owner, (c) =>
        c.query(
          "SELECT coalesce(max(position),0)::text AS head FROM financial_journal_entries WHERE organization_id=$1",
          [org],
        ),
      )
    ).rows[0].head;
    const data = manualJournal();
    data.description = "x".repeat(1000);
    data.reason = "x".repeat(2000);
    data.evidence = "x".repeat(2000);
    await direct(
      owner,
      journalInput.parse({
        organizationId: org,
        entryId: randomUUID(),
        expectedPosition: head,
        data,
      }),
    );
    bytes = Buffer.byteLength(await (await financialGet(owner, "json")).text());
  }
  const data = manualJournal();
  data.description = "田".repeat(1000);
  data.reason = "田".repeat(2000);
  data.evidence = "田".repeat(2000);
  const p = await payload(data);
  await expect(post(owner, "finance/journal", p)).rejects.toMatchObject({
    status: 422,
  });
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
    await (
      await financialGet(
        owner,
        "json",
        first.report.asOf,
        first.report.throughPosition,
      )
    ).text(),
  ).toBe(before);
  expect(before).toContain(j);
});
it("keeps measured product loss separate from financial recognition until explicit valuation entries are reviewed", async () => {
  const b = await sales();
  await posted(recognize(b.saleId, "product"));
  const before = (await workspace()).report.trialBalance;
  await saveProduct(b.unit, loss(b.lot, "1"));
  expect((await workspace()).report.trialBalance).toEqual(before);
  expect((await productReport(b.unit)).results.lots[0].balanceKg).toBe(
    "9.876544",
  );
});
it("serializes financial recognition against operational source voids for both API and direct-runtime writers", async () => {
  const b = await sales(),
    j = await payload(recognize(b.saleId, "product")),
    v = await productPayload(b.unit, voided(b.saleId));
  const race = await Promise.allSettled([
    post(owner, "finance/journal", j),
    post(owner, "broilers/products", v),
  ]);
  expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const booked = (
    await tenant(owner, (c) =>
      c.query("SELECT financial_sale_is_booked($1,'product',$2) AS booked", [
        org,
        b.saleId,
      ]),
    )
  ).rows[0].booked;
  expect(
    (await productReport(b.unit)).events.some((e) => e.void_of_id === b.saleId),
  ).toBe(!booked);
  const other = await sales(),
    p = journalInput.parse(await payload(recognize(other.saleId, "product"))),
    q = await productPayload(other.unit, voided(other.saleId));
  const directRace = await Promise.allSettled([
    direct(owner, p),
    tenant(owner, (c) =>
      c.query(
        "INSERT INTO broiler_product_events(id,organization_id,unit_id,lot_id,recorded_on,expected_position,expected_source_position,expected_daily_id,input) VALUES($1,$2,$3,$1,$4,$5,$6,$7,$8)",
        [
          q.eventId,
          org,
          other.unit,
          q.date,
          q.expectedPosition,
          q.expectedSourcePosition,
          q.expectedDailyId,
          JSON.stringify(q.data),
        ],
      ),
    ),
  ]);
  expect(directRace.filter((r) => r.status === "fulfilled")).toHaveLength(1);
});
it("binds financial validation and commit-time source consistency to real application tables under temporary schema shadowing", async () => {
  const b = await sales(),
    p = journalInput.parse(await payload(recognize(b.saleId, "product")));
  const row = await tenant(owner, async (c) => {
    await c.query(
      "CREATE TEMP TABLE financial_journal_entries (LIKE public.financial_journal_entries) ON COMMIT DROP",
    );
    await c.query(
      "CREATE TEMP TABLE broiler_product_events (LIKE public.broiler_product_events) ON COMMIT DROP",
    );
    await c.query("SET LOCAL search_path=pg_temp,public");
    return (
      await c.query(
        "INSERT INTO public.financial_journal_entries(id,organization_id,expected_position,input) VALUES($1,$2,$3,$4) RETURNING source_snapshot,lines",
        [p.entryId, org, p.expectedPosition, JSON.stringify(p.data)],
      )
    ).rows[0];
  });
  expect(row.source_snapshot.event.id).toBe(b.saleId);
  expect(row.lines[0].amount).toBe("3.8559");
});
