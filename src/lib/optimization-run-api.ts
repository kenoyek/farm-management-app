import { optimizationComparisonApi } from "./optimization-comparison-api";
import { NextRequest, NextResponse } from "next/server";
import { tenant } from "./db";
import { id } from "./validation";
import { fail } from "./http";
import {
  runSummary,
  outcomeView,
  historicalDraft,
  hasReferenceSnapshots,
} from "./optimization-history";

export async function optimizationRunApi(
  request: NextRequest,
  user: { id: string },
  path: string,
) {
  const comparison = await optimizationComparisonApi(request, user, path);
  if (comparison) return comparison;
  const match = /^optimization-runs(?:\/([^/]+))?$/.exec(path);
  if (!match || request.method !== "GET") return null;
  const org = id.parse(request.nextUrl.searchParams.get("organizationId"));
  const runId = match[1] ? id.parse(match[1]) : null;
  const data = await tenant(user.id, async (c) => {
    if (!runId)
      return (
        await c.query(
          "SELECT id,created_at,jsonb_build_object('name',request->'name','profileSnapshot',jsonb_build_object('name',request->'profileSnapshot'->'name')) AS request,jsonb_build_object('status',result->'status','solver',result->'solver','message',result->'message','calculation',jsonb_build_object('costPerKg',result->'calculation'->'costPerKg')) AS result FROM optimization_runs WHERE organization_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100",
          [org],
        )
      ).rows.map(runSummary);
    const record = (
      await c.query(
        "SELECT * FROM optimization_runs WHERE organization_id=$1 AND id=$2",
        [org, runId],
      )
    ).rows[0];
    if (!record) fail(404, "Optimization run not found.");
    let restoration = historicalDraft(record.request, record.result);
    if (restoration) {
      const draft = restoration.content;
      const ingredients = await c.query(
        "SELECT id FROM ingredients WHERE organization_id=$1 AND id=ANY($2::uuid[])",
        [org, draft.lines.map((l) => l.ingredientId)],
      );
      const profile = await c.query(
        "SELECT id FROM requirement_profiles WHERE organization_id=$1 AND id=$2",
        [org, draft.profileId],
      );
      const parent = draft.parentId
        ? await c.query(
            "SELECT id FROM formula_versions WHERE organization_id=$1 AND id=$2",
            [org, draft.parentId],
          )
        : null;
      if (
        ingredients.rowCount !== draft.lines.length ||
        !profile.rowCount ||
        (parent && !parent.rowCount)
      )
        restoration = null;
    }
    return {
      record,
      summary: runSummary(record),
      view: outcomeView(record.result),
      hasReferenceSnapshots: hasReferenceSnapshots(record.request),
      restoration,
    };
  });
  return NextResponse.json(data, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
