import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { admin } from "./admin-db";
import { pool, tenant } from "../src/lib/db";
import { feedApi } from "../src/lib/feed-api";
import { loadRecipeReports } from "../src/lib/recipe-report-api";
import { recipeSheets, sheetsCsv } from "../src/lib/recipe-reports";
let owner: string,
  reviewer: string,
  auditor: string,
  outsider: string,
  org: string,
  foreignOrg: string,
  a: string,
  b: string,
  unknown: string,
  foreign: string,
  profile: string,
  recipe: string;
const source =
  "Synthetic processing validation only; not agricultural guidance";
async function post(actor: string, path: string, data: unknown) {
  return (await feedApi(
    new NextRequest("http://localhost/api/" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
    { id: actor },
    path,
  ))!;
}
const ingredient = (name: string, price: number, protein: number) => ({
  organizationId: org,
  name,
  source,
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
  reviewStatus: "approved",
  species: "poultry",
  stages: ["starter"],
  phosphorusBasis: "total",
  quotedOn: new Date().toISOString().slice(0, 10),
  processingMethod: "heat-treated",
  processingEvidence: source,
});
const allowed = () =>
  [a, b].map((ingredientId) => ({ ingredientId, min: 0, max: 100, source }));
const group = () => ({
  name: "Synthetic aggregate cap",
  ingredientIds: [a],
  minPercent: 0,
  maxPercent: 60,
  requiredMethod: "heat-treated",
  source,
});
const profileBody = () => ({
  organizationId: org,
  name: "Synthetic processing starter",
  species: "poultry",
  stage: "starter",
  source,
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
  ingredientRules: allowed(),
  processingRules: [group()],
});
const formula = () => ({
  organizationId: org,
  name: "Synthetic processing recipe",
  batchKg: 100,
  profileId: profile,
  status: "draft",
  lines: [
    { ingredientId: a, percent: 75 },
    { ingredientId: b, percent: 25 },
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
  [owner, reviewer, auditor, outsider] = users;
  org = await tenant(
    owner,
    async (c) =>
      (await c.query("SELECT create_organization('Processing tests') AS id"))
        .rows[0].id,
  );
  foreignOrg = await tenant(
    outsider,
    async (c) =>
      (
        await c.query(
          "SELECT create_organization('Foreign processing tests') AS id",
        )
      ).rows[0].id,
  );
  await admin.query(
    "INSERT INTO memberships VALUES($1,$2,'nutritionist'),($1,$3,'auditor')",
    [org, reviewer, auditor],
  );
  a = (
    await (
      await post(
        reviewer,
        "ingredients",
        ingredient("Synthetic cheap treated", 100, 10),
      )
    ).json()
  ).id;
  b = (
    await (
      await post(
        reviewer,
        "ingredients",
        ingredient("Synthetic rich treated", 300, 50),
      )
    ).json()
  ).id;
  unknown = (
    await (
      await post(reviewer, "ingredients", {
        ...ingredient("Unknown method", 100, 20),
        processingMethod: null,
        processingEvidence: null,
      })
    ).json()
  ).id;
  foreign = (
    await tenant(outsider, (c) =>
      c.query(
        "INSERT INTO ingredients(organization_id,name,source,nutrients) VALUES($1,'Foreign',$2,'{}') RETURNING id",
        [foreignOrg, source],
      ),
    )
  ).rows[0].id;
  profile = (await (await post(reviewer, "profiles", profileBody())).json()).id;
});
afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])", [
    [org, foreignOrg],
  ]);
  await admin.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
    [owner, reviewer, auditor, outsider],
  ]);
  await pool.end();
  await admin.end();
});
it("retains exact method evidence and nutritionist-reviewed group rules with real tenant isolation", async () => {
  expect(
    (
      await tenant(owner, (c) =>
        c.query(
          "SELECT processing_method,processing_evidence FROM ingredients WHERE id=$1",
          [a],
        ),
      )
    ).rows[0],
  ).toEqual({ processing_method: "heat-treated", processing_evidence: source });
  expect(
    (
      await tenant(auditor, (c) =>
        c.query(
          "SELECT processing_rules FROM requirement_profiles WHERE id=$1",
          [profile],
        ),
      )
    ).rows[0].processing_rules,
  ).toEqual([group()]);
  expect(
    (
      await tenant(outsider, (c) =>
        c.query("SELECT * FROM requirement_profiles WHERE id=$1", [profile]),
      )
    ).rowCount,
  ).toBe(0);
  await expect(post(owner, "profiles", profileBody())).rejects.toMatchObject({
    status: 403,
  });
  await expect(post(auditor, "profiles", profileBody())).rejects.toMatchObject({
    status: 403,
  });
});
it("requires paired method evidence and rejects missing, mismatched, foreign or unlisted processing members", async () => {
  await expect(
    post(reviewer, "ingredients", {
      ...ingredient("Missing evidence", 100, 20),
      processingEvidence: null,
    }),
  ).rejects.toMatchObject({ status: 400 });
  for (const data of [
    { ...profileBody(), ingredientRules: [] },
    {
      ...profileBody(),
      processingRules: [{ ...group(), ingredientIds: [foreign] }],
    },
    {
      ...profileBody(),
      ingredientRules: [
        ...allowed(),
        { ingredientId: unknown, min: 0, max: 100, source },
      ],
      processingRules: [{ ...group(), ingredientIds: [unknown] }],
    },
    {
      ...profileBody(),
      processingRules: [{ ...group(), requiredMethod: "fermented" }],
    },
  ])
    await expect(post(reviewer, "profiles", data)).rejects.toMatchObject({
      status: 422,
    });
  await expect(
    tenant(owner, (c) =>
      c.query(
        "INSERT INTO ingredients(organization_id,name,source,nutrients,processing_method) VALUES($1,'Forged method',$2,'{}','heat-treated')",
        [org, source],
      ),
    ),
  ).rejects.toMatchObject({ code: "23514" });
});
it("blocks manual approval above a group cap and stores a genuine compliant optimum with independent totals", async () => {
  const manual = await (
    await post(reviewer, "formulas/calculate", formula())
  ).json();
  expect(manual.releaseEligible).toBe(false);
  expect(manual.processingCompliance[0]).toMatchObject({
    actualPercent: 75,
    status: "fail",
  });
  await expect(
    post(reviewer, "formulas/save", { ...formula(), status: "approved" }),
  ).rejects.toMatchObject({ status: 400 });
  const result = await (
    await post(reviewer, "formulas/optimize", formula())
  ).json();
  expect(result.status).toBe("optimal");
  expect(result.calculation.costPerKg).toBe("180.0000");
  expect(result.processingGroups[0].actualPercent).toBeCloseTo(60);
  const saved = await (
    await post(reviewer, "formulas/save", {
      ...formula(),
      status: "approved",
      lines: result.lines,
    })
  ).json();
  recipe = saved.id;
  expect(saved.releaseEligible).toBe(true);
  expect(saved.processingCompliance[0].status).toBe("pass");
  const run = (
    await tenant(owner, (c) =>
      c.query("SELECT request,result FROM optimization_runs WHERE id=$1", [
        result.runId,
      ]),
    )
  ).rows[0];
  expect(run.request.modelVersion).toBe(5);
  expect(run.request.profileSnapshot.processing_rules).toEqual([group()]);
});
it("validates direct SQL group insertion and forbids widening or changing reviewed historical rules", async () => {
  const raw = (groups: unknown) =>
    tenant(reviewer, (c) =>
      c.query(
        "INSERT INTO requirement_profiles(organization_id,name,species,stage,source,basis,energy_system,limits,reviewer_id,phosphorus_basis,ingredient_rules,processing_rules) VALUES($1,'Raw group','poultry','starter',$2,'as-fed','ME',$3,current_actor(),'total',$4,$5)",
        [
          org,
          source,
          JSON.stringify(profileBody().limits),
          JSON.stringify(allowed()),
          JSON.stringify(groups),
        ],
      ),
    );
  for (const groups of [
    [{ ...group(), maxPercent: -1 }],
    [{ ...group(), ingredientIds: [a, a] }],
    [{ ...group(), requiredMethod: "raw" }],
    [{ ...group(), ingredientIds: [foreign] }],
    [{ ...group(), source: "none" }],
  ])
    await expect(raw(groups)).rejects.toMatchObject({ code: "23514" });
  await expect(
    tenant(reviewer, (c) =>
      c.query(
        "UPDATE requirement_profiles SET processing_rules='[]' WHERE id=$1",
        [profile],
      ),
    ),
  ).rejects.toMatchObject({ code: "42501" });
});
it("keeps processing evidence, checks and exports unchanged after new ingredient/profile revisions", async () => {
  const before = (
    await tenant(owner, (c) => loadRecipeReports(c, org, [recipe]))
  )[0];
  await post(reviewer, "ingredients", {
    ...ingredient("Revised process", 500, 10),
    parentId: a,
    processingMethod: "extruded",
  });
  await post(reviewer, "profiles", {
    ...profileBody(),
    parentId: profile,
    processingRules: [{ ...group(), maxPercent: 50 }],
  });
  const after = (
    await tenant(auditor, (c) => loadRecipeReports(c, org, [recipe]))
  )[0];
  expect(after).toEqual(before);
  expect(after.allocations[0].reference.processing_method).toBe("heat-treated");
  const csv = sheetsCsv(recipeSheets(after, org, "digest"));
  expect(csv).toContain("Synthetic aggregate cap");
  expect(csv).toContain("Processing method evidence");
  expect(csv).toContain("heat-treated");
  await expect(
    tenant(outsider, (c) => loadRecipeReports(c, org, [recipe])),
  ).rejects.toMatchObject({ status: 404 });
});
