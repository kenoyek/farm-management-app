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
  root: string,
  store: string,
  dest: string,
  third: string,
  foreignStore: string,
  transferId: string,
  child: string,
  saleId: string,
  r1: string,
  r2: string,
  originalSource: unknown;
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
async function snap(actor = owner): Promise<EggSnapshot> {
  return (await productionApi(
    new NextRequest("http://localhost/api/eggs?organizationId=" + org),
    { id: actor },
    "eggs",
  ))!.json();
}
const base = (batchId = root) => ({
  organizationId: org,
  eventId: randomUUID(),
  batchId,
  date: "2024-02-02",
  reason: "Synthetic advanced stock review",
  evidence: "Synthetic dated physical register",
});
const transfer = (qty = 10, values: Record<string, unknown> = {}) => ({
  ...base(),
  kind: "transfer",
  grade: "ungraded",
  quantity: qty,
  destinationStoreId: dest,
  destinationBatchId: randomUUID(),
  destinationBatchName: "=Synthetic transferred eggs",
  ...values,
});
async function event(
  p: Record<string, unknown>,
  actor = owner,
  batchId = root,
) {
  return (await post(actor, "eggs/events", { ...base(batchId), ...p })).json();
}
async function ret(sale = saleId, values: Record<string, unknown> = {}) {
  const s = await snap(),
    r = s.summary.saleReturns.find((r) => r.saleId === sale)!;
  return {
    ...base(r.batchId),
    kind: "return",
    saleId: sale,
    trayEggs: 1,
    looseEggs: 0,
    restockEggs: 1,
    reference: "SYNTHETIC-RETURN-" + randomUUID(),
    expectedReturnPosition: r.expectedPosition,
    ...values,
  };
}
const bal = (s: EggSnapshot, b: string) =>
  s.summary.balances
    .filter((x) => x.batchId === b)
    .reduce((n, r) => n + r.eggs, 0);
beforeAll(async () => {
  const ids = [];
  for (let i = 0; i < 5; i++)
    ids.push(
      (
        await admin.query(
          "INSERT INTO users(email,password_hash) VALUES($1,'fixture') RETURNING id",
          [randomUUID() + "@test.invalid"],
        )
      ).rows[0].id,
    );
  [owner, inventory, worker, auditor, outsider] = ids;
  org = (
    await tenant(owner, (c) =>
      c.query(
        "SELECT create_organization('Synthetic transfers and returns') AS id",
      ),
    )
  ).rows[0].id;
  foreignOrg = (
    await tenant(outsider, (c) =>
      c.query("SELECT create_organization('Foreign advanced stock') AS id"),
    )
  ).rows[0].id;
  await admin.query(
    "INSERT INTO memberships VALUES($1,$2,'inventory'),($1,$3,'worker'),($1,$4,'auditor')",
    [org, inventory, worker, auditor],
  );
  const farms = [];
  for (const name of ["Synthetic origin farm", "Synthetic destination farm"])
    farms.push(
      (
        await tenant(owner, (c) =>
          c.query(
            "INSERT INTO farms(organization_id,name,kind) VALUES($1,$2,'layers') RETURNING id",
            [org, name],
          ),
        )
      ).rows[0].id,
    );
  const ff = (
    await tenant(outsider, (c) =>
      c.query(
        "INSERT INTO farms(organization_id,name,kind) VALUES($1,'Foreign store farm','layers') RETURNING id",
        [foreignOrg],
      ),
    )
  ).rows[0].id;
  [store, dest, third, foreignStore] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  for (const [i, id] of [store, dest, third].entries())
    await post(inventory, "eggs/stores", {
      organizationId: org,
      storeId: id,
      farmId: farms[i === 1 ? 1 : 0],
      name: "Synthetic store " + i,
    });
  await post(outsider, "eggs/stores", {
    organizationId: foreignOrg,
    storeId: foreignStore,
    farmId: ff,
    name: "Foreign store",
  });
  const unit = (
    await (
      await post(owner, "units", {
        organizationId: org,
        farmId: farms[0],
        name: "Synthetic origin layers",
        kind: "layers",
        stockedOn: "2024-02-01",
        openingCount: 100,
        initialWeightG: 1000,
      })
    ).json()
  ).id;
  const rec = (
    await (
      await post(worker, "records", {
        organizationId: org,
        unitId: unit,
        recordedOn: "2024-02-01",
        mortality: 0,
        eggs: 100,
        cracked: 2,
        feedKg: 1,
        averageWeightG: null,
        sampleSize: null,
        waterQuality: null,
        notes: "Original synthetic collection",
      })
    ).json()
  ).id;
  root = randomUUID();
  await event({
    kind: "receipt",
    storeId: store,
    batchName: "Synthetic source eggs",
    unitId: unit,
    collectionDate: "2024-02-01",
    expectedRecordId: rec,
    expectedAdjustmentId: null,
    previousId: null,
  });
  originalSource = (await snap()).events[0].source_snapshot;
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
it("posts one atomic paired transfer across farms with exact immutable batch ancestry and owner-visible legs", async () => {
  const p = transfer();
  child = p.destinationBatchId;
  transferId = p.eventId;
  await post(inventory, "eggs/events", p);
  const s = await snap(auditor);
  expect(s.summary.totalEggs).toBe(98);
  expect([bal(s, root), bal(s, child)]).toEqual([88, 10]);
  expect(s.batches.find((b) => b.id === child)).toMatchObject({
    source_kind: "transfer",
    parent_batch_id: root,
    store_id: dest,
    unit_id: null,
  });
  expect(s.events[0].source_snapshot).toEqual(originalSource);
  const legs = await tenant(owner, (c) =>
    c.query("SELECT batch_id,eggs FROM egg_movements WHERE event_id=$1", [
      transferId,
    ]),
  );
  expect(legs.rows).toHaveLength(2);
  expect(legs.rows.reduce((n, r) => n + r.eggs, 0)).toBe(0);
  expect(s.summary.lastPositions[child]).toBe(s.events.at(-1)?.position);
});
it("retries the same transfer without extra batches, stock or audit and denies bad stores/roles", async () => {
  const before = await snap(),
    e = before.events.find((e) => e.id === transferId) as unknown as {
      submission: unknown;
    };
  const count = (
    await tenant(owner, (c) =>
      c.query("SELECT count(*) FROM audit_logs WHERE organization_id=$1", [
        org,
      ]),
    )
  ).rows[0].count;
  expect((await post(inventory, "eggs/events", e.submission)).status).toBe(200);
  expect((await snap()).batches).toEqual(before.batches);
  expect(
    (
      await tenant(owner, (c) =>
        c.query("SELECT count(*) FROM audit_logs WHERE organization_id=$1", [
          org,
        ]),
      )
    ).rows[0].count,
  ).toBe(count);
  for (const actor of [worker, auditor, outsider])
    await expect(post(actor, "eggs/events", transfer(1))).rejects.toMatchObject(
      { status: 403 },
    );
  await expect(
    post(
      owner,
      "eggs/events",
      transfer(1, { destinationStoreId: foreignStore }),
    ),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    post(owner, "eggs/events", transfer(1, { destinationStoreId: store })),
  ).rejects.toMatchObject({ status: 400 });
  expect(
    (
      await tenant(outsider, (c) =>
        c.query("SELECT * FROM egg_movements WHERE event_id=$1", [transferId]),
      )
    ).rowCount,
  ).toBe(0);
});
it("serializes competing transfers and rolls back the losing destination batch", async () => {
  const p = transfer(60),
    q = transfer(60),
    s = await snap();
  const results = await Promise.allSettled([
    post(inventory, "eggs/events", p),
    post(inventory, "eggs/events", q),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { status: 400 },
  });
  const after = await snap();
  expect(after.batches.length).toBe(s.batches.length + 1);
  expect(after.summary.totalEggs).toBe(98);
  expect(bal(after, root)).toBe(28);
});
it("protects transferred stock already sold and reverses both stores only after the complete stock is available", async () => {
  const sold = (
    await event(
      {
        kind: "sale",
        grade: "ungraded",
        currency: "NGN",
        customer: "Synthetic destination buyer",
        reference: "DEST-SALE",
        pricing: { mode: "per-egg", eggs: 3, pricePerEgg: "2" },
      },
      inventory,
      child,
    )
  ).id;
  await expect(
    event({ kind: "reversal", reversesId: transferId }),
  ).rejects.toMatchObject({ status: 400 });
  expect(bal(await snap(), child)).toBe(7);
  await event({ kind: "reversal", reversesId: sold }, owner, child);
  await event({ kind: "reversal", reversesId: transferId });
  const s = await snap();
  expect(bal(s, child)).toBe(0);
  expect(bal(s, root)).toBe(38);
  expect(s.summary.totalEggs).toBe(98);
  await expect(
    event({ kind: "reversal", reversesId: transferId }),
  ).rejects.toMatchObject({ status: 409 });
});
it("keeps multi-hop lineage and rejects orphan incoming batches and late opening stock", async () => {
  const p = transfer(4);
  await post(inventory, "eggs/events", p);
  const q = transfer(3, {
    batchId: p.destinationBatchId,
    destinationStoreId: third,
  });
  await post(inventory, "eggs/events", q);
  const s = await snap();
  expect(
    s.batches.find((b) => b.id === q.destinationBatchId)?.parent_batch_id,
  ).toBe(p.destinationBatchId);
  expect(bal(s, q.destinationBatchId)).toBe(3);
  await event(
    { kind: "reversal", reversesId: q.eventId },
    owner,
    p.destinationBatchId,
  );
  await event({ kind: "reversal", reversesId: p.eventId });
  await expect(
    tenant(owner, (c) =>
      c.query(
        `INSERT INTO egg_batches(id,organization_id,store_id,name,source_kind,parent_batch_id,received_on) VALUES($1,$2,$3,'Orphan transfer','transfer',$4,'2024-02-02')`,
        [randomUUID(), org, dest, root],
      ),
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    event(
      {
        kind: "opening",
        storeId: dest,
        batchName: "Late opening",
        grade: "ungraded",
        quantity: 1,
      },
      owner,
      randomUUID(),
    ),
  ).rejects.toMatchObject({ status: 400 });
});
it("uses original tray prices and currency for a partial return with explicit non-saleable goods", async () => {
  saleId = (
    await event(
      {
        kind: "sale",
        grade: "ungraded",
        currency: "NGN",
        customer: "=Synthetic partial buyer",
        reference: "PARTIAL-TRAY-SALE",
        pricing: {
          mode: "tray-and-loose",
          trays: 1,
          traySize: 3,
          looseEggs: 0,
          pricePerTray: "1",
          pricePerEgg: "0",
        },
      },
      inventory,
    )
  ).id;
  const p = await ret();
  for (const actor of [inventory, worker, auditor, outsider])
    await expect(post(actor, "eggs/events", p)).rejects.toMatchObject({
      status: 403,
    });
  r1 = p.eventId;
  await post(owner, "eggs/events", p);
  await tenant(owner, (c) =>
    c.query("UPDATE organizations SET currency='USD' WHERE id=$1", [org]),
  );
  const q = await ret(saleId, { restockEggs: 0 });
  r2 = q.eventId;
  await post(owner, "eggs/events", q);
  const s = await snap(auditor);
  expect(s.events.find((e) => e.id === r1)).toMatchObject({
    amount: "-0.3333",
    currency: "NGN",
    quantity: 1,
    return_tray_eggs: 1,
  });
  expect(s.events.find((e) => e.id === r2)).toMatchObject({
    amount: "-0.3334",
    currency: "NGN",
    quantity: 0,
  });
  expect(s.summary.saleReturns.find((r) => r.saleId === saleId)).toMatchObject({
    returnedTrayEggs: 2,
    creditedValue: "0.6667",
    restockedEggs: 1,
    nonSaleableEggs: 1,
  });
  await tenant(owner, (c) =>
    c.query("UPDATE organizations SET currency='NGN' WHERE id=$1", [org]),
  );
});
it("guards stale/concurrent returns, caps original quantities and reconciles cumulative rounding exactly", async () => {
  const p = await ret(),
    q = {
      ...p,
      eventId: randomUUID(),
      reference: "RETURN-RACE-" + randomUUID(),
    };
  const results = await Promise.allSettled([
    post(owner, "eggs/events", p),
    post(owner, "eggs/events", q),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { status: 409 },
  });
  const s = await snap(),
    state = s.summary.saleReturns.find((r) => r.saleId === saleId)!;
  expect(state).toMatchObject({
    remainingTrayEggs: 0,
    creditedValue: "1.0000",
    nonSaleableEggs: 1,
  });
  await expect(post(owner, "eggs/events", await ret())).rejects.toMatchObject({
    status: 400,
  });
  await expect(
    event({ kind: "reversal", reversesId: saleId }),
  ).rejects.toMatchObject({ status: 409 });
});
it("reverses partial returns latest-first without rounding drift, then permits one full sale reversal", async () => {
  await expect(
    event({ kind: "reversal", reversesId: r1 }),
  ).rejects.toMatchObject({ status: 409 });
  let state = (await snap()).summary.saleReturns.find(
    (r) => r.saleId === saleId,
  )!;
  await event({ kind: "reversal", reversesId: state.latestReturnId });
  state = (await snap()).summary.saleReturns.find((r) => r.saleId === saleId)!;
  expect(state).toMatchObject({ creditedValue: "0.6667", returnedTrayEggs: 2 });
  await event({ kind: "reversal", reversesId: r2 });
  await event({ kind: "reversal", reversesId: r1 });
  state = (await snap()).summary.saleReturns.find((r) => r.saleId === saleId)!;
  expect(state).toMatchObject({ returnedTrayEggs: 0, creditedValue: "0.0000" });
  await event({ kind: "reversal", reversesId: saleId });
  await expect(post(owner, "eggs/events", await ret())).rejects.toMatchObject({
    status: 400,
  });
});
it("preserves original individually-priced limits and prevents duplicate return references or forged credit", async () => {
  const sale = (
    await event({
      kind: "sale",
      grade: "ungraded",
      currency: "NGN",
      customer: "Synthetic unit-price buyer",
      reference: "UNIT-PRICE-SALE",
      pricing: { mode: "per-egg", eggs: 5, pricePerEgg: "0.1234" },
    })
  ).id;
  const p = await ret(sale, {
    trayEggs: 0,
    looseEggs: 2,
    restockEggs: 1,
    reference: "RETURN-UNIT-ONE",
  });
  await post(owner, "eggs/events", p);
  expect((await post(owner, "eggs/events", p)).status).toBe(200);
  const s = await snap(),
    e = s.events.find((e) => e.id === p.eventId)!;
  expect(e).toMatchObject({
    quantity: 1,
    amount: "-0.2468",
    return_loose_eggs: 2,
  });
  await expect(
    post(
      owner,
      "eggs/events",
      await ret(sale, {
        trayEggs: 0,
        looseEggs: 1,
        restockEggs: 0,
        reference: p.reference,
      }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  const state = s.summary.saleReturns.find((r) => r.saleId === sale)!;
  await expect(
    tenant(owner, (c) =>
      c.query(
        `INSERT INTO egg_events(id,organization_id,batch_id,kind,occurred_on,grade,quantity,pricing,amount,currency,customer,reference,reason,evidence,submission,return_of_id,return_tray_eggs,return_loose_eggs,expected_return_position) SELECT $1,organization_id,batch_id,'return','2024-02-02',grade,1,pricing,-99,currency,customer,'FORGED-CREDIT','Synthetic forged credit','Synthetic evidence','{}',id,0,1,$3 FROM egg_events WHERE id=$2`,
        [randomUUID(), sale, state.expectedPosition],
      ),
    ),
  ).rejects.toMatchObject({ code: "23514" });
});
it("retains immutable source/pricing history, member-only exports and complete transfer/return evidence", async () => {
  const s = await snap(auditor);
  expect(s.events[0].source_snapshot).toEqual(originalSource);
  await expect(
    tenant(owner, (c) =>
      c.query("UPDATE egg_events SET return_loose_eggs=100 WHERE id=$1", [r1]),
    ),
  ).rejects.toMatchObject({ code: "42501" });
  const csv = (await productionApi(
    new NextRequest(
      "http://localhost/api/eggs?organizationId=" + org + "&format=csv",
    ),
    { id: auditor },
    "eggs",
  ))!;
  expect(csv.headers.get("x-egg-snapshot-sha256")).toBe(s.evidenceSha256);
  const text = await csv.text();
  expect(text).toContain("Transfers and returns");
  expect(text).toContain(transferId);
  expect(text).toContain(child);
  expect(text).toContain(r1);
  expect(text).toContain("'=Synthetic partial buyer");
  await expect(snap(outsider)).rejects.toMatchObject({ status: 404 });
});
