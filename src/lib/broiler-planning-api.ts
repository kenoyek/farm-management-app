import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { PoolClient } from "pg";
import { tenant, audit } from "./db";
import { fail, jsonBody } from "./http";
import {
  broilerPlanInput,
  broilerPlanModel,
  projectBroilerPlan,
  planCsv,
  type PlanRow,
  type PlanUnit,
  type BroilerPlanData,
  type RecipeLink,
} from "./broiler-planning";
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
function report(source: PlanRow) {
  if (source.model_version !== broilerPlanModel)
    fail(422, "This planning model is not supported by this release.");
  try {
    const forecast = projectBroilerPlan(source.input, source.unit_snapshot);
    return {
      source,
      forecast,
      evidenceSha256: createHash("sha256")
        .update(JSON.stringify({ source, forecast }))
        .digest("hex"),
    };
  } catch {
    fail(
      422,
      "The saved plan has incomplete source evidence. Its historical input has not been changed.",
    );
  }
}
async function unit(c: PoolClient, org: string, id: string): Promise<PlanUnit> {
  const r = (
    await c.query(
      "SELECT to_jsonb(u)||jsonb_build_object('stocked_on',u.stocked_on::text,'initial_weight_g',u.initial_weight_g::text) AS unit FROM production_units u WHERE u.organization_id=$1 AND u.id=$2 AND u.kind='broilers'",
      [org, id],
    )
  ).rows[0];
  if (!r) fail(404, "Broiler batch not found.");
  return r.unit;
}
async function recipes(
  c: PoolClient,
  org: string,
  p: BroilerPlanData,
): Promise<RecipeLink[]> {
  const ids = [
    ...new Set(
      p.stages.map((s) => s.recipeId).filter((id): id is string => id !== null),
    ),
  ];
  if (!ids.length) return [];
  const rows = (
    await c.query(
      "SELECT v.id,v.name,v.status,v.batch_kg::text,v.profile_id,r.species,r.stage FROM formula_versions v LEFT JOIN requirement_profiles r ON r.id=v.profile_id AND r.organization_id=v.organization_id WHERE v.organization_id=$1 AND v.id=ANY($2::uuid[])",
      [org, ids],
    )
  ).rows;
  if (rows.length !== ids.length)
    fail(404, "A referenced saved recipe is unavailable.");
  if (rows.some((r) => r.status === "rejected" || r.species === "catfish"))
    fail(
      400,
      "Rejected or catfish recipes cannot be referenced for poultry planning.",
    );
  return rows;
}
export async function broilerPlanningApi(
  request: NextRequest,
  user: { id: string },
  path: string,
) {
  if (!["broilers/plans", "broilers/plans/preview"].includes(path)) return null;
  if (path === "broilers/plans" && request.method === "GET") {
    const org = z
        .uuid()
        .parse(request.nextUrl.searchParams.get("organizationId")),
      id = z.uuid().parse(request.nextUrl.searchParams.get("unitId")),
      selectedId = z
        .uuid()
        .nullable()
        .parse(request.nextUrl.searchParams.get("planId")),
      format = z
        .enum(["workspace", "json", "csv"])
        .parse(request.nextUrl.searchParams.get("format") ?? "workspace");
    const result = await tenant(user.id, async (c) => {
      const u = await unit(c, org, id),
        o = (
          await c.query(
            "SELECT currency,timezone,(now() AT TIME ZONE timezone)::date::text AS today FROM organizations WHERE id=$1",
            [org],
          )
        ).rows[0];
      const history = (
        await c.query(
          "SELECT id,revision,input->>'name' AS name,created_at FROM broiler_plans WHERE organization_id=$1 AND unit_id=$2 ORDER BY revision DESC LIMIT 101",
          [org, id],
        )
      ).rows;
      if (history.length > 100)
        fail(422, "This batch exceeds the planning history limit.");
      const planId = selectedId ?? history[0]?.id;
      let selected = null;
      if (planId) {
        const row = (
          await c.query(
            "SELECT to_jsonb(p) AS source FROM broiler_plans p WHERE p.organization_id=$1 AND p.unit_id=$2 AND p.id=$3",
            [org, id, planId],
          )
        ).rows[0];
        if (!row) fail(404, "Saved planning version not found.");
        selected = report(row.source);
      }
      if (format !== "workspace") {
        if (!selectedId || !selected)
          fail(400, "Choose an exact saved planning version for export.");
        return { selected };
      }
      const links = (
        await c.query(
          "SELECT v.id,v.name,v.status,v.batch_kg::text,v.profile_id,r.species,r.stage FROM formula_versions v LEFT JOIN requirement_profiles r ON r.id=v.profile_id AND r.organization_id=v.organization_id WHERE v.organization_id=$1 AND v.status<>'rejected' AND r.species IS DISTINCT FROM 'catfish' ORDER BY v.created_at DESC,v.id LIMIT 200",
          [org],
        )
      ).rows;
      const actual = (
        await c.query(
          "SELECT recorded_on::text,feed_kg::text,average_weight_g::text,sample_size FROM effective_daily_records WHERE organization_id=$1 AND unit_id=$2 ORDER BY recorded_on LIMIT 10001",
          [org, id],
        )
      ).rows;
      if (actual.length > 10000)
        fail(422, "This batch exceeds the actual-record comparison limit.");
      const all = new Map(
        [...links, ...(selected?.source.recipe_snapshots ?? [])].map((r) => [
          r.id,
          r,
        ]),
      );
      return {
        unit: u,
        ...o,
        history,
        selected,
        recipes: [...all.values()],
        actualRecords: actual,
      };
    });
    if (format === "workspace") return NextResponse.json(result, { headers });
    const r = result.selected!;
    const common = {
      ...headers,
      "X-Evidence-SHA256": r.evidenceSha256,
      "Content-Disposition": `attachment; filename="broiler-plan-${r.source.id}.${format}"`,
    };
    return format === "json"
      ? NextResponse.json(r, { headers: common })
      : new NextResponse(planCsv(r), {
          headers: { ...common, "Content-Type": "text/csv; charset=utf-8" },
        });
  }
  if (request.method !== "POST") return null;
  const p = broilerPlanInput.parse(await jsonBody(request));
  const result = await tenant(user.id, async (c) => {
    if (path === "broilers/plans") {
      const role = (
        await c.query("SELECT member_role($1) AS role", [p.organizationId])
      ).rows[0].role;
      if (!["owner", "admin", "manager"].includes(role))
        fail(
          403,
          "Only an owner, administrator or manager can save a broiler plan.",
        );
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [p.unitId]);
      const old = (
        await c.query(
          "SELECT to_jsonb(v) AS source,organization_id=$2 AND unit_id=$3 AND previous_id IS NOT DISTINCT FROM $4::uuid AND input=$5::jsonb AS same FROM broiler_plans v WHERE id=$1",
          [
            p.planId,
            p.organizationId,
            p.unitId,
            p.previousId,
            JSON.stringify(p.data),
          ],
        )
      ).rows[0];
      if (old) {
        if (!old.same)
          fail(409, "This plan receipt was already used for different values.");
        return { ...report(old.source), replayed: true };
      }
    }
    const u = await unit(c, p.organizationId, p.unitId);
    let forecast;
    try {
      forecast = projectBroilerPlan(p.data, u);
    } catch {
      fail(
        400,
        "Hatch date and placement age must match the original stocking date.",
      );
    }
    const links = await recipes(c, p.organizationId, p.data);
    if (path === "broilers/plans/preview")
      return { forecast, unit: u, input: p.data, recipes: links };
    const head = (
      await c.query(
        "SELECT id,revision FROM broiler_plans WHERE unit_id=$1 ORDER BY revision DESC LIMIT 1",
        [p.unitId],
      )
    ).rows[0];
    if ((head?.id ?? null) !== p.previousId)
      fail(
        409,
        "A newer planning version exists. Keep a copy of your inputs, reload history and review before saving.",
      );
    if (head?.revision >= 100)
      fail(422, "This batch reached the 100-version planning limit.");
    const row = (
      await c.query(
        "INSERT INTO broiler_plans(id,organization_id,unit_id,previous_id,input) VALUES($1,$2,$3,$4,$5) RETURNING to_jsonb(broiler_plans) AS source",
        [
          p.planId,
          p.organizationId,
          p.unitId,
          p.previousId,
          JSON.stringify(p.data),
        ],
      )
    ).rows[0];
    await audit(c, p.organizationId, "broiler.plan_saved", p.planId);
    return { ...report(row.source), replayed: false };
  });
  return NextResponse.json(result, {
    status: "source" in result && !result.replayed ? 201 : 200,
    headers,
  });
}
