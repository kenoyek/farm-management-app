import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { admin } from "./admin-db";
import { tenant, pool } from "../src/lib/db";
import { productionApi } from "../src/lib/production-api";
import type { EggSnapshot } from "../src/lib/egg-inventory";
let owner: string,
  inventory: string,
  worker: string,
  auditor: string,
  outsider: string,
  org: string,
  foreignOrg: string,
  farm: string,
  otherFarm: string,
  unit: string,
  broiler: string,
  store: string,
  foreignStore: string,
  mainBatch: string,
  mainReceipt: string,
  saleEvent: string,
  openingBatch: string;
async function post(actor: string, path: string, data: unknown) {
  return (await productionApi(
    new NextRequest("http://localhost/api/" + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    }),
    { id: actor },
    path,
  ))!;
}
async function snapshot(
  actor = owner,
  organizationId = org,
): Promise<EggSnapshot> {
  return (await productionApi(
    new NextRequest(
      "http://localhost/api/eggs?organizationId=" + organizationId,
    ),
    { id: actor },
    "eggs",
  ))!.json();
}
function common(batchId = mainBatch) {
  return {
    organizationId: org,
    eventId: randomUUID(),
    batchId,
    date: "2024-02-02",
    reason: "Synthetic dated observation reviewed",
    evidence: "Synthetic egg register reference",
  };
}
async function event(
  values: Record<string, unknown>,
  actor = owner,
  batchId = mainBatch,
) {
  const p = { ...common(batchId), ...values };
  return (await post(actor, "eggs/events", p)).json();
}
async function opening(quantity = 10, values: Record<string, unknown> = {}) {
  const batchId = randomUUID();
  const openingStore = randomUUID();
  await post(inventory, "eggs/stores", {
    organizationId: org,
    storeId: openingStore,
    farmId: farm,
    name: "Synthetic baseline " + openingStore.slice(0, 8),
  });
  await event(
    {
      kind: "opening",
      storeId: openingStore,
      batchName: "=Synthetic opening eggs",
      grade: "ungraded",
      quantity,
      ...values,
    },
    inventory,
    batchId,
  );
  return batchId;
}
async function receipt(
  date = "2024-02-01",
  values: Record<string, unknown> = {},
) {
  const s = await snapshot(),
    c = s.collections.find(
      (c) => c.recorded_on === date && c.unit_id === unit,
    )!;
  const b = s.batches.find(
      (b) => b.unit_id === unit && b.collected_on === date,
    ),
    r = s.summary.reconciliation.find(
      (r) => r.unitId === unit && r.date === date,
    )!;
  return {
    ...common(b?.id ?? randomUUID()),
    kind: "receipt",
    storeId: store,
    batchName: b?.name ?? "=Synthetic collection " + date,
    unitId: unit,
    collectionDate: date,
    expectedRecordId: c.id,
    expectedAdjustmentId: c.adjustment_id,
    previousId: r.previousId,
    ...values,
  };
}
async function correct(date: string, eggs: number, cracked = 2) {
  const s = await snapshot(),
    c = s.collections.find(
      (c) => c.unit_id === unit && c.recorded_on === date,
    )!;
  const r = await eventRecovery({
    organizationId: org,
    eventId: randomUUID(),
    unitId: unit,
    kind: "daily",
    date,
    previousId: c.adjustment_id,
    baseRecordId: c.base_record_id,
    mortality: 0,
    eggs,
    cracked,
    feedKg: "1",
    notes: "Synthetic reviewed collection",
    reason: "Synthetic source correction reviewed",
    evidence: "Synthetic corrected collection sheet",
  });
  return r.id;
}
async function eventRecovery(data: unknown) {
  return (await post(owner, "layers/recovery", data)).json();
}
beforeAll(async () => {
  const users = [];
  for (let i = 0; i < 5; i++)
    users.push(
      (
        await admin.query(
          "INSERT INTO users(email,password_hash) VALUES($1,'fixture') RETURNING id",
          [randomUUID() + "@test.invalid"],
        )
      ).rows[0].id,
    );
  [owner, inventory, worker, auditor, outsider] = users;
  org = (
    await tenant(owner, (c) =>
      c.query("SELECT create_organization('Synthetic egg inventory') AS id"),
    )
  ).rows[0].id;
  foreignOrg = (
    await tenant(outsider, (c) =>
      c.query("SELECT create_organization('Foreign eggs') AS id"),
    )
  ).rows[0].id;
  await admin.query(
    "INSERT INTO memberships VALUES($1,$2,'inventory'),($1,$3,'worker'),($1,$4,'auditor')",
    [org, inventory, worker, auditor],
  );
  farm = (
    await tenant(owner, (c) =>
      c.query(
        "INSERT INTO farms(organization_id,name,kind) VALUES($1,'Synthetic egg farm','layers') RETURNING id",
        [org],
      ),
    )
  ).rows[0].id;
  otherFarm = (
    await tenant(owner, (c) =>
      c.query(
        "INSERT INTO farms(organization_id,name,kind) VALUES($1,'Synthetic other farm','layers') RETURNING id",
        [org],
      ),
    )
  ).rows[0].id;
  const foreignFarm = (
    await tenant(outsider, (c) =>
      c.query(
        "INSERT INTO farms(organization_id,name,kind) VALUES($1,'Foreign egg farm','layers') RETURNING id",
        [foreignOrg],
      ),
    )
  ).rows[0].id;
  for (const kind of ["layers", "broilers"]) {
    const r = await (
      await post(owner, "units", {
        organizationId: org,
        farmId: farm,
        name: "Synthetic egg " + kind,
        kind,
        stockedOn: "2024-02-01",
        openingCount: 100,
        initialWeightG: 1000,
      })
    ).json();
    if (kind === "layers") unit = r.id;
    else broiler = r.id;
  }
  for (const [date, eggs, cracked] of [
    ["2024-02-01", 100, 2],
    ["2024-02-02", 0, 0],
    ["2024-02-03", 80, 1],
    ["2024-02-04", 50, 2],
  ] as const)
    await post(worker, "records", {
      organizationId: org,
      unitId: unit,
      recordedOn: date,
      mortality: 0,
      eggs,
      cracked,
      feedKg: 1,
      averageWeightG: null,
      sampleSize: null,
      waterQuality: null,
      notes: "Synthetic original observation",
    });
  store = randomUUID();
  await post(inventory, "eggs/stores", {
    organizationId: org,
    storeId: store,
    farmId: farm,
    name: "=Synthetic egg store",
  });
  foreignStore = randomUUID();
  await post(outsider, "eggs/stores", {
    organizationId: foreignOrg,
    storeId: foreignStore,
    farmId: foreignFarm,
    name: "Foreign egg store",
  });
});
afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])", [
    [org, foreignOrg],
  ]);
  await admin.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
    [owner, inventory, worker, auditor, outsider],
  ]);
  await pool.end();
  await admin.end();
});
it("reads real owner/auditor/inventory rows and enforces outsider and worker write isolation", async () => {
  expect((await snapshot(auditor)).stores).toHaveLength(1);
  expect((await snapshot(inventory)).collections).toHaveLength(4);
  await expect(snapshot(outsider)).rejects.toMatchObject({ status: 404 });
  await expect(snapshot(owner, foreignOrg)).rejects.toMatchObject({
    status: 404,
  });
  for (const actor of [worker, auditor])
    await expect(
      post(actor, "eggs/stores", {
        organizationId: org,
        storeId: randomUUID(),
        farmId: farm,
        name: "Forbidden store",
      }),
    ).rejects.toMatchObject({ status: 403 });
  expect(
    (
      await tenant(outsider, (c) =>
        c.query("SELECT * FROM egg_stores WHERE organization_id=$1", [org]),
      )
    ).rowCount,
  ).toBe(0);
});
it("recognizes exact store retries and refuses forged tenant parents", async () => {
  const p = {
    organizationId: org,
    storeId: store,
    farmId: farm,
    name: "=Synthetic egg store",
  };
  expect((await post(inventory, "eggs/stores", p)).status).toBe(200);
  await expect(
    post(owner, "eggs/stores", { ...p, name: "Changed store" }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    post(owner, "eggs/stores", {
      organizationId: org,
      storeId: randomUUID(),
      farmId: randomUUID(),
      name: "Forged store",
    }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(opening(1, { storeId: foreignStore })).rejects.toMatchObject({
    status: 404,
  });
  const otherStore = randomUUID();
  await post(inventory, "eggs/stores", {
    organizationId: org,
    storeId: otherStore,
    farmId: otherFarm,
    name: "Synthetic other farm store",
  });
  await expect(
    post(
      owner,
      "eggs/events",
      await receipt("2024-02-01", { storeId: otherStore }),
    ),
  ).rejects.toMatchObject({ status: 400 });
});
it("receives only current saleable actuals, snapshots exact source and distinguishes unreceived from acknowledged zero", async () => {
  const s = await snapshot();
  expect(
    s.summary.reconciliation.find((r) => r.date === "2024-02-02"),
  ).toMatchObject({ received: null, status: "not-received", difference: 0 });
  const p = await receipt();
  mainBatch = p.batchId;
  mainReceipt = p.eventId;
  await post(inventory, "eggs/events", p);
  const z = await receipt("2024-02-02");
  await post(inventory, "eggs/events", z);
  const after = await snapshot(auditor);
  expect(after.summary.totalEggs).toBe(98);
  expect(after.events.find((e) => e.id === mainReceipt)).toMatchObject({
    quantity: 98,
    source_quantity: 98,
    source_snapshot: { eggs: 100, cracked: 2, id: p.expectedRecordId },
  });
  expect(
    after.summary.reconciliation.find((r) => r.date === "2024-02-02"),
  ).toMatchObject({ status: "reconciled", received: 0, difference: 0 });
  await expect(
    post(owner, "eggs/events", await receipt("2024-02-02")),
  ).rejects.toMatchObject({ status: 409 });
});
it("retries an immutable receipt without duplicate stock or audit and refuses changed receipt content", async () => {
  const saved = (await snapshot()).events.find((e) => e.id === mainReceipt)!;
  const p = (saved as unknown as { submission: unknown }).submission;
  const before = (
    await tenant(owner, (c) =>
      c.query("SELECT count(*) FROM audit_logs WHERE organization_id=$1", [
        org,
      ]),
    )
  ).rows[0].count;
  expect((await post(owner, "eggs/events", p)).status).toBe(200);
  expect((await snapshot()).summary.totalEggs).toBe(98);
  expect(
    (
      await tenant(owner, (c) =>
        c.query("SELECT count(*) FROM audit_logs WHERE organization_id=$1", [
          org,
        ]),
      )
    ).rows[0].count,
  ).toBe(before);
  await expect(
    post(owner, "eggs/events", {
      ...(p as object),
      evidence: "Different evidence",
    }),
  ).rejects.toMatchObject({ status: 409 });
});
it("prevents concurrent double receipts and rolls back batches whose first receipt fails", async () => {
  const p = await receipt("2024-02-03", { date: "2024-02-03" }),
    q = { ...p, eventId: randomUUID(), batchId: randomUUID() };
  const results = await Promise.allSettled([
    post(owner, "eggs/events", p),
    post(owner, "eggs/events", q),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { status: 409 },
  });
  const bad = await receipt("2024-02-04", { date: "2024-01-31" });
  await expect(post(owner, "eggs/events", bad)).rejects.toMatchObject({
    status: 400,
  });
  expect(
    (
      await tenant(owner, (c) =>
        c.query("SELECT id FROM egg_batches WHERE id=$1", [bad.batchId]),
      )
    ).rowCount,
  ).toBe(0);
});
it("grades by conserving whole eggs and refuses grade overdrafts", async () => {
  await event(
    { kind: "grade", grade: "ungraded", targetGrade: "large", quantity: 80 },
    inventory,
  );
  const s = await snapshot();
  expect(
    s.summary.balances.find(
      (b) => b.batchId === mainBatch && b.grade === "ungraded",
    )?.eggs,
  ).toBe(18);
  expect(
    s.summary.balances.find(
      (b) => b.batchId === mainBatch && b.grade === "large",
    )?.eggs,
  ).toBe(80);
  await expect(
    event({
      kind: "grade",
      grade: "ungraded",
      targetGrade: "small",
      quantity: 19,
    }),
  ).rejects.toMatchObject({ status: 400 });
});
it("records one exact tray-and-loose sale with historical prices and a unique business reference", async () => {
  saleEvent = (
    await event(
      {
        kind: "sale",
        grade: "large",
        currency: "NGN",
        customer: "=Synthetic buyer",
        reference: "SYNTHETIC-TRAY-001",
        pricing: {
          mode: "tray-and-loose",
          trays: 2,
          looseEggs: 2,
          traySize: 30,
          pricePerTray: "4500.125",
          pricePerEgg: "155.25",
        },
      },
      inventory,
    )
  ).id;
  const s = await snapshot();
  expect(s.events.find((e) => e.id === saleEvent)).toMatchObject({
    quantity: -62,
    amount: "9310.7500",
    currency: "NGN",
    pricing: { pricePerTray: "4500.1250", pricePerEgg: "155.2500" },
  });
  expect(s.summary.sales).toEqual([
    { currency: "NGN", netEggs: 62, netValue: "9310.7500" },
  ]);
  await expect(
    event({
      kind: "sale",
      grade: "large",
      currency: "NGN",
      customer: "Synthetic duplicate",
      reference: "SYNTHETIC-TRAY-001",
      pricing: { mode: "per-egg", eggs: 1, pricePerEgg: "1" },
    }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    event({
      kind: "sale",
      grade: "large",
      currency: "NGN",
      customer: "Synthetic exact duplicate",
      reference: "SYNTHETIC-TRAY-001",
      pricing: {
        mode: "tray-and-loose",
        trays: 2,
        looseEggs: 2,
        traySize: 30,
        pricePerTray: "4500.125",
        pricePerEgg: "155.25",
      },
    }),
  ).rejects.toMatchObject({ status: 409 });
});
it("serializes competing sales and rejects negative stock without losing the losing audit transaction", async () => {
  openingBatch = await opening(10);
  const sell = (ref: string) =>
    event(
      {
        kind: "sale",
        grade: "ungraded",
        currency: "NGN",
        customer: "Synthetic concurrent customer",
        reference: ref,
        pricing: { mode: "per-egg", eggs: 8, pricePerEgg: "0.1234" },
      },
      inventory,
      openingBatch,
    );
  const before = (await snapshot()).events.length;
  const r = await Promise.allSettled([
    sell("SYNTHETIC-RACE-A"),
    sell("SYNTHETIC-RACE-B"),
  ]);
  expect(r.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(r.find((r) => r.status === "rejected")).toMatchObject({
    reason: { status: 400 },
  });
  const s = await snapshot();
  expect(s.events).toHaveLength(before + 1);
  expect(s.summary.balances.find((b) => b.batchId === openingBatch)?.eggs).toBe(
    2,
  );
  const positions = s.events.map((e) => BigInt(e.position));
  expect(positions.every((p, i) => i === 0 || p > positions[i - 1])).toBe(true);
});
it("requires manager review and a current ledger position for physical counts", async () => {
  const s = await snapshot(),
    position = s.summary.lastPositions[openingBatch];
  const p = {
    kind: "count",
    grade: "ungraded",
    counted: 3,
    expectedPosition: position,
  };
  await expect(event(p, inventory, openingBatch)).rejects.toMatchObject({
    status: 403,
  });
  await event(p, owner, openingBatch);
  await expect(
    event({ ...p, counted: 4 }, owner, openingBatch),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (await snapshot()).summary.balances.find((b) => b.batchId === openingBatch)
      ?.eggs,
  ).toBe(3);
});
it("reverses a full sale in its original currency and preserves all historical source and price evidence", async () => {
  const before = (await snapshot()).events.find((e) => e.id === saleEvent);
  await tenant(owner, (c) =>
    c.query("UPDATE organizations SET currency='USD' WHERE id=$1", [org]),
  );
  await event({ kind: "reversal", reversesId: saleEvent });
  const s = await snapshot();
  expect(s.events.find((e) => e.id === saleEvent)).toEqual(before);
  expect(s.events.find((e) => e.reverses_id === saleEvent)).toMatchObject({
    quantity: 62,
    amount: "-9310.7500",
    currency: "NGN",
    pricing: before?.pricing,
  });
  await expect(
    event({ kind: "reversal", reversesId: saleEvent }),
  ).rejects.toMatchObject({ status: 409 });
  await event({
    kind: "sale",
    grade: "large",
    currency: "USD",
    customer: "Synthetic USD buyer",
    reference: "SYNTHETIC-USD-001",
    pricing: { mode: "per-egg", eggs: 1, pricePerEgg: "0.1234" },
  });
  expect(
    (await snapshot()).summary.sales.find((s) => s.currency === "USD"),
  ).toEqual({ currency: "USD", netEggs: 1, netValue: "0.1234" });
  await expect(
    event({
      kind: "sale",
      grade: "large",
      currency: "NGN",
      customer: "Synthetic stale currency",
      reference: "SYNTHETIC-STALE-CCY",
      pricing: { mode: "per-egg", eggs: 1, pricePerEgg: "1" },
    }),
  ).rejects.toMatchObject({ status: 409 });
  await tenant(owner, (c) =>
    c.query("UPDATE organizations SET currency='NGN' WHERE id=$1", [org]),
  );
});
it("does not silently apply production corrections and refuses removing stock already graded or sold", async () => {
  const p = await receipt("2024-02-04", { date: "2024-02-04" });
  await post(owner, "eggs/events", p);
  const b = p.batchId;
  await event(
    {
      kind: "grade",
      date: "2024-02-04",
      grade: "ungraded",
      targetGrade: "medium",
      quantity: 40,
    },
    inventory,
    b,
  );
  const before = await snapshot();
  await correct("2024-02-04", 40);
  const changed = await snapshot();
  expect(changed.events).toEqual(before.events);
  expect(
    changed.summary.reconciliation.find((r) => r.date === "2024-02-04"),
  ).toMatchObject({
    status: "source-changed",
    difference: -10,
    received: 48,
    saleable: 38,
  });
  await expect(
    post(
      owner,
      "eggs/events",
      await receipt("2024-02-04", { date: "2024-02-04" }),
    ),
  ).rejects.toMatchObject({ status: 400 });
  const g = (await snapshot()).events.find(
    (e) => e.batch_id === b && e.kind === "grade",
  )!;
  await event(
    { kind: "reversal", date: "2024-02-04", reversesId: g.id },
    owner,
    b,
  );
  await post(
    owner,
    "eggs/events",
    await receipt("2024-02-04", { date: "2024-02-04" }),
  );
  const after = await snapshot();
  expect(
    after.summary.balances.find(
      (r) => r.batchId === b && r.grade === "ungraded",
    )?.eggs,
  ).toBe(38);
  expect(
    after.events.find((e) => e.id === p.eventId)?.source_snapshot?.eggs,
  ).toBe(50);
});
it("recognizes changed source IDs at zero quantity difference and rejects stale evidence/receipt predecessors", async () => {
  const p = await receipt("2024-02-04", { date: "2024-02-04" });
  await correct("2024-02-04", 40);
  const changed = await snapshot();
  expect(
    changed.summary.reconciliation.find((r) => r.date === "2024-02-04"),
  ).toMatchObject({ status: "source-changed", difference: 0 });
  await expect(post(owner, "eggs/events", p)).rejects.toMatchObject({
    status: 409,
  });
  const current = await receipt("2024-02-04", { date: "2024-02-04" });
  await post(owner, "eggs/events", current);
  expect(
    (await snapshot()).events.find((e) => e.id === current.eventId),
  ).toMatchObject({ quantity: 0, source_quantity: 38 });
});
it("rejects future/backdated movements, non-layer/missing collections and receipt reversals", async () => {
  await expect(
    event({ kind: "loss", date: "2099-01-01", grade: "large", quantity: 1 }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    event({ kind: "loss", date: "2024-02-01", grade: "large", quantity: 1 }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    post(
      owner,
      "eggs/events",
      await receipt("2024-02-01", { unitId: broiler, batchId: randomUUID() }),
    ),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    post(
      owner,
      "eggs/events",
      await receipt("2024-02-01", {
        collectionDate: "2024-02-05",
        batchId: randomUUID(),
      }),
    ),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    event({ kind: "reversal", reversesId: mainReceipt }),
  ).rejects.toMatchObject({ status: 400 });
});
it("enforces immutability, reviewer identity, nonnegative stock and exact sale amounts through the direct runtime role", async () => {
  const s = await snapshot();
  expect(s.events.length).toBeGreaterThan(0);
  for (const sql of [
    "UPDATE egg_events SET quantity=100 WHERE batch_id=$1",
    "DELETE FROM egg_events WHERE batch_id=$1",
    "UPDATE egg_batches SET name='changed' WHERE id=$1",
  ])
    await expect(
      tenant(owner, (c) => c.query(sql, [mainBatch])),
    ).rejects.toMatchObject({ code: "42501" });
  expect(
    (
      await tenant(outsider, (c) =>
        c.query("SELECT * FROM egg_events WHERE organization_id=$1", [org]),
      )
    ).rowCount,
  ).toBe(0);
  await expect(
    tenant(worker, (c) =>
      c.query(
        `INSERT INTO egg_events(id,organization_id,batch_id,kind,occurred_on,grade,quantity,reason,evidence,submission) VALUES($1,$2,$3,'loss','2024-02-02','ungraded',-1,'Synthetic worker issue','Synthetic sheet','{}')`,
        [randomUUID(), org, mainBatch],
      ),
    ),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    tenant(owner, (c) =>
      c.query(
        `INSERT INTO egg_events(id,organization_id,batch_id,kind,occurred_on,grade,quantity,reason,evidence,submission,created_by) VALUES($1,$2,$3,'loss','2024-02-02','ungraded',-1,'Synthetic forged actor','Synthetic sheet','{}',$4)`,
        [randomUUID(), org, mainBatch, outsider],
      ),
    ),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    tenant(owner, (c) =>
      c.query(
        `INSERT INTO egg_events(id,organization_id,batch_id,kind,occurred_on,grade,quantity,reason,evidence,submission,pricing,amount,currency,customer,reference) VALUES($1,$2,$3,'sale','2024-02-02','large',-1,'Synthetic incorrect price','Synthetic sheet','{}','{"mode":"per-egg","eggs":1,"pricePerEgg":"100.0000"}',1,'NGN','Synthetic buyer','FORGED-PRICE')`,
        [randomUUID(), org, mainBatch],
      ),
    ),
  ).rejects.toMatchObject({ code: "23514" });
});
it("exports private current evidence with matching digests and spreadsheet-safe source text without writes", async () => {
  const before = await snapshot(),
    q = new URLSearchParams({ organizationId: org, format: "csv" });
  const r = (await productionApi(
    new NextRequest("http://localhost/api/eggs?" + q),
    { id: auditor },
    "eggs",
  ))!;
  expect(r.headers.get("cache-control")).toBe("private, no-store");
  expect(r.headers.get("x-egg-snapshot-sha256")).toBe(before.evidenceSha256);
  const text = await r.text();
  expect(text).toContain("'=Synthetic buyer");
  expect(text).toContain("9310.7500");
  expect(text).toContain(mainReceipt);
  expect(text).toContain("Receipt source evidence");
  expect(text).toContain(
    String(
      before.events.find((e) => e.id === mainReceipt)?.source_snapshot?.id,
    ),
  );
  expect((await snapshot()).events).toEqual(before.events);
  await expect(
    tenant(owner, (c) =>
      c.query(
        `INSERT INTO egg_batches(id,organization_id,store_id,name,source_kind,received_on) VALUES($1,$2,$3,'Empty unconfirmed batch','opening','2024-02-01')`,
        [randomUUID(), org, store],
      ),
    ),
  ).rejects.toMatchObject({ code: "23514" });
});

it("anchors opening stock before operations and prevents re-receiving older collections", async () => {
  const s = randomUUID();
  await post(inventory, "eggs/stores", {
    organizationId: org,
    storeId: s,
    farmId: farm,
    name: "Synthetic baseline cutoff",
  });
  await event(
    {
      kind: "opening",
      storeId: s,
      batchName: "Synthetic start count",
      date: "2024-03-01",
      grade: "ungraded",
      quantity: 20,
    },
    owner,
    randomUUID(),
  );
  await post(worker, "records", {
    organizationId: org,
    unitId: unit,
    recordedOn: "2024-02-05",
    mortality: 0,
    eggs: 10,
    cracked: 1,
    feedKg: 1,
    averageWeightG: null,
    sampleSize: null,
    waterQuality: null,
    notes: "Synthetic historical collection",
  });
  const before = await snapshot();
  await expect(
    post(
      owner,
      "eggs/events",
      await receipt("2024-02-05", {
        batchId: randomUUID(),
        storeId: s,
        date: "2024-03-01",
      }),
    ),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    event(
      {
        kind: "opening",
        storeId: s,
        batchName: "Synthetic different date",
        date: "2024-03-02",
        grade: "ungraded",
        quantity: 1,
      },
      owner,
      randomUUID(),
    ),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    event(
      {
        kind: "opening",
        storeId: store,
        batchName: "Synthetic late opening",
        grade: "ungraded",
        quantity: 1,
      },
      owner,
      randomUUID(),
    ),
  ).rejects.toMatchObject({ status: 400 });
  expect((await snapshot()).events).toEqual(before.events);
});
