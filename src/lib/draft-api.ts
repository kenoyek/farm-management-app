import type { PoolClient } from "pg";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { tenant, audit } from "./db";
import { id } from "./validation";
import { draftContent, type SavedDraft } from "./draft-schema";
import { fail, jsonBody } from "./http";
async function authorize(c: PoolClient, org: string) {
  const role = (await c.query("SELECT member_role($1) AS role", [org])).rows[0]
    .role;
  if (!["owner", "admin", "nutritionist"].includes(role))
    fail(403, "Draft access requires a feed editor role in this organization.");
}
export async function saveDraft(
  c: PoolClient,
  org: string,
  expectedRevision: number,
  raw: unknown,
): Promise<SavedDraft> {
  const content = draftContent.parse(raw);
  await authorize(c, org);
  const ids = [
    ...new Set(content.lines.map((l) => l.ingredientId).filter(Boolean)),
  ];
  if (
    ids.length !==
    (
      await c.query(
        "SELECT id FROM ingredients WHERE organization_id=$1 AND id=ANY($2::uuid[])",
        [org, ids],
      )
    ).rowCount
  )
    fail(400, "Draft ingredients must belong to this organization.");
  for (const [table, reference] of [
    ["requirement_profiles", content.profileId],
    ["formula_versions", content.parentId],
  ] as const) {
    if (
      reference &&
      !(
        await c.query(
          `SELECT id FROM ${table} WHERE organization_id=$1 AND id=$2`,
          [org, reference],
        )
      ).rowCount
    )
      fail(400, "Draft references must belong to this organization.");
  }
  const result =
    expectedRevision === 0
      ? await c.query(
          "INSERT INTO formulation_drafts(organization_id,content) VALUES($1,$2) ON CONFLICT(organization_id,actor_id) DO NOTHING RETURNING id,content,revision,updated_at",
          [org, JSON.stringify(content)],
        )
      : await c.query(
          "UPDATE formulation_drafts SET content=$2,revision=revision+1,updated_at=now() WHERE organization_id=$1 AND actor_id=current_actor() AND revision=$3 RETURNING id,content,revision,updated_at",
          [org, JSON.stringify(content), expectedRevision],
        );
  if (!result.rowCount)
    fail(
      409,
      "This draft changed in another tab. Your local edits have been kept. Load the saved draft or download your local copy.",
    );
  const saved = result.rows[0];
  await audit(c, org, "formulation_draft.saved", saved.id);
  return saved;
}
export async function draftApi(
  request: NextRequest,
  user: { id: string },
  path: string,
) {
  if (path !== "formulation-draft") return null;
  if (request.method === "GET") {
    const org = id.parse(request.nextUrl.searchParams.get("organizationId"));
    return NextResponse.json(
      await tenant(user.id, async (c) => {
        await authorize(c, org);
        return {
          actorId: user.id,
          draft:
            (
              await c.query(
                "SELECT id,content,revision,updated_at FROM formulation_drafts WHERE organization_id=$1 AND actor_id=current_actor()",
                [org],
              )
            ).rows[0] ?? null,
        };
      }),
    );
  }
  if (request.method === "POST") {
    const input = z
      .object({
        organizationId: id,
        actorId: id,
        expectedRevision: z.number().int().min(0).max(2147483646),
        content: draftContent,
      })
      .strict()
      .parse(await jsonBody(request));
    if (input.actorId !== user.id)
      fail(
        401,
        "The signed-in account changed. Reload the application before saving this draft.",
      );
    return NextResponse.json(
      await tenant(user.id, (c) =>
        saveDraft(
          c,
          input.organizationId,
          input.expectedRevision,
          input.content,
        ),
      ),
    );
  }
  fail(405, "Method not allowed.");
}
