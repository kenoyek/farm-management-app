import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { tenant, audit } from "./db";
import { fail, jsonBody } from "./http";
import {
  feedStockInput,
  feedStockDay,
  feedStockModel,
  feedValuePolicy,
  feedStockResults,
  feedStockCsv,
  type FeedStockInput,
  type FeedStockEvent,
  type FeedStockReport,
  type FeedStockWorkspace,
  type FeedConsumptionSource,
} from "./feed-stock";
export const feedStockReaders = [
  "owner",
  "admin",
  "manager",
  "inventory",
  "accounts",
  "auditor",
];
export const feedStockWriters = ["owner", "admin", "manager", "inventory"];
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
const position = z.string().regex(/^(0|[1-9]\d{0,18})$/);
async function role(c: PoolClient, org: string, write = false) {
  const r = (await c.query("SELECT member_role($1) AS role", [org])).rows[0]
    .role;
  if (!(write ? feedStockWriters : feedStockReaders).includes(r))
    fail(
      403,
      write
        ? "Only an owner, administrator, manager or inventory officer can post feed stock."
        : "Your current role cannot read feed purchases and valuations.",
    );
}
async function context(c: PoolClient, org: string) {
  return (
    await c.query(
      "SELECT (now() AT TIME ZONE timezone)::date::text AS today,(SELECT coalesce(max(position),0)::text FROM feed_stock_events WHERE organization_id=$1) AS head FROM organizations WHERE id=$1",
      [org],
    )
  ).rows[0] as { today: string; head: string };
}
async function events(
  c: PoolClient,
  org: string,
  day: string,
  cutoff: string,
): Promise<FeedStockEvent[]> {
  return (
    await c.query(
      `SELECT to_jsonb(e)||jsonb_build_object('position',e.position::text,'expected_position',e.expected_position::text,'recorded_on',e.recorded_on::text,'weight_kg',e.weight_kg::text,'amount',e.amount::text) AS event FROM feed_stock_events e WHERE organization_id=$1 AND recorded_on<=$2::date AND position<=$3::bigint ORDER BY position LIMIT 1001`,
      [org, day, cutoff],
    )
  ).rows.map((r) => r.event);
}
async function report(
  c: PoolClient,
  org: string,
  day: string,
  cutoff: string,
): Promise<FeedStockReport> {
  const rows = await events(c, org, day, cutoff);
  if (
    rows.length > 1000 ||
    rows.some(
      (e) => e.model_version !== feedStockModel || e.policy !== feedValuePolicy,
    )
  )
    fail(
      422,
      "This feed ledger exceeds its event limit or has an unsupported model.",
    );
  const normalized = {
      modelVersion: feedStockModel,
      policy: feedValuePolicy,
      organizationId: org,
      asOf: day,
      throughPosition: cutoff,
      events: rows,
      results: feedStockResults(rows),
    },
    r = {
      ...normalized,
      evidenceSha256: createHash("sha256")
        .update(JSON.stringify(normalized))
        .digest("hex"),
    };
  if (
    Buffer.byteLength(JSON.stringify(normalized)) > 1024 * 1024 ||
    Buffer.byteLength(feedStockCsv(r)) > 3 * 1024 * 1024
  )
    fail(
      422,
      "This report exceeds the 1 MiB evidence / 3 MiB CSV limit. Choose an earlier date or append-position cutoff.",
    );
  return r;
}
async function lock(c: PoolClient, p: FeedStockInput) {
  let unit = p.data.kind === "consume" ? p.data.unitId : null;
  if (p.data.kind === "void")
    unit =
      (
        await c.query(
          "SELECT unit_id FROM feed_stock_events WHERE organization_id=$1 AND id=$2",
          [p.organizationId, p.data.voidOfId],
        )
      ).rows[0]?.unit_id ?? null;
  if (unit) await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [unit]);
  await c.query("SELECT pg_advisory_xact_lock(813,hashtext($1))", [
    p.organizationId,
  ]);
}
async function sources(
  c: PoolClient,
  org: string,
  unit: string | null,
  sourceDate: string | null,
) {
  // Current reconciliation is deliberately separate from frozen report evidence.
  const rows = (
    await c.query(
      `WITH recent_keys AS (
 SELECT d.unit_id,d.recorded_on FROM effective_daily_records d JOIN production_units u ON u.id=d.unit_id WHERE d.organization_id=$1 AND u.kind='broilers' AND d.feed_kg>0 AND ($2::uuid IS NULL OR d.unit_id=$2) AND ($3::date IS NULL OR d.recorded_on=$3) ORDER BY d.recorded_on DESC,d.unit_id LIMIT 200
 ),source_keys AS (SELECT * FROM recent_keys
 UNION SELECT e.unit_id,e.recorded_on FROM active_feed_stock_events e WHERE e.organization_id=$1 AND e.kind='consume' AND ($2::uuid IS NULL OR e.unit_id=$2) AND ($3::date IS NULL OR e.recorded_on=$3)
 ), snapshots AS (SELECT k.*,feed_consumption_source($1,k.unit_id,k.recorded_on) AS snapshot FROM source_keys k), current_sources AS (SELECT s.*,encode(sha256(convert_to(s.snapshot::text,'UTF8')),'hex') AS sha FROM snapshots s)
 SELECT s.unit_id AS "unitId",coalesce(s.snapshot->'unit'->>'name',u.name) AS "unitName",s.recorded_on::text AS date,coalesce(s.snapshot->'record'->>'feed_kg','0.000000') AS "feedKg",coalesce(s.sha,'') AS "sourceSha256",coalesce(a.kg,0)::numeric(20,6)::text AS "issuedKg",greatest(coalesce((s.snapshot->'record'->>'feed_kg')::numeric,0)-coalesce(a.kg,0),0)::numeric(20,6)::text AS "unlinkedKg",greatest(coalesce(a.kg,0)-coalesce((s.snapshot->'record'->>'feed_kg')::numeric,0),0)::numeric(20,6)::text AS "overlinkedKg",coalesce(a.changed,false) AS "sourceChanged"
 FROM current_sources s JOIN production_units u ON u.id=s.unit_id AND u.organization_id=$1 LEFT JOIN LATERAL(SELECT sum(e.weight_kg) AS kg,bool_or(e.source_sha256 IS DISTINCT FROM s.sha) AS changed FROM active_feed_stock_events e WHERE e.organization_id=$1 AND e.unit_id=s.unit_id AND e.recorded_on=s.recorded_on AND e.kind='consume')a ON true WHERE ($2::uuid IS NULL OR s.unit_id=$2) ORDER BY s.recorded_on DESC,s.unit_id LIMIT 1200`,
      [org, unit, sourceDate],
    )
  ).rows as FeedConsumptionSource[];
  return rows;
}
export async function feedStockApi(
  request: NextRequest,
  user: { id: string },
  path: string,
) {
  if (path !== "inventory/feed" || !["GET", "POST"].includes(request.method))
    return null;
  if (request.method === "GET") {
    const org = z
        .uuid()
        .parse(request.nextUrl.searchParams.get("organizationId")),
      unit = z
        .uuid()
        .nullable()
        .parse(request.nextUrl.searchParams.get("unitId")),
      sourceDate = feedStockDay
        .nullable()
        .parse(request.nextUrl.searchParams.get("sourceDate")),
      day = feedStockDay
        .nullable()
        .parse(request.nextUrl.searchParams.get("asOf")),
      cutoff = position
        .nullable()
        .parse(request.nextUrl.searchParams.get("throughPosition")),
      format = z
        .enum(["workspace", "json", "csv"])
        .parse(request.nextUrl.searchParams.get("format") ?? "workspace");
    const value = await tenant(user.id, async (c) => {
      await role(c, org);
      await c.query("SELECT pg_advisory_xact_lock(813,hashtext($1))", [org]);
      const ctx = await context(c, org),
        date = day ?? ctx.today,
        through = cutoff ?? ctx.head;
      if (date > ctx.today || BigInt(through) > BigInt(ctx.head))
        fail(
          400,
          "Choose a date and append-position cutoff no later than the current ledger.",
        );
      const r = await report(c, org, date, through);
      if (format !== "workspace") return r;
      const sourceRows = await sources(c, org, unit, sourceDate),
        current = await events(c, org, ctx.today, ctx.head),
        voided = new Set(
          current.filter((e) => e.kind === "void").map((e) => e.void_of_id),
        );
      return {
        today: ctx.today,
        expectedPosition: ctx.head,
        report: r,
        units: (
          await c.query(
            "SELECT id,name FROM production_units WHERE organization_id=$1 AND kind='broilers' ORDER BY stocked_on DESC,id LIMIT 1000",
            [org],
          )
        ).rows,
        sources: sourceRows.slice(0, 200),
        sourceMatches: sourceRows.length,
        changedSources: sourceRows.filter(
          (s) => s.sourceChanged || s.overlinkedKg !== "0.000000",
        ),
        currentLots: feedStockResults(current).lots,
        reversible: current.filter(
          (e) => e.kind !== "void" && !voided.has(e.id),
        ),
      } satisfies FeedStockWorkspace;
    });
    if (format === "workspace") return NextResponse.json(value, { headers });
    const r = value as FeedStockReport,
      common = {
        ...headers,
        "X-Evidence-SHA256": r.evidenceSha256,
        "Content-Disposition": `attachment; filename="feed-purchases-stock.${format}"`,
      };
    return format === "json"
      ? NextResponse.json(r, { headers: common })
      : new NextResponse(feedStockCsv(r), {
          headers: { ...common, "Content-Type": "text/csv; charset=utf-8" },
        });
  }
  const p = feedStockInput.parse(await jsonBody(request));
  const result = await tenant(user.id, async (c) => {
    await role(c, p.organizationId, true);
    await lock(c, p);
    const old = (
      await c.query(
        "SELECT id,submission=$2::jsonb AS same FROM feed_stock_events WHERE id=$1",
        [p.eventId, JSON.stringify(p)],
      )
    ).rows[0];
    if (old) {
      if (!old.same)
        fail(409, "This feed receipt was already used for different values.");
      return { id: old.id, replayed: true };
    }
    const ctx = await context(c, p.organizationId);
    if (p.expectedPosition !== ctx.head)
      fail(
        409,
        "Feed stock changed after you loaded it. Keep your inputs, reload and confirm again.",
      );
    if (p.data.kind === "consume") {
      const s = (
        await c.query(
          "SELECT encode(sha256(convert_to(feed_consumption_source($1,$2,$3::date)::text,'UTF8')),'hex') AS sha",
          [p.organizationId, p.data.unitId, p.date],
        )
      ).rows[0];
      if (s.sha !== p.data.expectedSourceSha256)
        fail(
          409,
          "The actual daily feed source changed or is unavailable. Keep your inputs, reload and review again.",
        );
    }
    await c.query(
      "INSERT INTO feed_stock_events(id,organization_id,lot_id,recorded_on,expected_position,input) VALUES($1,$2,$1,$3,$4,$5)",
      [
        p.eventId,
        p.organizationId,
        p.date,
        p.expectedPosition,
        JSON.stringify(p.data),
      ],
    );
    const after = await context(c, p.organizationId);
    await report(c, p.organizationId, after.today, after.head);
    await audit(c, p.organizationId, "feed.stock_" + p.data.kind, p.eventId);
    return { id: p.eventId, replayed: false };
  });
  return NextResponse.json(result, {
    status: result.replayed ? 200 : 201,
    headers,
  });
}
