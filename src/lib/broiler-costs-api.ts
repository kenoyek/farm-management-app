import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { tenant, audit } from "./db";
import { fail, jsonBody, HttpError } from "./http";
import { broilerSummary } from "./broiler-lifecycle";
import { productEvidence } from "./broiler-products";
import {
  actualCostInput,
  actualCostModel,
  allocateActualCosts,
  costSnapshot,
  actualCostCsv,
  type ActualCostReview,
  type ActualCostReport,
  type ActualCostWorkspace,
} from "./broiler-costs";
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
function report(source: ActualCostReview): ActualCostReport {
  if (source.model_version !== actualCostModel)
    fail(422, "This saved cost-review model is unsupported.");
  const normalized = {
    modelVersion: actualCostModel,
    source,
    results: allocateActualCosts(source.input, source.source_snapshot),
  };
  if (Buffer.byteLength(JSON.stringify(normalized)) > 1024 * 1024)
    fail(
      422,
      "This review exceeds the 1 MiB complete-source cost-report limit.",
    );
  return { ...normalized, evidenceSha256: digest(normalized) };
}
async function current(c: PoolClient, org: string, unit: string) {
  await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [unit]);
  const row = (
    await c.query(
      `WITH q AS MATERIALIZED (SELECT broiler_cost_snapshot($1,$2) AS snap) SELECT snap,octet_length(snap::text) AS bytes,encode(digest(snap::text,'sha256'),'hex') AS token,(now() AT TIME ZONE (snap->'source'->>'timezone'))::date::text AS today FROM q`,
      [org, unit],
    )
  ).rows[0];
  if (!row?.snap) fail(404, "Broiler batch not found.");
  if (row.bytes > 524288)
    fail(
      422,
      "This batch exceeds the 512 KiB immutable actual-cost snapshot limit. Ask an administrator to review its history.",
    );
  const snapshot = costSnapshot(row.snap),
    s = { ...snapshot.source, today: row.today },
    evidence = productEvidence(s, snapshot.events),
    summary = broilerSummary(s);
  return {
    current: {
      ...evidence,
      evidenceSha256: digest(evidence),
      today: row.today,
      expectedSourcePosition: summary.expectedPosition,
      expectedDailyId: summary.expectedDailyId,
    },
    sourceToken: row.token as string,
  };
}
async function selected(c: PoolClient, org: string, unit: string, id: string) {
  const row = (
    await c.query(
      `SELECT to_jsonb(r)||jsonb_build_object('expected_position',r.expected_position::text,'expected_source_position',r.expected_source_position::text) AS source FROM broiler_cost_reviews r WHERE organization_id=$1 AND unit_id=$2 AND id=$3`,
      [org, unit, id],
    )
  ).rows[0];
  if (!row) fail(404, "Choose a saved cost review from this batch.");
  return report(row.source);
}
export async function broilerCostsApi(
  request: NextRequest,
  user: { id: string },
  path: string,
) {
  if (path !== "broilers/costs" || !["GET", "POST"].includes(request.method))
    return null;
  if (request.method === "GET") {
    const org = z
        .uuid()
        .parse(request.nextUrl.searchParams.get("organizationId")),
      unit = z.uuid().parse(request.nextUrl.searchParams.get("unitId")),
      id = z
        .uuid()
        .nullable()
        .parse(request.nextUrl.searchParams.get("reviewId")),
      format = z
        .enum(["workspace", "json", "csv"])
        .parse(request.nextUrl.searchParams.get("format") ?? "workspace");
    // Exact-version exports require only the immutable row, even if current history grows beyond limits.
    if (format !== "workspace") {
      if (!id) fail(400, "Choose an exact saved cost review for export.");
      const r = await tenant(user.id, (c) => selected(c, org, unit, id)),
        common = {
          ...headers,
          "Content-Disposition": `attachment; filename="broiler-actual-costs.${format}"`,
          "X-Evidence-SHA256": r.evidenceSha256,
        };
      return format === "json"
        ? NextResponse.json(r, { headers: common })
        : new NextResponse(actualCostCsv(r), {
            headers: { ...common, "Content-Type": "text/csv; charset=utf-8" },
          });
    }
    const w: ActualCostWorkspace = await tenant(user.id, async (c) => {
      let now: Awaited<ReturnType<typeof current>> | null = null;
      let currentError: string | null = null;
      try {
        now = await current(c, org, unit);
      } catch (e) {
        if (e instanceof HttpError && e.status === 422)
          currentError = e.message;
        else throw e;
      }
      const history = (
        await c.query(
          "SELECT id,revision,input->>'currency' AS currency,created_at FROM broiler_cost_reviews WHERE organization_id=$1 AND unit_id=$2 ORDER BY revision DESC LIMIT 101",
          [org, unit],
        )
      ).rows;
      if (history.length > 100)
        fail(422, "This batch exceeds its cost-review history limit.");
      const latestId = history[0]?.id ?? null,
        r =
          id || latestId ? await selected(c, org, unit, id ?? latestId!) : null;
      return {
        current: now?.current ?? null,
        sourceToken: now?.sourceToken ?? null,
        currentError,
        history,
        latestId,
        report: r,
        sourceCurrent:
          r && now
            ? digest(costSnapshot(r.source.source_snapshot)) ===
              digest(costSnapshot(now.current))
            : null,
      };
    });
    return NextResponse.json(w, { headers });
  }
  const p = actualCostInput.parse(await jsonBody(request));
  const result = await tenant(user.id, async (c) => {
    const role = (
      await c.query("SELECT member_role($1) AS role", [p.organizationId])
    ).rows[0].role;
    if (!["owner", "admin", "manager"].includes(role))
      fail(
        403,
        "Only an owner, administrator or manager can review actual costs and allocations.",
      );
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [p.unitId]);
    const old = (
      await c.query(
        "SELECT id,submission=$2::jsonb AS same FROM broiler_cost_reviews WHERE id=$1",
        [p.reviewId, JSON.stringify(p)],
      )
    ).rows[0];
    if (old) {
      if (!old.same)
        fail(409, "This cost receipt was already used for different values.");
      return { id: old.id, replayed: true };
    }
    const now = await current(c, p.organizationId, p.unitId),
      latest =
        (
          await c.query(
            "SELECT id FROM broiler_cost_reviews WHERE unit_id=$1 ORDER BY revision DESC LIMIT 1",
            [p.unitId],
          )
        ).rows[0]?.id ?? null;
    if (
      p.previousId !== latest ||
      p.expectedPosition !== now.current.results.expectedPosition ||
      p.expectedSourcePosition !== now.current.expectedSourcePosition ||
      p.expectedDailyId !== now.current.expectedDailyId ||
      p.expectedSourceSha256 !== now.sourceToken
    )
      fail(
        409,
        "The actual source or cost-review head changed. Keep your inputs, reload the cost source and confirm again.",
      );
    try {
      allocateActualCosts(p.data, costSnapshot(now.current));
    } catch (e) {
      fail(400, (e as Error).message);
    }
    await c.query(
      "INSERT INTO broiler_cost_reviews(id,organization_id,unit_id,previous_id,expected_position,expected_source_position,expected_daily_id,expected_source_sha256,input) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        p.reviewId,
        p.organizationId,
        p.unitId,
        p.previousId,
        p.expectedPosition,
        p.expectedSourcePosition,
        p.expectedDailyId,
        p.expectedSourceSha256,
        JSON.stringify(p.data),
      ],
    );
    await selected(c, p.organizationId, p.unitId, p.reviewId);
    await audit(c, p.organizationId, "broiler.actual_cost_review", p.reviewId);
    return { id: p.reviewId, replayed: false };
  });
  return NextResponse.json(result, {
    status: result.replayed ? 200 : 201,
    headers,
  });
}
