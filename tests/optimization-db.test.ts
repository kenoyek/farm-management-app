import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { admin } from "./admin-db";
import { pool, tenant } from "../src/lib/db";
import { feedApi } from "../src/lib/feed-api";

let owner: string,
  other: string,
  nutritionist: string,
  auditor: string,
  org: string,
  foreignOrg: string,
  a: string,
  b: string,
  profile: string,
  optimalRun: string,
  infeasibleRun: string;
const evidence = "Synthetic test reference; not agricultural guidance";
async function post(actor: string, path: string, body: unknown) {
  return (await feedApi(
    new NextRequest(`http://localhost/api/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { id: actor },
    path,
  ))!;
}
async function get(actor: string, target: string, runId?: string) {
  const path = `optimization-runs${runId ? `/${runId}` : ""}`;
  return (await feedApi(
    new NextRequest(`http://localhost/api/${path}?organizationId=${target}`),
    { id: actor },
    path,
  ))!;
}
const input = () => ({
  organizationId: org,
  name: "Optimizer history fixture",
  batchKg: 100,
  profileId: profile,
  status: "approved",
  lines: [
    { ingredientId: a, percent: 50, max: 100 },
    { ingredientId: b, percent: 50, max: 100 },
  ],
});
beforeAll(async () => {
  const users = [];
  for (let i = 0; i < 4; i++)
    users.push(
      (
        await admin.query(
          "INSERT INTO users(email,password_hash) VALUES($1,'fixture') RETURNING id",
          [`${randomUUID()}@test.invalid`],
        )
      ).rows[0].id,
    );
  [owner, other, nutritionist, auditor] = users;
  org = await tenant(
    owner,
    async (c) =>
      (
        await c.query(
          "SELECT create_organization('Optimizer history tests') AS id",
        )
      ).rows[0].id,
  );
  foreignOrg = await tenant(
    other,
    async (c) =>
      (
        await c.query(
          "SELECT create_organization('Foreign optimizer history') AS id",
        )
      ).rows[0].id,
  );
  await admin.query(
    "INSERT INTO memberships VALUES($1,$2,'nutritionist'),($1,$3,'auditor')",
    [org, nutritionist, auditor],
  );
  const ingredient = async (name: string, price: number, protein: number) =>
    (
      await (
        await post(nutritionist, "ingredients", {
          organizationId: org,
          name,
          source: evidence,
          price,
          nutrients: {
            energy: 3000,
            protein,
            dryMatter: 90,
            calcium: 1,
            phosphorus: 0.5,
            methionine: 0.5,
            lysine: 1,
          },
          basis: "as-fed",
          energySystem: "ME",
          species: "poultry",
          stages: ["starter"],
          phosphorusBasis: "total",
          quotedOn: new Date().toISOString().slice(0, 10),
          reviewStatus: "approved",
        })
      ).json()
    ).id;
  a = await ingredient("Cheap fixture", 100, 10);
  b = await ingredient("Rich fixture", 300, 50);
  profile = (
    await (
      await post(nutritionist, "profiles", {
        organizationId: org,
        name: "Starter fixture",
        species: "poultry",
        stage: "starter",
        source: evidence,
        basis: "as-fed",
        energySystem: "ME",
        phosphorusBasis: "total",
        limits: {
          energy: { min: 2000 },
          protein: { min: 20 },
          calcium: { min: 0 },
          phosphorus: { min: 0 },
          methionine: { min: 0 },
          lysine: { min: 0 },
        },
      })
    ).json()
  ).id;
  const optimal = await (
    await post(nutritionist, "formulas/optimize", input())
  ).json();
  expect(optimal.status).toBe("optimal");
  optimalRun = optimal.runId;
  const infeasible = await (
    await post(nutritionist, "formulas/optimize", {
      ...input(),
      lines: [
        { ingredientId: a, percent: 50 },
        { ingredientId: b, percent: 50, availableKg: 10 },
      ],
    })
  ).json();
  expect(infeasible.status).toBe("infeasible");
  infeasibleRun = infeasible.runId;
});
afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])", [
    [org, foreignOrg],
  ]);
  await admin.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
    [owner, other, nutritionist, auditor],
  ]);
  await pool.end();
  await admin.end();
});
it("records real optimal and diagnostic-only infeasible runs with immutable model-5 evidence", async () => {
  const detail = await (await get(owner, org, optimalRun)).json();
  expect(detail.record.request.modelVersion).toBe(5);
  expect(detail.record.request.profileSnapshot.id).toBe(profile);
  expect(detail.record.request.ingredientSnapshot).toHaveLength(2);
  expect(detail.view).toMatchObject({
    status: "optimal",
    costPerKg: "150.0000",
    diagnosticModelVersion: 1,
  });
  expect(detail.view.validation.totalPercentError).toBeLessThan(1e-6);
  const failure = await (await get(auditor, org, infeasibleRun)).json();
  expect(failure.view.diagnostics).toContainEqual(
    expect.objectContaining({ kind: "nutrient-minimum", nutrient: "protein" }),
  );
  expect(failure.record.result.fractions).toBeNull();
  expect(failure.view.costPerKg).toBeNull();
  expect(
    (
      await tenant(owner, (c) =>
        c.query("SELECT * FROM formula_versions WHERE organization_id=$1", [
          org,
        ]),
      )
    ).rowCount,
  ).toBe(0);
});
it("allows owner/auditor reads of real run rows while denying outsider and forged organization access", async () => {
  for (const actor of [owner, nutritionist, auditor]) {
    const response = await get(actor, org);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect((await response.json()).map((r: { id: string }) => r.id)).toEqual(
      expect.arrayContaining([optimalRun, infeasibleRun]),
    );
  }
  expect(await (await get(other, org)).json()).toEqual([]);
  for (const [actor, target] of [
    [other, org],
    [owner, foreignOrg],
  ])
    await expect(get(actor, target, optimalRun)).rejects.toMatchObject({
      status: 404,
    });
  await expect(get(owner, org, randomUUID())).rejects.toMatchObject({
    status: 404,
  });
});
it("denies auditor execution and runtime mutation of historical results", async () => {
  await expect(
    post(auditor, "formulas/optimize", input()),
  ).rejects.toMatchObject({ status: 403 });
  for (const query of [
    "UPDATE optimization_runs SET result='{}' WHERE id=$1",
    "DELETE FROM optimization_runs WHERE id=$1",
  ])
    await expect(
      tenant(nutritionist, (c) => c.query(query, [optimalRun])),
    ).rejects.toMatchObject({ code: "42501" });
});
it("restores the saved allocation with original bounds as draft data, without carrying approval", async () => {
  const detail = await (await get(owner, org, optimalRun)).json();
  expect(detail.restoration.allocationSource).toBe("saved solution");
  expect(detail.restoration.content.lines[0]).toMatchObject({
    ingredientId: a,
    max: 100,
  });
  expect(detail.restoration.content.lines[0].percent).toBeCloseTo(75, 7);
  expect(detail.restoration.content).not.toHaveProperty("status");
  expect(detail.hasReferenceSnapshots).toBe(true);
  const failure = await (await get(owner, org, infeasibleRun)).json();
  expect(failure.restoration.allocationSource).toBe("original inputs");
  expect(failure.restoration.content.lines[1].availableKg).toBe(10);
});
it("never substitutes current quotations or profile revisions into saved history", async () => {
  const before = (await (await get(owner, org, optimalRun)).json()).record;
  await tenant(nutritionist, (c) =>
    c.query(
      "INSERT INTO ingredients(organization_id,parent_id,revision,name,source,nutrients,price,review_status,basis,energy_system,verified_at,reviewer_id,species,stages,phosphorus_basis,quoted_on) SELECT organization_id,id,revision+1,name,source,nutrients,900,'approved',basis,energy_system,now(),current_actor(),species,stages,phosphorus_basis,current_date FROM ingredients WHERE id=$1",
      [a],
    ),
  );
  await post(nutritionist, "profiles", {
    organizationId: org,
    parentId: profile,
    name: "Revised starter fixture",
    species: "poultry",
    stage: "starter",
    source: evidence,
    basis: "as-fed",
    energySystem: "ME",
    phosphorusBasis: "total",
    limits: before.request.profileSnapshot.limits,
  });
  const after = (await (await get(owner, org, optimalRun)).json()).record;
  expect(after).toEqual(before);
  expect(
    after.request.ingredientSnapshot.find((i: { id: string }) => i.id === a)
      .price,
  ).toBe("100.0000");
  expect(after.result.calculation.costPerKg).toBe("150.0000");
});
it("labels legacy/malformed outcomes and refuses restoration of cross-tenant references", async () => {
  const legacy = (
    await tenant(owner, (c) =>
      c.query(
        "INSERT INTO optimization_runs(organization_id,request,result) VALUES($1,$2,$3) RETURNING id",
        [
          org,
          JSON.stringify(input()),
          JSON.stringify({
            status: "infeasible",
            solver: "Legacy fixture",
            message: "Synthetic historical outcome",
          }),
        ],
      ),
    )
  ).rows[0].id;
  const detail = await (await get(owner, org, legacy)).json();
  expect(detail.hasReferenceSnapshots).toBe(false);
  expect(detail.view.effectiveBounds).toEqual([]);
  expect(detail.restoration.allocationSource).toBe("original inputs");
  const foreignIngredient = (
    await tenant(other, (c) =>
      c.query(
        "INSERT INTO ingredients(organization_id,name,source,nutrients) VALUES($1,'Foreign',$2,'{}') RETURNING id",
        [foreignOrg, evidence],
      ),
    )
  ).rows[0].id;
  const forged = (
    await tenant(owner, (c) =>
      c.query(
        "INSERT INTO optimization_runs(organization_id,request,result) VALUES($1,$2,'{}') RETURNING id",
        [
          org,
          JSON.stringify({
            ...input(),
            lines: [{ ingredientId: foreignIngredient, percent: 100 }],
          }),
        ],
      ),
    )
  ).rows[0].id;
  const rejected = await (await get(owner, org, forged)).json();
  expect(rejected.restoration).toBeNull();
  expect(rejected.view).toBeNull();
  expect(rejected.summary.status).toBe("unknown");
});
