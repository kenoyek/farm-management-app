import { beforeAll, afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { NextRequest } from "next/server";
import { admin } from "./admin-db";
import { pool, tenant } from "../src/lib/db";
import { feedApi } from "../src/lib/feed-api";
import { recipeReportApi } from "../src/lib/recipe-report-api";

let owner: string,
  other: string,
  nutritionist: string,
  auditor: string,
  org: string,
  foreignOrg: string,
  a: string,
  b: string,
  profile: string,
  first: string,
  second: string,
  foreignRecipe: string;
const evidence = "Synthetic test-only evidence; not agricultural guidance";
const nutrientValues = {
  energy: 3000,
  protein: 20,
  dryMatter: 90,
  calcium: 1,
  phosphorus: 0.5,
  methionine: 0.5,
  lysine: 1,
};
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
const exportReport = (
  actor: string,
  target: string,
  recipe: string,
  format = "csv",
) =>
  recipeReportApi(
    new NextRequest(
      `http://localhost/api/formulas/${recipe}/export?organizationId=${target}&format=${format}`,
    ),
    { id: actor },
    `formulas/${recipe}/export`,
  );
const profileBody = (stage = "starter") => ({
  organizationId: org,
  name: `Test ${stage}`,
  species: "poultry",
  stage,
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
      (await c.query("SELECT create_organization('Recipe report tests') AS id"))
        .rows[0].id,
  );
  foreignOrg = await tenant(
    other,
    async (c) =>
      (
        await c.query(
          "SELECT create_organization('Other recipe reports') AS id",
        )
      ).rows[0].id,
  );
  await admin.query(
    "INSERT INTO memberships VALUES($1,$2,'nutritionist'),($1,$3,'auditor')",
    [org, nutritionist, auditor],
  );
  const ingredient = async (
    actor: string,
    target: string,
    name: string,
    price: number,
    approved: boolean,
  ) =>
    (
      await (
        await post(actor, "ingredients", {
          organizationId: target,
          name,
          source: evidence,
          nutrients: nutrientValues,
          price,
          basis: "as-fed",
          energySystem: "ME",
          species: "poultry",
          stages: ["starter", "finisher"],
          phosphorusBasis: "total",
          quotedOn: new Date().toISOString().slice(0, 10),
          reviewStatus: approved ? "approved" : "unverified",
        })
      ).json()
    ).id;
  a = await ingredient(nutritionist, org, "=SUM(1,1)", 100, true);
  b = await ingredient(nutritionist, org, "Rich fixture", 300, true);
  profile = (await (await post(nutritionist, "profiles", profileBody())).json())
    .id;
  first = (
    await (
      await post(nutritionist, "formulas/save", {
        organizationId: org,
        name: "=SUM(1,1)",
        batchKg: 100,
        profileId: profile,
        lines: [{ ingredientId: a, percent: 100 }],
        status: "approved",
      })
    ).json()
  ).id;
  second = (
    await (
      await post(nutritionist, "formulas/save", {
        organizationId: org,
        name: "Higher-cost draft",
        batchKg: 500,
        profileId: profile,
        lines: [
          { ingredientId: a, percent: 50 },
          { ingredientId: b, percent: 50 },
        ],
      })
    ).json()
  ).id;
  const foreignIngredient = await ingredient(
    other,
    foreignOrg,
    "Foreign ingredient",
    100,
    false,
  );
  foreignRecipe = (
    await (
      await post(other, "formulas/save", {
        organizationId: foreignOrg,
        name: "Foreign draft",
        batchKg: 100,
        lines: [{ ingredientId: foreignIngredient, percent: 100 }],
      })
    ).json()
  ).id;
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
it("lets current members and auditors download real saved reports with private headers", async () => {
  for (const actor of [owner, nutritionist, auditor]) {
    const response = (await exportReport(actor, org, first))!;
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toContain(first);
    expect(response.headers.get("x-recipe-snapshot-sha256")).toMatch(
      /^[a-f0-9]{64}$/,
    );
    const csv = await response.text();
    expect(csv).toContain("APPROVED SAVED VERSION");
    expect(csv).toContain(nutritionist);
    expect(csv).toContain('"\'=SUM(1,1)"');
    expect(csv).toContain("100.0000");
    expect(csv).toContain("Original batch kg");
  }
  expect(await (await exportReport(auditor, org, second))!.text()).toContain(
    "DRAFT — NOT APPROVED",
  );
});
it("denies outsider/cross-tenant/missing downloads and mixed-tenant comparisons without partial data", async () => {
  for (const [actor, target, recipe] of [
    [other, org, first],
    [owner, org, foreignRecipe],
    [owner, foreignOrg, first],
    [owner, org, randomUUID()],
  ])
    await expect(exportReport(actor, target, recipe)).rejects.toMatchObject({
      status: 404,
    });
  await expect(
    post(owner, "formulas/compare", {
      organizationId: org,
      recipeIds: [first, foreignRecipe],
      batchKg: 100,
    }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    post(other, "formulas/compare", {
      organizationId: org,
      recipeIds: [first, second],
      batchKg: 100,
    }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    post(owner, "formulas/compare", {
      organizationId: org,
      recipeIds: [first, first],
      batchKg: 100,
    }),
  ).rejects.toMatchObject({ name: "ZodError" });
  await expect(exportReport(owner, org, first, "pdf")).rejects.toMatchObject({
    name: "ZodError",
  });
});
it("compares authorized versions in requested baseline order and keeps resized batches as planning values", async () => {
  const response = await post(auditor, "formulas/compare", {
    organizationId: org,
    recipeIds: [first, second],
    batchKg: 250,
  });
  const result = await response.json();
  expect(result.contextComparable).toBe(true);
  expect(result.versions[0].savedBy).toBe(nutritionist);
  expect(result.versions[1]).toMatchObject({
    costPerKg: "200.0000",
    commonBatchCost: "50000.00",
    deltaPerKg: "100.0000",
    deltaCommonBatch: "25000.00",
    batchKg: "500.000000",
    status: "draft",
  });
  expect(result.versions[1].scaledAllocations[0].kg).toBe("125.000000");
  expect(result.warnings.join(" ")).toMatch(/not approved/);
  expect(
    (
      await (
        await post(owner, "formulas/compare", {
          organizationId: org,
          recipeIds: [second, first],
          batchKg: 250,
        })
      ).json()
    ).versions[1].deltaPerKg,
  ).toBe("-100.0000");
});
it("produces an actual four-sheet XLSX with literal formula-like names and original amounts", async () => {
  const response = (await exportReport(owner, org, first, "xlsx"))!;
  expect(response.headers.get("content-type")).toContain("spreadsheetml.sheet");
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(bytes.subarray(0, 2).toString()).toBe("PK");
  const inspection = spawnSync(
    process.env.FARM_PYTHON ?? "python",
    [
      "-c",
      "import sys,io,json;from openpyxl import load_workbook;w=load_workbook(io.BytesIO(sys.stdin.buffer.read()),data_only=False);print(json.dumps({'sheets':w.sheetnames,'name':w['Mixing sheet']['B2'].value,'type':w['Mixing sheet']['B2'].data_type,'batch':w['Mixing sheet']['B8'].value,'cost':w['Mixing sheet']['B10'].value}))",
    ],
    {
      input: bytes,
      timeout: 10000,
      env: { ...process.env, OPENBLAS_NUM_THREADS: "1" },
    },
  );
  expect(inspection.status).toBe(0);
  expect(JSON.parse(inspection.stdout.toString())).toEqual({
    sheets: ["Mixing sheet", "Nutrients", "Reference audit", "Specification"],
    name: "=SUM(1,1)",
    type: "s",
    batch: 100,
    cost: "100.0000",
  });
});
it("withholds nutrient deltas for a different production stage", async () => {
  const finisher = (
    await (await post(nutritionist, "profiles", profileBody("finisher"))).json()
  ).id;
  const third = (
    await (
      await post(nutritionist, "formulas/save", {
        organizationId: org,
        name: "Finisher draft",
        batchKg: 100,
        profileId: finisher,
        lines: [{ ingredientId: b, percent: 100 }],
      })
    ).json()
  ).id;
  const result = await (
    await post(owner, "formulas/compare", {
      organizationId: org,
      recipeIds: [first, third],
      batchKg: 100,
    })
  ).json();
  expect(result.contextComparable).toBe(false);
  expect(Object.values(result.versions[1].nutrientDeltas)).toEqual(
    Array(11).fill(null),
  );
  expect(result.versions[1].deltaPerKg).toBe("200.0000");
});
it("preserves export bytes/digest and historical comparison evidence after reference/profile revisions", async () => {
  const before = (await exportReport(owner, org, first))!;
  const csv = await before.text(),
    digest = before.headers.get("x-recipe-snapshot-sha256");
  await tenant(nutritionist, (c) =>
    c.query(
      "INSERT INTO ingredients(organization_id,parent_id,revision,name,source,nutrients,price,review_status,basis,energy_system,verified_at,reviewer_id,species,stages,phosphorus_basis,quoted_on) SELECT organization_id,id,revision+1,name,source,nutrients,900,'approved',basis,energy_system,now(),current_actor(),species,stages,phosphorus_basis,current_date FROM ingredients WHERE id=$1",
      [a],
    ),
  );
  await post(nutritionist, "profiles", {
    ...profileBody(),
    parentId: profile,
    source: "Updated synthetic review evidence",
  });
  const after = (await exportReport(owner, org, first))!;
  expect(after.headers.get("x-recipe-snapshot-sha256")).toBe(digest);
  expect(await after.text()).toBe(csv);
  const result = await (
    await post(owner, "formulas/compare", {
      organizationId: org,
      recipeIds: [first, second],
      batchKg: 250,
    })
  ).json();
  expect(result.versions[0].profile.revision).toBe(1);
  expect(result.versions[0].allocations[0].reference.price).toBe("100.0000");
  expect(result.versions[0].costPerKg).toBe("100.0000");
});
it("refuses incomplete historical evidence without modifying the saved record", async () => {
  const broken = (
    await tenant(owner, (c) =>
      c.query(
        "INSERT INTO formula_versions(organization_id,name,batch_kg,lines,ingredient_snapshot,result) VALUES($1,'Historical incomplete fixture',100,'[]','[]','{}') RETURNING id",
        [org],
      ),
    )
  ).rows[0].id;
  await expect(exportReport(owner, org, broken)).rejects.toMatchObject({
    status: 422,
  });
  expect(
    (
      await tenant(owner, (c) =>
        c.query("SELECT result FROM formula_versions WHERE id=$1", [broken]),
      )
    ).rows[0].result,
  ).toEqual({});
});
