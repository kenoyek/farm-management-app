import { beforeAll, afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { admin } from "./admin-db";
import { pool, tenant } from "../src/lib/db";
import { stageCatalog, catalogApi } from "../src/lib/catalog-api";
import { aliasReviewInput } from "../src/lib/catalog-review";
import books from "../data/workbook-audit.json";

let owner: string, reviewer: string, auditor: string, outsider: string;
let org: string,
  foreignOrg: string,
  ingredient: string,
  foreignIngredient: string;
let source: string,
  restriction: string,
  requirement: string,
  foreignSource: string,
  recipe: string;
const evidence =
  "Synthetic identity review evidence only, not agricultural guidance";
const body = (
  expectedRevision = 0,
  decision = "mapped",
  ingredientId: string | null = ingredient,
) => ({
  organizationId: org,
  expectedRevision,
  decision,
  ingredientId,
  evidence,
  confirmed: true,
});
async function call(actor: string, row: string, data?: unknown, target = org) {
  const path = `imports/catalog/${row}/reviews`;
  return (await catalogApi(
    new NextRequest(
      `http://localhost/api/${path}?organizationId=${target}`,
      data === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          },
    ),
    { id: actor },
    path,
  ))!;
}
async function raw(
  actor: string,
  row: string,
  target = org,
  targetIngredient: string | null = ingredient,
  decision = "mapped",
  revision = 1,
  parent: string | null = null,
  author = actor,
) {
  return tenant(actor, (c) =>
    c.query(
      "INSERT INTO catalog_alias_reviews(organization_id,source_row_id,ingredient_id,decision,evidence,revision,parent_id,reviewer_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
      [
        target,
        row,
        targetIngredient,
        decision,
        evidence,
        revision,
        parent,
        author,
      ],
    ),
  );
}
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
      (await c.query("SELECT create_organization('Alias review tests') AS id"))
        .rows[0].id,
  );
  foreignOrg = await tenant(
    outsider,
    async (c) =>
      (await c.query("SELECT create_organization('Other alias tests') AS id"))
        .rows[0].id,
  );
  await admin.query(
    "INSERT INTO memberships VALUES($1,$2,'nutritionist'),($1,$3,'auditor'),($4,$2,'nutritionist')",
    [org, reviewer, auditor, foreignOrg],
  );
  for (const target of [org, foreignOrg]) {
    const actor = target === org ? owner : outsider;
    await tenant(actor, async (c) => {
      const job = (
        await c.query(
          "INSERT INTO imports(organization_id,source_hashes,raw_data) VALUES($1,$2,'[]') RETURNING id",
          [
            target,
            JSON.stringify(
              books.map((w) => ({ file: w.file, sha256: w.sha256 })),
            ),
          ],
        )
      ).rows[0].id;
      await stageCatalog(c, target, job);
    });
  }
  const rows = (
    await tenant(owner, (c) =>
      c.query(
        "SELECT id,category,sheet FROM import_reference_rows WHERE organization_id=$1 AND label='Limestone' ORDER BY sheet,context",
        [org],
      ),
    )
  ).rows;
  source = rows.find((r) => r.sheet === "Broiler Starter").id;
  restriction = (
    await tenant(owner, (c) =>
      c.query(
        "SELECT id FROM import_reference_rows WHERE organization_id=$1 AND category='restriction' LIMIT 1",
        [org],
      ),
    )
  ).rows[0].id;
  requirement = (
    await tenant(owner, (c) =>
      c.query(
        "SELECT id FROM import_reference_rows WHERE organization_id=$1 AND category='requirement' LIMIT 1",
        [org],
      ),
    )
  ).rows[0].id;
  foreignSource = (
    await tenant(outsider, (c) =>
      c.query(
        "SELECT id FROM import_reference_rows WHERE organization_id=$1 AND category='recipe' LIMIT 1",
        [foreignOrg],
      ),
    )
  ).rows[0].id;
  ingredient = (
    await tenant(owner, (c) =>
      c.query(
        "INSERT INTO ingredients(organization_id,name,source,nutrients,price) VALUES($1,'Synthetic limestone reference',$2,'{\"protein\":null}',250) RETURNING id",
        [org, evidence],
      ),
    )
  ).rows[0].id;
  foreignIngredient = (
    await tenant(outsider, (c) =>
      c.query(
        "INSERT INTO ingredients(organization_id,name,source,nutrients) VALUES($1,'Foreign identity reference',$2,'{}') RETURNING id",
        [foreignOrg, evidence],
      ),
    )
  ).rows[0].id;
  recipe = (
    await tenant(owner, (c) =>
      c.query(
        "INSERT INTO formula_versions(organization_id,name,batch_kg,lines,ingredient_snapshot,result) VALUES($1,'Historical identity fixture',100,'[]',$2,'{}') RETURNING id",
        [
          org,
          JSON.stringify([
            {
              id: ingredient,
              name: "Synthetic limestone reference",
              price: "250.0000",
            },
          ]),
        ],
      ),
    )
  ).rows[0].id;
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
it("requires explicit confirmation, evidence and exact UUIDs without accepting claimed reviewers", () => {
  expect(aliasReviewInput.parse(body()).ingredientId).toBe(ingredient);
  for (const data of [
    body(0, "mapped", null),
    body(0, "rejected"),
    { ...body(), confirmed: false },
    { ...body(), evidence: "   " },
    { ...body(), reviewerId: owner },
    { ...body(), expectedRevision: 0.5 },
  ])
    expect(aliasReviewInput.safeParse(data).success).toBe(false);
  expect(
    aliasReviewInput.parse(body(0, "unresolved", null)).ingredientId,
  ).toBeNull();
});
it("records a scoped identity decision without changing raw warnings, approval or recipe history", async () => {
  const before = (
    await tenant(owner, (c) =>
      c.query("SELECT * FROM import_reference_rows WHERE id=$1", [source]),
    )
  ).rows[0];
  const response = await call(reviewer, source, body());
  expect(response.status).toBe(201);
  const saved = await response.json();
  expect(saved).toMatchObject({
    decision: "mapped",
    ingredient_id: ingredient,
    reviewer_id: reviewer,
    revision: 1,
    parent_id: null,
  });
  expect(
    (
      await tenant(owner, (c) =>
        c.query("SELECT * FROM import_reference_rows WHERE id=$1", [source]),
      )
    ).rows[0],
  ).toEqual(before);
  expect(
    (
      await tenant(owner, (c) =>
        c.query("SELECT review_status,nutrients FROM ingredients WHERE id=$1", [
          ingredient,
        ]),
      )
    ).rows[0],
  ).toEqual({ review_status: "unverified", nutrients: { protein: null } });
  expect(
    (
      await tenant(owner, (c) =>
        c.query(
          "SELECT ingredient_snapshot FROM formula_versions WHERE id=$1",
          [recipe],
        ),
      )
    ).rows[0].ingredient_snapshot[0],
  ).toMatchObject({ id: ingredient, price: "250.0000" });
  expect(
    (
      await tenant(owner, (c) =>
        c.query(
          "SELECT object_id FROM audit_logs WHERE organization_id=$1 AND action='source_alias.reviewed'",
          [org],
        ),
      )
    ).rows,
  ).toContainEqual({ object_id: saved.id });
  const otherContexts = (
    await tenant(owner, (c) =>
      c.query("SELECT * FROM catalog_alias_reviews WHERE source_row_id=$1", [
        restriction,
      ]),
    )
  ).rowCount;
  expect(otherContexts).toBe(0);
});
it("returns actual member-visible history and latest decisions while denying outsiders", async () => {
  expect((await (await call(auditor, source)).json()).reviews).toHaveLength(1);
  const list = (await catalogApi(
    new NextRequest(
      `http://localhost/api/imports/catalog?organizationId=${org}`,
    ),
    { id: owner },
    "imports/catalog",
  ))!;
  expect(
    (await list.json()).find((r: { id: string }) => r.id === source)
      .alias_review,
  ).toMatchObject({ revision: 1, ingredient_id: ingredient });
  await expect(call(outsider, source)).rejects.toMatchObject({ status: 404 });
  await expect(call(outsider, source, body())).rejects.toMatchObject({
    status: 404,
  });
  expect(
    (
      await tenant(outsider, (c) =>
        c.query(
          "SELECT * FROM catalog_alias_reviews WHERE organization_id=$1",
          [org],
        ),
      )
    ).rowCount,
  ).toBe(0);
});
it("enforces assigned reviewer, eligible source kinds and same-tenant foreign keys even for direct inserts", async () => {
  for (const actor of [owner, auditor, outsider])
    await expect(raw(actor, restriction)).rejects.toMatchObject({
      code: "42501",
    });
  await expect(
    raw(reviewer, restriction, org, ingredient, "mapped", 1, null, owner),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(call(owner, restriction, body())).rejects.toMatchObject({
    status: 403,
  });
  await expect(call(reviewer, requirement, body())).rejects.toMatchObject({
    status: 400,
  });
  await expect(raw(reviewer, requirement)).rejects.toMatchObject({
    code: "23514",
  });
  await expect(
    call(reviewer, restriction, body(0, "mapped", foreignIngredient)),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    raw(reviewer, restriction, org, foreignIngredient),
  ).rejects.toMatchObject({ code: "23503" });
  await expect(raw(reviewer, foreignSource)).rejects.toMatchObject({
    code: "23503",
  });
  await expect(
    raw(reviewer, restriction, org, null, "mapped"),
  ).rejects.toMatchObject({ code: "23514" });
});
it("preserves immutable decisions and serializes competing review revisions", async () => {
  const responses = await Promise.allSettled([
    call(reviewer, source, body(1, "rejected", null)),
    call(reviewer, source, body(1, "unresolved", null)),
  ]);
  expect(responses.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(responses.find((r) => r.status === "rejected")).toMatchObject({
    reason: { status: 409 },
  });
  const { reviews } = await (await call(owner, source)).json();
  expect(reviews.map((r: { revision: number }) => r.revision)).toEqual([2, 1]);
  expect(reviews[1].decision).toBe("mapped");
  expect(reviews[0].parent_id).toBe(reviews[1].id);
  for (const sql of [
    "UPDATE catalog_alias_reviews SET evidence='forged evidence' WHERE id=$1",
    "DELETE FROM catalog_alias_reviews WHERE id=$1",
  ])
    await expect(
      tenant(reviewer, (c) => c.query(sql, [reviews[0].id])),
    ).rejects.toMatchObject({ code: "42501" });
  await expect(
    raw(reviewer, source, org, ingredient, "mapped", 2, reviews[1].id),
  ).rejects.toMatchObject({ code: "23505" });
});
it("does not carry a mapping to an ingredient revision or another source context", async () => {
  const mapped = await (await call(reviewer, restriction, body())).json();
  const next = (
    await tenant(owner, (c) =>
      c.query(
        "INSERT INTO ingredients(organization_id,parent_id,revision,name,source,nutrients,price) VALUES($1,$2,2,'New identity quote',$3,'{}',500) RETURNING id",
        [org, ingredient, evidence],
      ),
    )
  ).rows[0].id;
  expect(
    (await (await call(owner, restriction)).json()).reviews[0].ingredient_id,
  ).toBe(ingredient);
  const revision = await (
    await call(reviewer, restriction, body(1, "mapped", next))
  ).json();
  expect(revision).toMatchObject({
    ingredient_id: next,
    revision: 2,
    parent_id: mapped.id,
  });
  expect(
    (await (await call(owner, restriction)).json()).reviews[1].ingredient_id,
  ).toBe(ingredient);
});
it("blocks direct concurrent initial reviews and forbids cross-source lineage", async () => {
  const rows = (
    await tenant(owner, (c) =>
      c.query(
        "SELECT id FROM import_reference_rows WHERE organization_id=$1 AND category='recipe' AND id<>$2 LIMIT 2",
        [org, source],
      ),
    )
  ).rows;
  const results = await Promise.allSettled([
    raw(reviewer, rows[0].id),
    raw(reviewer, rows[0].id),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { code: "23505" },
  });
  const latest = (await (await call(owner, rows[0].id)).json()).reviews[0];
  await expect(
    raw(reviewer, rows[1].id, org, ingredient, "mapped", 2, latest.id),
  ).rejects.toMatchObject({ code: "23514" });
});
