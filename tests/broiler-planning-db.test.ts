import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { admin } from "./admin-db";
import { tenant, pool } from "../src/lib/db";
import { productionApi } from "../src/lib/production-api";
import { planFixture } from "./broiler-planning-fixture";
import type { PlanWorkspace, PlanReport } from "../src/lib/broiler-planning";
let owner: string,
  worker: string,
  auditor: string,
  outsider: string,
  org: string,
  foreign: string,
  farm: string,
  unit: string,
  layer: string,
  recipe: string;
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
  id: string | null = null,
  format = "workspace",
) =>
  (await productionApi(
    new NextRequest(
      `http://localhost/api/broilers/plans?organizationId=${org}&unitId=${unit}${id ? "&planId=" + id : ""}&format=${format}`,
    ),
    { id: actor },
    "broilers/plans",
  ))!;
const workspace = async (actor = owner): Promise<PlanWorkspace> =>
  (await get(actor)).json();
async function payload() {
  const h = await workspace();
  return {
    organizationId: org,
    unitId: unit,
    planId: randomUUID(),
    previousId: h.history[0]?.id ?? null,
    data: planFixture(),
  };
}
const counts = async () =>
  (
    await tenant(owner, (c) =>
      c.query(
        `SELECT (SELECT count(*) FROM daily_records WHERE unit_id=$1) AS daily,(SELECT count(*) FROM broiler_events WHERE unit_id=$1) AS events,(SELECT count(*) FROM forecasts WHERE organization_id=$2) AS forecasts,(SELECT recorded_balance FROM production_population_balances WHERE id=$1) AS balance`,
        [unit, org],
      ),
    )
  ).rows[0];
beforeAll(async () => {
  const ids = [];
  for (let i = 0; i < 4; i++)
    ids.push(
      (
        await admin.query(
          "INSERT INTO users(email,password_hash) VALUES($1,'fixture') RETURNING id",
          [randomUUID() + "@test.invalid"],
        )
      ).rows[0].id,
    );
  [owner, worker, auditor, outsider] = ids;
  org = (
    await tenant(owner, (c) =>
      c.query("SELECT create_organization('Synthetic broiler planning') AS id"),
    )
  ).rows[0].id;
  foreign = (
    await tenant(outsider, (c) =>
      c.query("SELECT create_organization('Foreign planning') AS id"),
    )
  ).rows[0].id;
  await admin.query(
    "INSERT INTO memberships VALUES($1,$2,'worker'),($1,$3,'auditor')",
    [org, worker, auditor],
  );
  farm = (
    await tenant(owner, (c) =>
      c.query(
        "INSERT INTO farms(organization_id,name,kind) VALUES($1,'Synthetic planning farm','broilers') RETURNING id",
        [org],
      ),
    )
  ).rows[0].id;
  for (const kind of ["broilers", "layers"]) {
    const u = (
      await (
        await post(owner, "units", {
          organizationId: org,
          farmId: farm,
          name: "Synthetic " + kind,
          kind,
          stockedOn: "2024-02-01",
          openingCount: 100,
          initialWeightG: 1000,
        })
      ).json()
    ).id;
    if (kind === "broilers") unit = u;
    else layer = u;
  }
  recipe = (
    await tenant(owner, (c) =>
      c.query(
        "INSERT INTO formula_versions(organization_id,name,batch_kg,lines,ingredient_snapshot,result) VALUES($1,'Synthetic draft reference only',100,'[]','[]','{}') RETURNING id",
        [org],
      ),
    )
  ).rows[0].id;
  await post(owner, "records", {
    organizationId: org,
    unitId: unit,
    recordedOn: "2024-02-01",
    mortality: 0,
    eggs: 0,
    cracked: 0,
    feedKg: 1,
    averageWeightG: 1100,
    sampleSize: 10,
    waterQuality: null,
    notes: "Synthetic real observation",
  });
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
it("previews and saves sourced planning inputs without changing actual stock, feed, sales or other forecasts", async () => {
  const before = await counts(),
    p = await payload();
  p.data.stages[0].recipeId = recipe;
  const preview = await (
    await post(auditor, "broilers/plans/preview", p)
  ).json();
  expect(preview.forecast).toMatchObject({
    feedKg: "35.200000",
    feedCost: "96.1000",
    expectedClosingBirds: "81.00000000",
  });
  expect((await workspace()).history).toHaveLength(0);
  const saved: PlanReport = await (
    await post(owner, "broilers/plans", p)
  ).json();
  expect(saved.source.revision).toBe(1);
  expect(saved.source.recipe_snapshots[0]).toMatchObject({
    id: recipe,
    status: "draft",
    species: null,
  });
  expect(saved.source.unit_snapshot).toMatchObject({
    id: unit,
    opening_count: 100,
    initial_weight_g: "1000.000000",
  });
  expect(await counts()).toEqual(before);
  expect((await workspace(auditor)).actualRecords[0].average_weight_g).toBe(
    "1100.000000",
  );
});
it("replays normalized exact receipts with no duplicate version/audit and rejects changed data", async () => {
  const p = await payload(),
    r = await post(owner, "broilers/plans", p);
  expect(r.status).toBe(201);
  const count = (
    await tenant(owner, (c) =>
      c.query("SELECT count(*) FROM audit_logs WHERE organization_id=$1", [
        org,
      ]),
    )
  ).rows[0].count;
  p.data.stages[0].rationG = "100.000000";
  expect((await post(owner, "broilers/plans", p)).status).toBe(200);
  expect(
    (
      await tenant(owner, (c) =>
        c.query("SELECT count(*) FROM audit_logs WHERE organization_id=$1", [
          org,
        ]),
      )
    ).rows[0].count,
  ).toBe(count);
  await expect(
    post(owner, "broilers/plans", {
      ...p,
      data: { ...p.data, name: "Changed" },
    }),
  ).rejects.toMatchObject({ status: 409 });
});
it("serializes competing managers into one next version and retains all historical sources", async () => {
  const p = await payload(),
    r = await Promise.allSettled([
      post(owner, "broilers/plans", p),
      post(owner, "broilers/plans", {
        ...p,
        planId: randomUUID(),
        data: { ...p.data, name: "Other manager" },
      }),
    ]);
  expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(r.find((x) => x.status === "rejected")).toMatchObject({
    reason: { status: 409 },
  });
  expect((await workspace()).history).toHaveLength(3);
});
it("enforces actual owner/auditor-visible RLS, write roles, parent unit and recipe tenancy", async () => {
  const p = await payload();
  for (const actor of [worker, auditor, outsider])
    await expect(post(actor, "broilers/plans", p)).rejects.toMatchObject({
      status: 403,
    });
  await expect(workspace(outsider)).rejects.toMatchObject({ status: 404 });
  expect(
    (
      await tenant(outsider, (c) =>
        c.query("SELECT * FROM broiler_plans WHERE organization_id=$1", [org]),
      )
    ).rowCount,
  ).toBe(0);
  await expect(
    post(owner, "broilers/plans", { ...p, unitId: layer }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    post(owner, "broilers/plans", { ...p, organizationId: foreign }),
  ).rejects.toMatchObject({ status: 403 });
  p.data.stages[0].recipeId = randomUUID();
  await expect(post(owner, "broilers/plans", p)).rejects.toMatchObject({
    status: 404,
  });
});
it("rejects structural source/age errors and price claims instead of accepting scientific defaults", async () => {
  const p = await payload();
  await expect(
    post(owner, "broilers/plans", {
      ...p,
      data: { ...p.data, hatchDate: "2024-01-26" },
    }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    post(owner, "broilers/plans", { ...p, result: { profit: 1 } }),
  ).rejects.toHaveProperty("issues");
  const d = planFixture();
  d.stages[1].startAge = 8;
  await expect(
    post(owner, "broilers/plans", { ...p, data: d }),
  ).rejects.toHaveProperty("issues");
});
it("enforces structure and snapshot provenance through direct runtime writes and keeps versions immutable", async () => {
  const p = await payload(),
    input = {
      ...p.data,
      stages: [{ ...p.data.stages[0], stage: null }, p.data.stages[1]],
    };
  await expect(
    tenant(owner, (c) =>
      c.query(
        "INSERT INTO broiler_plans(id,organization_id,unit_id,previous_id,input) VALUES($1,$2,$3,$4,$5)",
        [p.planId, org, unit, p.previousId, JSON.stringify(input)],
      ),
    ),
  ).rejects.toMatchObject({ code: "23514" });
  const valid = (
    await tenant(owner, (c) =>
      c.query(
        `INSERT INTO broiler_plans(id,organization_id,unit_id,previous_id,input,unit_snapshot,recipe_snapshots) VALUES($1,$2,$3,$4,$5,'{"opening_count":999}','[{"id":"forged"}]') RETURNING unit_snapshot,recipe_snapshots`,
        [p.planId, org, unit, p.previousId, JSON.stringify(p.data)],
      ),
    )
  ).rows[0];
  expect(valid.unit_snapshot.opening_count).toBe(100);
  expect(valid.recipe_snapshots).toEqual([]);
  for (const sql of [
    "UPDATE broiler_plans SET input='{}' WHERE unit_id=$1",
    "DELETE FROM broiler_plans WHERE unit_id=$1",
  ])
    await expect(
      tenant(owner, (c) => c.query(sql, [unit])),
    ).rejects.toMatchObject({ code: "42501" });
});
it("keeps old report bytes and currency after newer plans, actual observations and organization changes", async () => {
  const old = (await workspace()).selected!,
    before = await (await get(auditor, old.source.id, "csv")).text(),
    digest = old.evidenceSha256;
  await tenant(owner, (c) =>
    c.query(
      "UPDATE organizations SET currency='USD',timezone='UTC' WHERE id=$1",
      [org],
    ),
  );
  const p = await payload();
  p.data.currency = "USD";
  await post(owner, "broilers/plans", p);
  await post(owner, "records", {
    organizationId: org,
    unitId: unit,
    recordedOn: "2024-02-02",
    mortality: 1,
    eggs: 0,
    cracked: 0,
    feedKg: 2,
    averageWeightG: 1200,
    sampleSize: 10,
    waterQuality: null,
    notes: "Synthetic later actual observation",
  });
  const after: PlanReport = await (
    await get(auditor, old.source.id, "json")
  ).json();
  expect(after.evidenceSha256).toBe(digest);
  expect(after.forecast.currency).toBe("NGN");
  expect(await (await get(auditor, old.source.id, "csv")).text()).toBe(before);
  expect(await counts()).toMatchObject({
    balance: "99",
    daily: "2",
    events: "0",
    forecasts: "0",
  });
});
it("exports exact original source and neutralizes formula-like labels with authenticated read-only reports", async () => {
  const p = await payload();
  p.data.name = "=Synthetic formula-like name";
  const saved: PlanReport = await (
    await post(owner, "broilers/plans", p)
  ).json();
  const r = await get(auditor, saved.source.id, "csv"),
    text = await r.text();
  expect(r.headers.get("cache-control")).toBe("private, no-store");
  expect(r.headers.get("x-evidence-sha256")).toBe(saved.evidenceSha256);
  expect(text).toContain("Immutable source");
  expect(text).toContain("'=Synthetic formula-like name");
  expect(
    JSON.parse(
      text
        .split("\r\n")
        .find((x) => x.startsWith('"Immutable source"'))!
        .split(",")
        .slice(1)
        .join(",")
        .slice(1, -1)
        .replaceAll('""', '"'),
    ),
  ).toEqual(saved.source);
});
it("rejects real foreign and rejected recipe references without changing formula status or planning state", async () => {
  const foreignRecipe = (
    await tenant(outsider, (c) =>
      c.query(
        "INSERT INTO formula_versions(organization_id,name,batch_kg,lines,ingredient_snapshot,result) VALUES($1,'Foreign synthetic reference',100,'[]','[]','{}') RETURNING id",
        [foreign],
      ),
    )
  ).rows[0].id;
  const rejected = (
    await admin.query(
      "INSERT INTO formula_versions(organization_id,name,batch_kg,lines,ingredient_snapshot,result,status) VALUES($1,'Rejected synthetic reference',100,'[]','[]','{}','rejected') RETURNING id",
      [org],
    )
  ).rows[0].id;
  const p = await payload();
  p.data.stages[0].recipeId = foreignRecipe;
  await expect(post(owner, "broilers/plans", p)).rejects.toMatchObject({
    status: 404,
  });
  p.data.stages[0].recipeId = rejected;
  await expect(post(owner, "broilers/plans", p)).rejects.toMatchObject({
    status: 400,
  });
  await expect(
    tenant(owner, (c) =>
      c.query(
        "INSERT INTO broiler_plans(id,organization_id,unit_id,previous_id,input) VALUES($1,$2,$3,$4,$5)",
        [p.planId, org, unit, p.previousId, JSON.stringify(p.data)],
      ),
    ),
  ).rejects.toMatchObject({ code: "23514" });
  expect(
    (
      await tenant(owner, (c) =>
        c.query("SELECT status FROM formula_versions WHERE id=$1", [rejected]),
      )
    ).rows[0].status,
  ).toBe("rejected");
});
