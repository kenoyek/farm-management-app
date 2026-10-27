import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { admin } from "./admin-db";
import { pool, tenant } from "../src/lib/db";
import { saveDraft } from "../src/lib/draft-api";
import { draftContent } from "../src/lib/draft-schema";
import { EMPTY_DRAFT } from "../src/lib/draft-controller";
let owner: string,
  other: string,
  editor: string,
  auditor: string,
  org: string,
  foreignOrg: string,
  ingredient: string,
  foreignIngredient: string;
beforeAll(async () => {
  const users = [];
  for (let i = 0; i < 4; i++)
    users.push(
      (
        await admin.query(
          "INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id",
          [`${randomUUID()}@test.invalid`, "fixture"],
        )
      ).rows[0].id,
    );
  [owner, other, editor, auditor] = users;
  org = await tenant(
    owner,
    async (c) =>
      (await c.query("SELECT create_organization('Draft tests') AS id")).rows[0]
        .id,
  );
  foreignOrg = await tenant(
    other,
    async (c) =>
      (await c.query("SELECT create_organization('Foreign draft tests') AS id"))
        .rows[0].id,
  );
  await admin.query(
    "INSERT INTO memberships VALUES($1,$2,'admin'),($1,$3,'auditor')",
    [org, editor, auditor],
  );
  ingredient = (
    await tenant(owner, (c) =>
      c.query(
        "INSERT INTO ingredients(organization_id,name,source,nutrients) VALUES($1,'Draft reference','source','{}') RETURNING id",
        [org],
      ),
    )
  ).rows[0].id;
  foreignIngredient = (
    await tenant(other, (c) =>
      c.query(
        "INSERT INTO ingredients(organization_id,name,source,nutrients) VALUES($1,'Foreign reference','source','{}') RETURNING id",
        [foreignOrg],
      ),
    )
  ).rows[0].id;
});
afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])", [
    [org, foreignOrg],
  ]);
  await admin.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
    [owner, other, editor, auditor],
  ]);
  await pool.end();
  await admin.end();
});
it("persists incomplete drafts separately from immutable recipe versions", async () => {
  const content = {
    ...EMPTY_DRAFT,
    name: "",
    batchKg: 0,
    lines: [{ ingredientId: ingredient, percent: 140 }],
  };
  const saved = await tenant(owner, (c) => saveDraft(c, org, 0, content));
  expect(saved.revision).toBe(1);
  expect(saved.content).toEqual(content);
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
it("hides private draft contents from other members, auditors and outsiders", async () => {
  expect(
    (
      await tenant(owner, (c) =>
        c.query("SELECT * FROM formulation_drafts WHERE organization_id=$1", [
          org,
        ]),
      )
    ).rowCount,
  ).toBe(1);
  for (const user of [editor, auditor, other])
    expect(
      (
        await tenant(user, (c) =>
          c.query("SELECT * FROM formulation_drafts WHERE organization_id=$1", [
            org,
          ]),
        )
      ).rowCount,
    ).toBe(0);
  await tenant(editor, (c) =>
    saveDraft(c, org, 0, { ...EMPTY_DRAFT, name: "Other editor" }),
  );
  expect(
    (
      await tenant(owner, (c) =>
        c.query(
          "SELECT content FROM formulation_drafts WHERE organization_id=$1",
          [org],
        ),
      )
    ).rows[0].content.name,
  ).toBe("");
});
it("rejects stale updates and concurrent tab writes instead of overwriting", async () => {
  await expect(
    tenant(owner, (c) => saveDraft(c, org, 0, EMPTY_DRAFT)),
  ).rejects.toMatchObject({ status: 409 });
  const attempts = await Promise.allSettled(
    ["Tab A", "Tab B"].map((name) =>
      tenant(owner, (c) => saveDraft(c, org, 1, { ...EMPTY_DRAFT, name })),
    ),
  );
  expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const failure = attempts.find((r) => r.status === "rejected");
  expect(failure?.status === "rejected" && failure.reason.status).toBe(409);
  expect(
    (
      await tenant(owner, (c) =>
        c.query(
          "SELECT revision FROM formulation_drafts WHERE organization_id=$1",
          [org],
        ),
      )
    ).rows[0].revision,
  ).toBe(2);
});
it("rejects foreign references and never accepts status or approval fields", async () => {
  await expect(
    tenant(owner, (c) =>
      saveDraft(c, org, 2, {
        ...EMPTY_DRAFT,
        lines: [{ ingredientId: foreignIngredient, percent: 100 }],
      }),
    ),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    tenant(owner, (c) =>
      saveDraft(c, org, 2, { ...EMPTY_DRAFT, profileId: randomUUID() }),
    ),
  ).rejects.toMatchObject({ status: 400 });
  expect(
    draftContent.safeParse({ ...EMPTY_DRAFT, status: "approved" }).success,
  ).toBe(false);
  expect(
    draftContent.safeParse({
      ...EMPTY_DRAFT,
      result: { releaseEligible: true },
    }).success,
  ).toBe(false);
});
it("denies auditors, outsiders, impersonation and edits after losing the editor role", async () => {
  await expect(
    tenant(auditor, (c) => saveDraft(c, org, 0, EMPTY_DRAFT)),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    tenant(other, (c) => saveDraft(c, org, 0, EMPTY_DRAFT)),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    tenant(owner, (c) =>
      c.query(
        "INSERT INTO formulation_drafts(organization_id,actor_id,content) VALUES($1,$2,$3)",
        [org, editor, JSON.stringify(EMPTY_DRAFT)],
      ),
    ),
  ).rejects.toMatchObject({ code: "42501" });
  await admin.query(
    "UPDATE memberships SET role='auditor' WHERE organization_id=$1 AND user_id=$2",
    [org, editor],
  );
  await expect(
    tenant(editor, (c) => saveDraft(c, org, 1, EMPTY_DRAFT)),
  ).rejects.toMatchObject({ status: 403 });
});
it("enforces the model version and draft-only content at the database boundary", async () => {
  for (const content of [
    {},
    { ...EMPTY_DRAFT, status: "approved" },
    { ...EMPTY_DRAFT, modelVersion: 2 },
  ])
    await expect(
      tenant(other, (c) =>
        c.query(
          "INSERT INTO formulation_drafts(organization_id,content) VALUES($1,$2)",
          [foreignOrg, JSON.stringify(content)],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
});
it("rejects a draft write if the browser account changed since loading", async () => {
  const { NextRequest } = await import("next/server");
  const { draftApi } = await import("../src/lib/draft-api");
  const request = new NextRequest("http://localhost/api/formulation-draft", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: org,
      actorId: owner,
      expectedRevision: 0,
      content: EMPTY_DRAFT,
    }),
  });
  await expect(
    draftApi(request, { id: other }, "formulation-draft"),
  ).rejects.toMatchObject({ status: 401 });
});
