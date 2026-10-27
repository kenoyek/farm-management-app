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
  foreignOrg: string;
let rows: {
  id: string;
  label: string;
  fields: { inclusion: { parsed: { kind: string; value?: number } } };
}[] = [];
const ingredientIds: string[] = [];
let recipe: string;
const source = "Synthetic source import review; not agricultural guidance";
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
const options = () => ({
  organizationId: org,
  sheet: "Broiler Starter",
  name: "Synthetic imported source draft",
  batchKg: 1000,
});
const inspect = async (actor = owner, input = options()) =>
  await (await post(actor, "imports/recipes/preview", input)).json();
const confirm = (previewDigest: string) => ({
  ...options(),
  previewDigest,
  confirmed: true,
  omitUnspecified: true,
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
      (await c.query("SELECT create_organization('Source import tests') AS id"))
        .rows[0].id,
  );
  foreignOrg = await tenant(
    outsider,
    async (c) =>
      (
        await c.query(
          "SELECT create_organization('Foreign source import tests') AS id",
        )
      ).rows[0].id,
  );
  await admin.query(
    "INSERT INTO memberships VALUES($1,$2,'nutritionist'),($1,$3,'auditor')",
    [org, reviewer, auditor],
  );
  await post(owner, "imports/confirm", {
    organizationId: org,
    confirmed: true,
  });
  rows = (
    await tenant(owner, (c) =>
      c.query(
        "SELECT * FROM import_reference_rows WHERE organization_id=$1 AND sheet='Broiler Starter' AND category='recipe' ORDER BY source_row",
        [org],
      ),
    )
  ).rows;
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
it("blocks unmapped populated rows without guessing names and allows read-only member previews", async () => {
  for (const batchKg of [0.0000001, 1.1234567])
    await expect(
      post(owner, "imports/recipes/preview", { ...options(), batchKg }),
    ).rejects.toBeDefined();
  const p = await inspect(auditor);
  expect(p.rows).toHaveLength(34);
  expect(p.unspecifiedCount).toBe(30);
  expect(p.blockers.join(" ")).toMatch(/explicit mapped/);
  expect(p.calculation).toBeNull();
  await expect(
    post(owner, "imports/recipes/confirm", confirm(p.previewDigest)),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    post(auditor, "imports/recipes/confirm", confirm(p.previewDigest)),
  ).rejects.toMatchObject({ status: 403 });
  await expect(inspect(outsider)).rejects.toMatchObject({ status: 404 });
  await expect(
    post(owner, "imports/recipes/confirm", {
      ...confirm(p.previewDigest),
      omitUnspecified: false,
    }),
  ).rejects.toBeDefined();
});
it("records provenance in immutable ingredient revisions with explicit dates and separate review status", async () => {
  for (const row of rows.filter(
    (r) =>
      r.fields.inclusion.parsed.kind === "scalar" &&
      (r.fields.inclusion.parsed.value ?? 0) > 0,
  )) {
    const r = await post(owner, "ingredients", {
      organizationId: org,
      name: `Synthetic ${row.label}`,
      source,
      price: 100,
      nutrients: {
        energy: 3000,
        protein: 20,
        dryMatter: null,
        calcium: 1,
        phosphorus: 0.5,
        methionine: null,
        lysine: 1,
      },
      basis: null,
      energySystem: null,
      category: "Synthetic raw material",
      supplier: "=Synthetic supplier",
      laboratoryOn: "2026-01-10",
      certificateReference: "Synthetic COA 42",
      processingNotes:
        "Synthetic raw processing note; no constraint is inferred.",
    });
    const id = (await r.json()).id;
    ingredientIds.push(id);
    await post(reviewer, `imports/catalog/${row.id}/reviews`, {
      organizationId: org,
      expectedRevision: 0,
      decision: "mapped",
      ingredientId: id,
      evidence: source,
      confirmed: true,
    });
  }
  const item = (
    await tenant(owner, (c) =>
      c.query("SELECT * FROM ingredients WHERE id=$1", [ingredientIds[0]]),
    )
  ).rows[0];
  expect(item).toMatchObject({
    supplier: "=Synthetic supplier",
    category: "Synthetic raw material",
    review_status: "unverified",
  });
  await expect(
    post(owner, "ingredients", {
      organizationId: org,
      name: "Future lab fixture",
      source,
      price: null,
      nutrients: {
        energy: null,
        protein: null,
        dryMatter: null,
        calcium: null,
        phosphorus: null,
        methionine: null,
        lysine: null,
      },
      basis: null,
      energySystem: null,
      laboratoryOn: "2999-01-01",
    }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    tenant(owner, (c) =>
      c.query(
        "INSERT INTO ingredients(organization_id,name,source,nutrients,laboratory_on) VALUES($1,'Future lab',$2,'{}','2999-01-01')",
        [org, source],
      ),
    ),
  ).rejects.toMatchObject({ code: "23514" });
  expect(
    (
      await tenant(outsider, (c) =>
        c.query("SELECT * FROM ingredients WHERE id=$1", [ingredientIds[0]]),
      )
    ).rowCount,
  ).toBe(0);
});
it("rejects stale preview confirmations after an alias review changes", async () => {
  const p = await inspect();
  expect(p.blockers).toEqual([]);
  const row = rows.find((r) => r.fields.inclusion.parsed.value === 55)!;
  await post(reviewer, `imports/catalog/${row.id}/reviews`, {
    organizationId: org,
    expectedRevision: 1,
    decision: "unresolved",
    ingredientId: null,
    evidence: source,
    confirmed: true,
  });
  await expect(
    post(owner, "imports/recipes/confirm", confirm(p.previewDigest)),
  ).rejects.toMatchObject({ status: 409 });
  await post(reviewer, `imports/catalog/${row.id}/reviews`, {
    organizationId: org,
    expectedRevision: 2,
    decision: "mapped",
    ingredientId: ingredientIds[0],
    evidence: source,
    confirmed: true,
  });
});
it("serializes confirmations into one draft with exact source percentages, original evidence and an audit entry", async () => {
  const p = await inspect();
  expect(p.blockers).toEqual([]);
  expect(p.lines.map((l: { percent: number }) => l.percent)).toEqual([
    55, 10, 30, 5,
  ]);
  const saved = await Promise.all([
    post(owner, "imports/recipes/confirm", confirm(p.previewDigest)),
    post(reviewer, "imports/recipes/confirm", confirm(p.previewDigest)),
  ]);
  const data = await Promise.all(saved.map((r) => r.json()));
  expect(data[0].id).toBe(data[1].id);
  expect(data.filter((r) => r.reused)).toHaveLength(1);
  recipe = data[0].id;
  const value = (
    await tenant(owner, (c) =>
      c.query("SELECT * FROM formula_versions WHERE id=$1", [recipe]),
    )
  ).rows[0];
  expect(value.status).toBe("draft");
  expect(value.profile_id).toBeNull();
  expect(value.result.releaseEligible).toBe(false);
  expect(value.result.nutrients.methionine).toBeNull();
  expect(value.source_recipe.rows).toHaveLength(34);
  expect(
    value.source_recipe.rows.filter(
      (r: { fields: { inclusion: { raw: unknown } } }) =>
        r.fields.inclusion.raw === null,
    ),
  ).toHaveLength(30);
  expect(
    (
      await tenant(owner, (c) =>
        c.query(
          "SELECT * FROM audit_logs WHERE organization_id=$1 AND action='source_recipe.imported'",
          [org],
        ),
      )
    ).rowCount,
  ).toBe(1);
  expect(
    (await post(owner, "imports/recipes/confirm", confirm(p.previewDigest)))
      .status,
  ).toBe(200);
});
it("keeps historical metadata and mapping evidence after new revisions and exports a fifth source audit sheet", async () => {
  const before = (
    await tenant(owner, (c) => loadRecipeReports(c, org, [recipe]))
  )[0];
  await post(owner, "ingredients", {
    organizationId: org,
    parentId: ingredientIds[0],
    name: "Synthetic revised reference",
    source,
    price: 500,
    nutrients: {
      energy: 3000,
      protein: 20,
      dryMatter: null,
      calcium: 1,
      phosphorus: 0.5,
      methionine: null,
      lysine: 1,
    },
    basis: null,
    energySystem: null,
    supplier: "New supplier",
    laboratoryOn: "2026-02-01",
  });
  const after = (
    await tenant(auditor, (c) => loadRecipeReports(c, org, [recipe]))
  )[0];
  expect(after).toEqual(before);
  expect(after.allocations[0].reference.supplier).toBe("=Synthetic supplier");
  expect(after.sourceRecipe?.rows[0].alias_review?.ingredient_id).toBe(
    ingredientIds[0],
  );
  const sheets = recipeSheets(after, org, "digest");
  expect(sheets).toHaveLength(5);
  expect(sheets[4].name).toBe("Source recipe audit");
  expect(sheetsCsv(sheets)).toContain("'=Synthetic supplier");
  expect(sheetsCsv(sheets)).toContain("Synthetic COA 42");
  await expect(
    tenant(outsider, (c) => loadRecipeReports(c, org, [recipe])),
  ).rejects.toMatchObject({ status: 404 });
});
it("rejects forged cross-tenant source evidence, changed allocations and import approval even through direct runtime inserts", async () => {
  const value = (
    await tenant(owner, (c) =>
      c.query("SELECT * FROM formula_versions WHERE id=$1", [recipe]),
    )
  ).rows[0];
  const insert = (
    target: string,
    lines = value.lines,
    status = "draft",
    evidence = value.source_recipe,
  ) =>
    tenant(target === org ? owner : outsider, (c) =>
      c.query(
        "INSERT INTO formula_versions(organization_id,name,batch_kg,lines,ingredient_snapshot,result,status,source_recipe) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          target,
          "Forged source",
          1000,
          JSON.stringify(lines),
          JSON.stringify(value.ingredient_snapshot),
          JSON.stringify(value.result),
          status,
          JSON.stringify({
            ...evidence,
            previewDigest: randomUUID().replaceAll("-", "").repeat(2),
          }),
        ],
      ),
    );
  await expect(insert(foreignOrg)).rejects.toMatchObject({ code: "23503" });
  await expect(
    insert(org, [{ ...value.lines[0], percent: 100 }]),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(insert(org, value.lines, "approved")).rejects.toBeDefined();
  await expect(
    tenant(owner, (c) =>
      c.query("UPDATE formula_versions SET source_recipe=NULL WHERE id=$1", [
        recipe,
      ]),
    ),
  ).rejects.toMatchObject({ code: "42501" });
});
