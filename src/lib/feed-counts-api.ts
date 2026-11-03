import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { tenant, audit } from "./db";
import { fail, jsonBody } from "./http";
import { feedStockReaders, validateFeedStockReport } from "./feed-stock-api";
import { feedStockResults, type FeedStockEvent } from "./feed-stock";
import {
  feedCountInput,
  feedCountModel,
  feedCountResults,
  feedCountCsv,
  type FeedCountEvent,
  type FeedCountReport,
  type FeedCountWorkspace,
} from "./feed-counts";
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
const managers = ["owner", "admin", "manager"],
  writers = [...managers, "inventory"];
async function lock(c: PoolClient, org: string) {
  await c.query("SELECT pg_advisory_xact_lock(813,hashtext($1))", [org]);
  await c.query("SELECT pg_advisory_xact_lock(815,hashtext($1))", [org]);
}
async function role(
  c: PoolClient,
  org: string,
  write = false,
  resolve = false,
) {
  const r = (await c.query("SELECT member_role($1) AS role", [org])).rows[0]
    .role;
  if (!(resolve ? managers : write ? writers : feedStockReaders).includes(r))
    fail(
      403,
      "Your current role cannot read, record or approve this stocktake action.",
    );
  return r as string;
}
async function context(c: PoolClient, org: string) {
  return (
    await c.query(
      "SELECT (now() AT TIME ZONE timezone)::date::text AS today,(SELECT coalesce(max(position),0)::text FROM feed_stock_events WHERE organization_id=$1) AS stock,(SELECT coalesce(max(position),0)::text FROM feed_stocktakes WHERE organization_id=$1) AS counts FROM organizations WHERE id=$1",
      [org],
    )
  ).rows[0] as { today: string; stock: string; counts: string };
}
async function event(
  c: PoolClient,
  org: string,
  id: string,
): Promise<FeedCountEvent> {
  const r = (
    await c.query(
      "SELECT feed_stocktake_json(e) AS event FROM feed_stocktakes e WHERE organization_id=$1 AND id=$2",
      [org, id],
    )
  ).rows[0];
  if (!r) fail(404, "Saved stocktake not found.");
  return r.event;
}
function report(e: FeedCountEvent): FeedCountReport {
  if (e.model_version !== feedCountModel)
    fail(422, "Unsupported stocktake model.");
  const n = {
      modelVersion: feedCountModel,
      event: e,
      results: feedCountResults(e),
    },
    r = {
      ...n,
      evidenceSha256: createHash("sha256")
        .update(JSON.stringify(n))
        .digest("hex"),
    };
  if (
    Buffer.byteLength(JSON.stringify(n)) > 1024 * 1024 ||
    Buffer.byteLength(feedCountCsv(r)) > 3 * 1024 * 1024
  )
    fail(422, "Stocktake evidence exceeds the report/CSV bound.");
  return r;
}
export async function feedCountsApi(
  request: NextRequest,
  user: { id: string },
  path: string,
) {
  if (
    path !== "inventory/feed/counts" ||
    !["GET", "POST"].includes(request.method)
  )
    return null;
  if (request.method === "GET") {
    const org = z
        .uuid()
        .parse(request.nextUrl.searchParams.get("organizationId")),
      lot = z
        .uuid()
        .nullable()
        .parse(request.nextUrl.searchParams.get("lotId")),
      id = z
        .uuid()
        .nullable()
        .parse(request.nextUrl.searchParams.get("eventId")),
      format = z
        .enum(["workspace", "json", "csv"])
        .parse(request.nextUrl.searchParams.get("format") ?? "workspace");
    const v = await tenant(user.id, async (c) => {
      const r = await role(c, org);
      await lock(c, org);
      const saved = id ? report(await event(c, org, id)) : null;
      if (format !== "workspace") {
        if (!saved) fail(400, "Choose a saved stocktake version.");
        return saved;
      }
      const ctx = await context(c, org),
        rows = (
          await c.query(
            "SELECT to_jsonb(e)||jsonb_build_object('position',e.position::text,'expected_position',e.expected_position::text,'recorded_on',e.recorded_on::text,'weight_kg',e.weight_kg::text,'amount',e.amount::text) AS event FROM feed_stock_events e WHERE organization_id=$1 ORDER BY position LIMIT 1001",
            [org],
          )
        ).rows.map((v) => v.event) as FeedStockEvent[];
      if (rows.length > 1000) fail(422, "Physical event limit reached.");
      const counts = (
        await c.query(
          'SELECT t.id,t.lot_id AS "lotId",t.input->>\'reference\' AS reference,t.recorded_on::text AS date,t.variance_kg::text AS "varianceKg",t.recorded_kg::text AS "recordedKg",t.counted_kg::text AS "countedKg",t.shortage_value::text AS "shortageValue",t.currency,CASE WHEN t.variance_kg<0 THEN \'shortage\' WHEN t.variance_kg>0 THEN \'surplus\' ELSE \'match\' END AS classification,t.source_sha256=encode(sha256(convert_to(feed_stocktake_source(t.organization_id,t.lot_id)::text,\'UTF8\')),\'hex\') AS "sourceCurrent",r.id AS "resolutionId",EXISTS(SELECT 1 FROM active_feed_stock_events a WHERE a.organization_id=t.organization_id AND a.id=r.loss_event_id) AS "lossActive" FROM feed_stocktakes t LEFT JOIN feed_stocktakes r ON r.organization_id=t.organization_id AND r.count_id=t.id WHERE t.organization_id=$1 AND t.kind=\'count\' AND NOT EXISTS(SELECT 1 FROM feed_stocktakes n WHERE n.previous_id=t.id) ORDER BY t.position DESC LIMIT 1000',
          [org],
        )
      ).rows as FeedCountWorkspace["counts"];
      let selected: FeedCountWorkspace["selected"] = null;
      if (lot) {
        const s = (
            await c.query(
              "SELECT feed_stocktake_source($1,$2) AS source,octet_length(feed_stocktake_source($1,$2)::text)>262144 AS large,encode(sha256(convert_to(feed_stocktake_source($1,$2)::text,'UTF8')),'hex') AS sha",
              [org, lot],
            )
          ).rows[0],
          latest = counts.find((t) => t.lotId === lot);
        selected = {
          lotId: lot,
          latestId: latest?.id ?? null,
          source: s.large ? null : s.source,
          sourceSha256: s.large ? null : s.sha,
          sourceTooLarge: !!s.large,
        };
      }
      return {
        today: ctx.today,
        expectedStockPosition: ctx.stock,
        expectedCountPosition: ctx.counts,
        lots: feedStockResults(rows)
          .lots.filter((l) => l.active)
          .map((l) => ({
            id: l.receipt.id,
            label:
              l.feedName +
              " · " +
              (l.receipt.input.kind === "receipt"
                ? l.receipt.input.reference
                : "") +
              " · " +
              l.location,
            balanceKg: l.balanceKg,
            currency: l.currency,
          })),
        history: (
          await c.query(
            "SELECT e.id,e.kind,e.lot_id,coalesce(e.input->>'reference',e.source_snapshot->'count'->'input'->>'reference') AS reference,e.recorded_on::text FROM feed_stocktakes e WHERE organization_id=$1 AND ($2::uuid IS NULL OR lot_id=$2) ORDER BY position DESC LIMIT 200",
            [org, lot],
          )
        ).rows,
        counts: counts.map((t) => ({
          ...t,
          sourceCurrent: !!t.sourceCurrent,
          canResolve:
            managers.includes(r) &&
            t.classification === "shortage" &&
            !!t.sourceCurrent &&
            !t.resolutionId,
        })),
        selected,
        report: saved,
      } satisfies FeedCountWorkspace;
    });
    if (format === "workspace") return NextResponse.json(v, { headers });
    const r = v as FeedCountReport,
      common = {
        ...headers,
        "Content-Disposition": `attachment; filename="feed-stocktake.${format}"`,
        "X-Evidence-SHA256": r.evidenceSha256,
      };
    return format === "json"
      ? NextResponse.json(r, { headers: common })
      : new NextResponse(feedCountCsv(r), {
          headers: { ...common, "Content-Type": "text/csv; charset=utf-8" },
        });
  }
  const p = feedCountInput.parse(await jsonBody(request));
  try {
    const result = await tenant(user.id, async (c) => {
      await role(c, p.organizationId, true, p.data.kind === "resolve_shortage");
      await lock(c, p.organizationId);
      const old = (
        await c.query(
          "SELECT id,submission=$2::jsonb AS same FROM feed_stocktakes WHERE id=$1",
          [p.eventId, JSON.stringify(p)],
        )
      ).rows[0];
      if (old) {
        if (!old.same)
          fail(409, "This stocktake receipt was used for different values.");
        return { id: old.id, replayed: true };
      }
      const ctx = await context(c, p.organizationId);
      if (
        p.expectedStockPosition !== ctx.stock ||
        p.expectedCountPosition !== ctx.counts
      )
        fail(
          409,
          "Stock or counts changed. Keep working inputs, reload and confirm again.",
        );
      await c.query(
        "INSERT INTO feed_stocktakes(id,organization_id,expected_stock_position,expected_count_position,expected_source_sha256,input) VALUES($1,$2,$3,$4,$5,$6)",
        [
          p.eventId,
          p.organizationId,
          p.expectedStockPosition,
          p.expectedCountPosition,
          p.expectedSourceSha256,
          JSON.stringify(p.data),
        ],
      );
      report(await event(c, p.organizationId, p.eventId));
      if (p.data.kind === "resolve_shortage") {
        const after = await context(c, p.organizationId);
        await validateFeedStockReport(
          c,
          p.organizationId,
          after.today,
          after.stock,
        );
      }
      await audit(
        c,
        p.organizationId,
        "feed.stocktake_" + p.data.kind,
        p.eventId,
      );
      return { id: p.eventId, replayed: false };
    });
    return NextResponse.json(result, {
      status: result.replayed ? 200 : 201,
      headers,
    });
  } catch (e) {
    const code = (e as { code?: string }).code,
      message = (e as Error).message;
    if (code === "23505")
      fail(
        409,
        "Stock, count source or predecessor changed, or the count reference is reserved. Keep working inputs and reload.",
      );
    if (code === "23514")
      fail(/bound|limit/.test(message) ? 422 : 409, message);
    throw e;
  }
}
