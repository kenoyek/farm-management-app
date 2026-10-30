import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { z } from "zod";
import { tenant, audit } from "./db";
import { fail, jsonBody } from "./http";
import {
  economicsInput,
  economicsModel,
  projectEconomics,
  compareEconomics,
  economicsCsv,
  type EconomicsRow,
  type EconomicsReport,
} from "./broiler-economics";
import {
  broilerPlanModel,
  projectBroilerPlan,
  type PlanRow,
} from "./broiler-planning";
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function report(source: EconomicsRow): EconomicsReport {
  if (
    source.model_version !== economicsModel ||
    source.plan_snapshot.model_version !== broilerPlanModel
  )
    fail(422, "This economic or source planning model is not supported.");
  try {
    const planSource = source.plan_snapshot,
      forecast = projectBroilerPlan(planSource.input, planSource.unit_snapshot);
    const plan = {
      source: planSource,
      forecast,
      evidenceSha256: digest({ source: planSource, forecast }),
    };
    const economics = projectEconomics(source.input, planSource);
    return {
      source,
      plan,
      economics,
      evidenceSha256: digest({ source, plan, economics }),
    };
  } catch {
    fail(
      422,
      "This saved scenario has incomplete source evidence. Its original input has not been changed.",
    );
  }
}
async function unit(c: PoolClient, org: string, id: string) {
  if (
    !(
      await c.query(
        "SELECT 1 FROM production_units WHERE organization_id=$1 AND id=$2 AND kind='broilers'",
        [org, id],
      )
    ).rowCount
  )
    fail(404, "Broiler batch not found.");
}
async function plan(
  c: PoolClient,
  org: string,
  id: string,
  pid: string,
): Promise<PlanRow> {
  const r = (
    await c.query(
      "SELECT to_jsonb(p) AS source FROM broiler_plans p WHERE organization_id=$1 AND unit_id=$2 AND id=$3",
      [org, id, pid],
    )
  ).rows[0];
  if (!r) fail(404, "Choose an available saved plan for this batch.");
  return r.source;
}
export async function broilerEconomicsApi(
  request: NextRequest,
  user: { id: string },
  path: string,
) {
  if (
    ![
      "broilers/economics",
      "broilers/economics/preview",
      "broilers/economics/compare",
    ].includes(path)
  )
    return null;
  if (request.method === "GET") {
    if (path === "broilers/economics/preview") return null;
    const org = z
        .uuid()
        .parse(request.nextUrl.searchParams.get("organizationId")),
      id = z.uuid().parse(request.nextUrl.searchParams.get("unitId"));
    const format = z
      .enum(["workspace", "json", "csv"])
      .parse(request.nextUrl.searchParams.get("format") ?? "workspace");
    if (path === "broilers/economics/compare") {
      const ids = z
        .array(z.uuid())
        .min(2)
        .max(4)
        .refine((v) => new Set(v).size === v.length)
        .parse(request.nextUrl.searchParams.getAll("scenarioId"));
      const baseline = z
        .uuid()
        .parse(request.nextUrl.searchParams.get("baselineId"));
      const comparison = await tenant(user.id, async (c) => {
        await unit(c, org, id);
        const rows = (
          await c.query(
            "SELECT to_jsonb(s) AS source FROM broiler_economic_scenarios s WHERE organization_id=$1 AND unit_id=$2 AND id=ANY($3::uuid[])",
            [org, id, ids],
          )
        ).rows;
        if (rows.length !== ids.length)
          fail(404, "One or more saved scenarios are unavailable.");
        const reports = ids.map((id) =>
          report(rows.find((r) => r.source.id === id)!.source),
        );
        let result;
        try {
          result = compareEconomics(reports, baseline);
        } catch (e) {
          fail(400, (e as Error).message);
        }
        return { ...result, evidenceSha256: digest(result) };
      });
      const common = {
        ...headers,
        "X-Evidence-SHA256": comparison.evidenceSha256,
        "Content-Disposition": `attachment; filename="broiler-budget-comparison.${format === "csv" ? "csv" : "json"}"`,
      };
      return format === "csv"
        ? new NextResponse(economicsCsv(comparison), {
            headers: { ...common, "Content-Type": "text/csv; charset=utf-8" },
          })
        : NextResponse.json(comparison, { headers: common });
    }
    const selectedId = z
      .uuid()
      .nullable()
      .parse(request.nextUrl.searchParams.get("scenarioId"));
    const workspace = await tenant(user.id, async (c) => {
      await unit(c, org, id);
      const history = (
        await c.query(
          "SELECT id,revision,plan_id,input->>'name' AS name,created_at FROM broiler_economic_scenarios WHERE organization_id=$1 AND unit_id=$2 ORDER BY revision DESC LIMIT 101",
          [org, id],
        )
      ).rows;
      if (history.length > 100)
        fail(422, "This batch exceeds the 100-scenario history limit.");
      const sid = selectedId ?? history[0]?.id;
      let selected = null;
      if (sid) {
        const r = (
          await c.query(
            "SELECT to_jsonb(s) AS source FROM broiler_economic_scenarios s WHERE organization_id=$1 AND unit_id=$2 AND id=$3",
            [org, id, sid],
          )
        ).rows[0];
        if (!r) fail(404, "Saved scenario not found.");
        selected = report(r.source);
      }
      if (format !== "workspace" && (!selectedId || !selected))
        fail(400, "Choose an exact saved scenario for export.");
      const plans =
        format === "workspace"
          ? (
              await c.query(
                "SELECT id,revision,input->>'name' AS name,input->>'currency' AS currency FROM broiler_plans WHERE organization_id=$1 AND unit_id=$2 ORDER BY revision DESC LIMIT 100",
                [org, id],
              )
            ).rows
          : [];
      return { plans, history, selected };
    });
    if (format === "workspace")
      return NextResponse.json(workspace, { headers });
    const r = workspace.selected!,
      common = {
        ...headers,
        "X-Evidence-SHA256": r.evidenceSha256,
        "Content-Disposition": `attachment; filename="broiler-budget-${r.source.id}.${format}"`,
      };
    return format === "json"
      ? NextResponse.json(r, { headers: common })
      : new NextResponse(economicsCsv(r), {
          headers: { ...common, "Content-Type": "text/csv; charset=utf-8" },
        });
  }
  if (request.method !== "POST" || path === "broilers/economics/compare")
    return null;
  const p = economicsInput.parse(await jsonBody(request));
  const result = await tenant(user.id, async (c) => {
    const saving = path === "broilers/economics";
    if (saving) {
      const role = (
        await c.query("SELECT member_role($1) AS role", [p.organizationId])
      ).rows[0].role;
      if (!["owner", "admin", "manager"].includes(role))
        fail(
          403,
          "Only an owner, administrator or manager can save a budget scenario.",
        );
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [p.unitId]);
      const old = (
        await c.query(
          "SELECT to_jsonb(s) AS source,organization_id=$2 AND unit_id=$3 AND previous_id IS NOT DISTINCT FROM $4::uuid AND plan_id=$5 AND input=$6::jsonb AS same FROM broiler_economic_scenarios s WHERE id=$1",
          [
            p.scenarioId,
            p.organizationId,
            p.unitId,
            p.previousId,
            p.planId,
            JSON.stringify(p.data),
          ],
        )
      ).rows[0];
      if (old) {
        if (!old.same)
          fail(
            409,
            "This scenario receipt was already used for different values.",
          );
        return { ...report(old.source), replayed: true };
      }
    }
    await unit(c, p.organizationId, p.unitId);
    const source = await plan(c, p.organizationId, p.unitId, p.planId);
    if (!saving)
      return { planId: source.id, economics: projectEconomics(p.data, source) };
    const head = (
      await c.query(
        "SELECT id,revision FROM broiler_economic_scenarios WHERE unit_id=$1 ORDER BY revision DESC LIMIT 1",
        [p.unitId],
      )
    ).rows[0];
    if ((head?.id ?? null) !== p.previousId)
      fail(
        409,
        "A newer budget scenario exists. Download your working copy, reload and review before saving.",
      );
    if (head?.revision >= 100)
      fail(422, "This batch reached the 100-scenario version limit.");
    const row = (
      await c.query(
        "INSERT INTO broiler_economic_scenarios(id,organization_id,unit_id,previous_id,plan_id,input) VALUES($1,$2,$3,$4,$5,$6) RETURNING to_jsonb(broiler_economic_scenarios) AS source",
        [
          p.scenarioId,
          p.organizationId,
          p.unitId,
          p.previousId,
          p.planId,
          JSON.stringify(p.data),
        ],
      )
    ).rows[0];
    await audit(c, p.organizationId, "broiler.budget_saved", p.scenarioId);
    return { ...report(row.source), replayed: false };
  });
  return NextResponse.json(result, {
    status: "source" in result && !result.replayed ? 201 : 200,
    headers,
  });
}
