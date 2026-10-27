import type { PoolClient } from "pg";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { workbookCatalog } from "./workbook-catalog";
import { tenant, audit } from "./db";
import { id } from "./validation";
import { fail, jsonBody } from "./http";
export async function stageCatalog(c: PoolClient, org: string, job: string) {
  const saved = (
    await c.query(
      "SELECT source_hashes FROM imports WHERE organization_id=$1 AND id=$2",
      [org, job],
    )
  ).rows[0];
  const expected = workbookCatalog()[0].source_hash;
  if (
    !Array.isArray(saved?.source_hashes) ||
    !saved.source_hashes.some(
      (s: { file?: string; sha256?: string }) =>
        s.file === "Feed Formula Calculator.xlsx" && s.sha256 === expected,
    )
  )
    fail(
      409,
      "The confirmed import does not match this source workbook version.",
    );
  let count = 0;
  for (const row of workbookCatalog()) {
    const r = await c.query(
      "INSERT INTO import_reference_rows(organization_id,import_id,source_hash,sheet,source_row,category,label,context,fields,issues) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(organization_id,source_hash,sheet,source_row,context) DO NOTHING",
      [
        org,
        job,
        row.source_hash,
        row.sheet,
        row.source_row,
        row.category,
        row.label,
        row.context,
        JSON.stringify(row.fields),
        JSON.stringify(row.issues),
      ],
    );
    count += r.rowCount ?? 0;
  }
  if (count) await audit(c, org, "source_catalog.staged", job);
  return count;
}
export async function catalogApi(
  request: NextRequest,
  user: { id: string },
  path: string,
) {
  if (path === "imports/catalog" && request.method === "GET") {
    const org = id.parse(request.nextUrl.searchParams.get("organizationId"));
    return NextResponse.json(
      await tenant(
        user.id,
        async (c) =>
          (
            await c.query(
              "SELECT * FROM import_reference_rows WHERE organization_id=$1 ORDER BY category,sheet,source_row,context",
              [org],
            )
          ).rows,
      ),
    );
  }
  if (path === "imports/catalog" && request.method === "POST") {
    const input = z
      .object({ organizationId: id, confirmed: z.literal(true) })
      .parse(await jsonBody(request));
    return NextResponse.json(
      await tenant(user.id, async (c) => {
        if (
          !["owner", "admin", "nutritionist"].includes(
            (
              await c.query("SELECT member_role($1) AS role", [
                input.organizationId,
              ])
            ).rows[0].role,
          )
        )
          fail(403, "Only feed editors can stage source references.");
        await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          input.organizationId,
        ]);
        const job = (
          await c.query(
            "SELECT id FROM imports WHERE organization_id=$1 ORDER BY created_at LIMIT 1",
            [input.organizationId],
          )
        ).rows[0];
        if (!job)
          fail(
            409,
            "Preview and confirm the original workbooks before staging the source catalog.",
          );
        return { count: await stageCatalog(c, input.organizationId, job.id) };
      }),
    );
  }
  return null;
}
