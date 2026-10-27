import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { admin } from "./admin-db";
import { pool, tenant } from "../src/lib/db";
import { feedApi } from "../src/lib/feed-api";

let owner: string,
  reviewer: string,
  outsider: string,
  org: string,
  foreignOrg: string,
  a: string,
  b: string,
  profile: string,
  recipe: string;
const evidence =
  "Synthetic expanded measurement fixture only; not agricultural guidance";
const core = {
  energy: 3000,
  protein: 20,
  dryMatter: 90,
  calcium: 1,
  phosphorus: 0.5,
  methionine: 0.5,
  lysine: 1,
};
const limits = {
  energy: { min: 2000 },
  protein: { min: 20 },
  dryMatter: { min: 80 },
  calcium: { min: 0 },
  phosphorus: { min: 0 },
  methionine: { min: 0 },
  lysine: { min: 0 },
  crudeFat: { min: 4 },
  crudeFibre: { max: 5 },
  moisture: { max: 15 },
  ash: { max: 5 },
};
async function post(actor: string, path: string, data: unknown) {
  return (await feedApi(
    new NextRequest(`http://localhost/api/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
    { id: actor },
    path,
  ))!;
}
const ingredientBody = (name: string, price: number, crudeFat: number) => ({
  organizationId: org,
  name,
  price,
  source: evidence,
  nutrients: { ...core, crudeFat, crudeFibre: 4, moisture: 10, ash: 0 },
  basis: "as-fed",
  energySystem: "ME",
  species: "poultry",
  stages: ["starter"],
  phosphorusBasis: "total",
  quotedOn: new Date().toISOString().slice(0, 10),
  reviewStatus: "approved",
});
const profileBody = () => ({
  organizationId: org,
  name: "Synthetic expanded starter",
  species: "poultry",
  stage: "starter",
  source: evidence,
  basis: "as-fed",
  energySystem: "ME",
  phosphorusBasis: "total",
  limits,
});
const formulaBody = () => ({
  organizationId: org,
  name: "Synthetic expanded recipe",
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
  for (let i = 0; i < 3; i++)
    users.push(
      (
        await admin.query(
          "INSERT INTO users(email,password_hash) VALUES($1,'fixture') RETURNING id",
          [`${randomUUID()}@test.invalid`],
        )
      ).rows[0].id,
    );
  [owner, reviewer, outsider] = users;
  org = await tenant(
    owner,
    async (c) =>
      (
        await c.query(
          "SELECT create_organization('Expanded nutrient tests') AS id",
        )
      ).rows[0].id,
  );
  foreignOrg = await tenant(
    outsider,
    async (c) =>
      (
        await c.query(
          "SELECT create_organization('Other nutrient tests') AS id",
        )
      ).rows[0].id,
  );
  await admin.query("INSERT INTO memberships VALUES($1,$2,'nutritionist')", [
    org,
    reviewer,
  ]);
  a = (
    await (
      await post(
        reviewer,
        "ingredients",
        ingredientBody("Synthetic low-fat", 100, 2),
      )
    ).json()
  ).id;
  b = (
    await (
      await post(
        reviewer,
        "ingredients",
        ingredientBody("Synthetic high-fat", 300, 10),
      )
    ).json()
  ).id;
  profile = (await (await post(reviewer, "profiles", profileBody())).json()).id;
});
afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])", [
    [org, foreignOrg],
  ]);
  await admin.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
    [owner, reviewer, outsider],
  ]);
  await pool.end();
  await admin.end();
});
it("stores approved measured values and reviewed limits with actual member visibility and tenant isolation", async () => {
  const row = (
    await tenant(owner, (c) =>
      c.query("SELECT nutrients FROM ingredients WHERE id=$1", [a]),
    )
  ).rows[0];
  expect(row.nutrients).toMatchObject({
    crudeFat: 2,
    crudeFibre: 4,
    moisture: 10,
    ash: 0,
  });
  expect(
    (
      await tenant(outsider, (c) =>
        c.query("SELECT * FROM ingredients WHERE id=$1", [a]),
      )
    ).rowCount,
  ).toBe(0);
  expect(
    (
      await tenant(owner, (c) =>
        c.query("SELECT limits FROM requirement_profiles WHERE id=$1", [
          profile,
        ]),
      )
    ).rows[0].limits,
  ).toEqual(limits);
  await expect(
    post(owner, "ingredients", ingredientBody("Forged approval", 100, 5)),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    post(outsider, "formulas/calculate", {
      ...formulaBody(),
      organizationId: foreignOrg,
    }),
  ).rejects.toMatchObject({ status: 404 });
});
it("enforces all eleven constraints in real optimization and retains registry provenance in immutable history", async () => {
  const result = await (
    await post(reviewer, "formulas/optimize", formulaBody())
  ).json();
  expect(result.status).toBe("optimal");
  expect(result.calculation.costPerKg).toBe("150.0000");
  expect(result.compliance).toHaveLength(11);
  const saved = (
    await tenant(owner, (c) =>
      c.query("SELECT request FROM optimization_runs WHERE id=$1", [
        result.runId,
      ]),
    )
  ).rows[0].request;
  expect(saved.nutrientRegistryVersion).toBe(2);
  expect(saved.nutrientDefinitions).toHaveLength(11);
  expect(saved.profileSnapshot.limits.crudeFat).toEqual({ min: 4 });
  const calculation = await (
    await post(reviewer, "formulas/calculate", formulaBody())
  ).json();
  expect(calculation.releaseEligible).toBe(true);
  expect(calculation.nutrients.ash).toBe(0);
  const accepted = await post(reviewer, "formulas/save", {
    ...formulaBody(),
    status: "approved",
  });
  const value = await accepted.json();
  recipe = value.id;
  expect(value.modelVersion).toBe(4);
  expect(value.nutrientRegistryVersion).toBe(2);
});
it("rejects missing assessed nutrients instead of treating absent data as zero or approving it", async () => {
  const without = ingredientBody("Synthetic missing fat", 100, 2);
  const missing = {
    ...without,
    nutrients: { ...core, crudeFibre: 4, moisture: 10, ash: 0 },
  };
  const id = (await (await post(reviewer, "ingredients", missing)).json()).id;
  const payload = {
    ...formulaBody(),
    lines: [{ ingredientId: id, percent: 100 }],
  };
  const result = await (
    await post(reviewer, "formulas/calculate", payload)
  ).json();
  expect(result.releaseEligible).toBe(false);
  expect(
    result.compliance.find(
      (c: { nutrient: string }) => c.nutrient === "crudeFat",
    ).status,
  ).toBe("unknown");
  await expect(
    post(reviewer, "formulas/save", { ...payload, status: "approved" }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    post(reviewer, "formulas/optimize", payload),
  ).rejects.toMatchObject({ status: 422 });
});
it("rejects unknown methods, invalid percentage ranges and moisture basis at API and direct SQL boundaries", async () => {
  for (const nutrients of [
    { ...core, crudeFat: 101 },
    { ...core, crudeFibre: -1 },
    { ...core, moisture: "10" },
    { ...core, fat: 5 },
  ]) {
    await expect(
      post(reviewer, "ingredients", {
        ...ingredientBody("Invalid input", 100, 2),
        nutrients,
      }),
    ).rejects.toBeDefined();
    await expect(
      tenant(owner, (c) =>
        c.query(
          "INSERT INTO ingredients(organization_id,name,source,nutrients) VALUES($1,'Raw invalid',$2,$3)",
          [org, evidence, JSON.stringify(nutrients)],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  }
  await expect(
    post(reviewer, "ingredients", {
      ...ingredientBody("Wrong moisture basis", 100, 2),
      basis: "dry-matter",
    }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    tenant(owner, (c) =>
      c.query(
        "INSERT INTO ingredients(organization_id,name,source,nutrients,basis) VALUES($1,'Wrong basis',$2,'{\"moisture\":10}','dry-matter')",
        [org, evidence],
      ),
    ),
  ).rejects.toMatchObject({ code: "23514" });
  for (const invalid of [
    { crudeFat: { min: 101 } },
    { crudeFibre: { min: 5, max: 2 } },
    { ash: {} },
    { lipids: { min: 4 } },
  ]) {
    const bad = { ...limits, ...invalid };
    await expect(
      post(reviewer, "profiles", { ...profileBody(), limits: bad }),
    ).rejects.toBeDefined();
    await expect(
      tenant(reviewer, (c) =>
        c.query(
          "INSERT INTO requirement_profiles(organization_id,name,species,stage,limits,source,basis,energy_system,reviewer_id,phosphorus_basis) VALUES($1,'Invalid range','poultry','starter',$2,$3,'as-fed','ME',current_actor(),'total')",
          [org, JSON.stringify(bad), evidence],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  }
  await expect(
    post(reviewer, "profiles", { ...profileBody(), basis: "dry-matter" }),
  ).rejects.toMatchObject({ status: 400 });
});
it("preserves saved nutrient values and requirements after ingredient/profile revisions", async () => {
  await post(reviewer, "ingredients", {
    ...ingredientBody("Synthetic revised quote", 500, 8),
    parentId: a,
  });
  await post(reviewer, "profiles", {
    ...profileBody(),
    parentId: profile,
    limits: { ...limits, crudeFat: { min: 5 } },
  });
  const saved = (
    await tenant(owner, (c) =>
      c.query(
        "SELECT ingredient_snapshot,result FROM formula_versions WHERE id=$1",
        [recipe],
      ),
    )
  ).rows[0];
  expect(
    saved.ingredient_snapshot.find((i: { id: string }) => i.id === a).nutrients
      .crudeFat,
  ).toBe(2);
  expect(saved.result.nutrients.crudeFat).toBe(4);
  expect(saved.result.profileSnapshot.limits.crudeFat).toEqual({ min: 4 });
  expect(saved.result.releaseEligible).toBe(true);
});
