import { beforeAll, afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { admin } from "./admin-db";
import { pool, tenant } from "../src/lib/db";
import { feedApi } from "../src/lib/feed-api";
import type { IngredientRule } from "../src/lib/profile-rules";

let owner: string,
  other: string,
  nutritionist: string,
  auditor: string,
  org: string,
  foreignOrg: string,
  a: string,
  b: string,
  unverified: string,
  foreignIngredient: string,
  profile: string;
const evidence = "Synthetic test evidence only; not agricultural guidance";
const limits = {
  energy: { min: 2000 },
  protein: { min: 20 },
  calcium: { min: 0 },
  phosphorus: { min: 0 },
  methionine: { min: 0 },
  lysine: { min: 0 },
};
const rule = (ingredientId: string, min = 0, max = 100): IngredientRule => ({
  ingredientId,
  min,
  max,
  source: evidence,
});
const profileBody = () => ({
  organizationId: org,
  name: "Fixture starter",
  species: "poultry",
  stage: "starter",
  source: evidence,
  basis: "as-fed",
  energySystem: "ME",
  phosphorusBasis: "total",
  limits,
  ingredientRules: [rule(a, 0, 60), rule(b, 40)],
});
async function call(actor: string, path: string, body: unknown) {
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
const formulaBody = () => ({
  organizationId: org,
  name: "Fixture formula",
  batchKg: 100,
  profileId: profile,
  lines: [
    { ingredientId: a, percent: 60 },
    { ingredientId: b, percent: 40 },
  ],
});
const rawInsert = (
  actor: string,
  target: string,
  rules: unknown,
  parent: string | null = null,
  revision = 1,
) =>
  tenant(actor, (c) =>
    c.query(
      "INSERT INTO requirement_profiles(organization_id,name,species,stage,source,basis,energy_system,limits,reviewer_id,phosphorus_basis,ingredient_rules,parent_id,revision) VALUES($1,'Raw fixture','poultry','starter',$2,'as-fed','ME',$3,current_actor(),'total',$4,$5,$6) RETURNING id",
      [
        target,
        evidence,
        JSON.stringify(limits),
        JSON.stringify(rules),
        parent,
        revision,
      ],
    ),
  );
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
      (await c.query("SELECT create_organization('Profile tests') AS id"))
        .rows[0].id,
  );
  foreignOrg = await tenant(
    other,
    async (c) =>
      (await c.query("SELECT create_organization('Other profile tests') AS id"))
        .rows[0].id,
  );
  await admin.query(
    "INSERT INTO memberships VALUES($1,$2,'nutritionist'),($1,$3,'auditor'),($4,$2,'nutritionist')",
    [org, nutritionist, auditor, foreignOrg],
  );
  const createIngredient = async (name: string, price: number) =>
    (
      await (
        await call(nutritionist, "ingredients", {
          organizationId: org,
          name,
          source: evidence,
          nutrients: {
            energy: 3000,
            protein: 20,
            dryMatter: 90,
            calcium: 1,
            phosphorus: 0.5,
            methionine: 0.5,
            lysine: 1,
          },
          price,
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
  a = await createIngredient("Fixture A", 100);
  b = await createIngredient("Fixture B", 300);
  unverified = (
    await tenant(owner, (c) =>
      c.query(
        "INSERT INTO ingredients(organization_id,name,source,nutrients) VALUES($1,'Unverified',$2,'{}') RETURNING id",
        [org, evidence],
      ),
    )
  ).rows[0].id;
  foreignIngredient = (
    await tenant(other, (c) =>
      c.query(
        "INSERT INTO ingredients(organization_id,name,source,nutrients) VALUES($1,'Foreign',$2,'{}') RETURNING id",
        [foreignOrg, evidence],
      ),
    )
  ).rows[0].id;
  profile = (await (await call(nutritionist, "profiles", profileBody())).json())
    .id;
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
it("persists owner-visible rules and hides actual profiles from outsiders", async () => {
  const visible = await tenant(owner, (c) =>
    c.query("SELECT * FROM requirement_profiles WHERE id=$1", [profile]),
  );
  expect(visible.rows[0]).toMatchObject({
    revision: 1,
    ingredient_rules: profileBody().ingredientRules,
    reviewer_id: nutritionist,
  });
  expect(
    (
      await tenant(auditor, (c) =>
        c.query("SELECT * FROM requirement_profiles WHERE id=$1", [profile]),
      )
    ).rowCount,
  ).toBe(1);
  expect(
    (
      await tenant(other, (c) =>
        c.query("SELECT * FROM requirement_profiles WHERE id=$1", [profile]),
      )
    ).rowCount,
  ).toBe(0);
});
it("denies profile writes by owners/auditors/outsiders and preserves immutable rules", async () => {
  for (const actor of [owner, auditor, other]) {
    await expect(call(actor, "profiles", profileBody())).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      rawInsert(actor, org, profileBody().ingredientRules),
    ).rejects.toMatchObject({ code: "42501" });
  }
  for (const command of [
    "UPDATE requirement_profiles SET ingredient_rules='[]' WHERE id=$1",
    "DELETE FROM requirement_profiles WHERE id=$1",
  ])
    await expect(
      tenant(nutritionist, (c) => c.query(command, [profile])),
    ).rejects.toMatchObject({ code: "42501" });
});
it("rejects foreign/unreviewed/incompatible references in API and database", async () => {
  for (const ingredientId of [unverified, foreignIngredient]) {
    await expect(
      call(nutritionist, "profiles", {
        ...profileBody(),
        ingredientRules: [rule(ingredientId)],
      }),
    ).rejects.toMatchObject({
      status: ingredientId === foreignIngredient ? 404 : 422,
    });
    await expect(
      rawInsert(nutritionist, org, [rule(ingredientId)]),
    ).rejects.toMatchObject({
      code: ingredientId === foreignIngredient ? "23503" : "23514",
    });
  }
  await expect(
    call(nutritionist, "profiles", { ...profileBody(), stage: "finisher" }),
  ).rejects.toMatchObject({ status: 422 });
  await expect(
    rawInsert(nutritionist, foreignOrg, [], profile, 2),
  ).rejects.toMatchObject({ code: "23503" });
  await expect(
    rawInsert(nutritionist, org, [], profile, 5),
  ).rejects.toMatchObject({ code: "23514" });
});
it("rejects malformed, duplicate and infeasible rule lists at the database boundary", async () => {
  for (const rules of [
    null,
    {},
    [null],
    [rule(a), rule(a)],
    [{ ...rule(a), source: "" }],
    [{ ...rule(a), min: null }],
    [{ ...rule(a), extra: 1 }],
    [rule(a, 60, 50)],
    [rule(a, 0, 40)],
    [rule(a, 80), rule(b, 80)],
  ])
    await expect(rawInsert(nutritionist, org, rules)).rejects.toMatchObject({
      code: "23514",
    });
  await expect(
    call(nutritionist, "profiles", {
      ...profileBody(),
      ingredientRules: [rule(a, 0, 40)],
    }),
  ).rejects.toMatchObject({ status: 422 });
});
it("prevents manual approval when mandatory, capped or unlisted references violate the profile", async () => {
  const body = { ...formulaBody(), lines: [{ ingredientId: a, percent: 100 }] };
  const calculated = await (
    await call(nutritionist, "formulas/calculate", body)
  ).json();
  expect(calculated.releaseEligible).toBe(false);
  expect(calculated.issues).toEqual(
    expect.arrayContaining([
      expect.stringContaining("Fixture A: profile requires"),
      expect.stringContaining("Fixture B: profile requires"),
    ]),
  );
  await expect(
    call(nutritionist, "formulas/save", { ...body, status: "approved" }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    call(nutritionist, "formulas/optimize", body),
  ).rejects.toMatchObject({ status: 422 });
  const replacement = (
    await tenant(nutritionist, (c) =>
      c.query(
        "INSERT INTO ingredients(organization_id,parent_id,revision,name,source,nutrients,price,review_status,basis,energy_system,verified_at,reviewer_id,species,stages,phosphorus_basis,quoted_on) SELECT organization_id,id,revision+1,name,source,nutrients,200,'approved',basis,energy_system,now(),current_actor(),species,stages,phosphorus_basis,current_date FROM ingredients WHERE id=$1 RETURNING id",
        [a],
      ),
    )
  ).rows[0].id;
  const substituted = {
    ...formulaBody(),
    lines: [
      { ingredientId: replacement, percent: 60 },
      { ingredientId: b, percent: 40 },
    ],
  };
  expect(
    (await (await call(nutritionist, "formulas/calculate", substituted)).json())
      .issues,
  ).toContainEqual(expect.stringContaining("not allowed"));
  await expect(
    call(nutritionist, "formulas/optimize", substituted),
  ).rejects.toMatchObject({ status: 422 });
});
it("stores approval and real solver provenance against the exact profile version", async () => {
  const saved = await (
    await call(nutritionist, "formulas/save", {
      ...formulaBody(),
      status: "approved",
    })
  ).json();
  expect(saved.releaseEligible).toBe(true);
  expect(saved.profileSnapshot).toMatchObject({
    id: profile,
    revision: 1,
    ingredient_rules: profileBody().ingredientRules,
  });
  const solved = await (
    await call(nutritionist, "formulas/optimize", formulaBody())
  ).json();
  expect(solved.status).toBe("optimal");
  expect(solved.lines[0].percent).toBeCloseTo(60);
  const run = (
    await tenant(owner, (c) =>
      c.query(
        "SELECT request,result FROM optimization_runs WHERE organization_id=$1",
        [org],
      ),
    )
  ).rows[0];
  expect(run.request.profileSnapshot.id).toBe(profile);
  expect(run.request.ingredientSnapshot).toHaveLength(2);
  expect(run.request.modelVersion).toBe(3);
});
it("serializes competing revisions without changing historical approvals or rules", async () => {
  const revised = {
    ...profileBody(),
    parentId: profile,
    ingredientRules: [rule(a, 0, 40), rule(b, 60)],
  };
  const results = await Promise.allSettled([
    call(nutritionist, "profiles", revised),
    call(nutritionist, "profiles", revised),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { status: 409 },
  });
  const successor = (
    await tenant(owner, (c) =>
      c.query("SELECT * FROM requirement_profiles WHERE parent_id=$1", [
        profile,
      ]),
    )
  ).rows[0];
  expect(successor.revision).toBe(2);
  const currentResult = await (
    await call(nutritionist, "formulas/calculate", {
      ...formulaBody(),
      profileId: successor.id,
    })
  ).json();
  expect(currentResult.releaseEligible).toBe(false);
  expect(
    (
      await (
        await call(nutritionist, "formulas/calculate", formulaBody())
      ).json()
    ).releaseEligible,
  ).toBe(true);
  const historical = (
    await tenant(owner, (c) =>
      c.query(
        "SELECT status,result FROM formula_versions WHERE organization_id=$1",
        [org],
      ),
    )
  ).rows[0];
  expect(historical.status).toBe("approved");
  expect(historical.result.profileSnapshot.revision).toBe(1);
  expect(historical.result.releaseEligible).toBe(true);
  expect(
    (
      await tenant(owner, (c) =>
        c.query(
          "SELECT * FROM audit_logs WHERE organization_id=$1 AND action='profile.revised'",
          [org],
        ),
      )
    ).rowCount,
  ).toBe(1);
});
