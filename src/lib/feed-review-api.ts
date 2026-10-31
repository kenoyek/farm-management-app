import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { tenant, audit } from "./db";
import { fail, jsonBody } from "./http";
import { feedStockReaders } from "./feed-stock-api";
import {
  feedReviewInput,
  feedReviewModel,
  feedReviewResults,
  feedReviewCsv,
  type FeedReview,
  type FeedReviewReport,
  type FeedReviewWorkspace,
} from "./feed-review";
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
async function role(c: PoolClient, org: string, write = false) {
  const r = (await c.query("SELECT member_role($1) AS role", [org])).rows[0]
    .role;
  if (!(write ? ["owner", "admin", "manager"] : feedStockReaders).includes(r))
    fail(
      403,
      write
        ? "Only an owner, administrator or manager can approve feed reconciliation reviews."
        : "Your current role cannot read feed reconciliation reviews.",
    );
}
async function ctx(c: PoolClient, org: string) {
  return (
    await c.query(
      "SELECT (now() AT TIME ZONE timezone)::date::text AS today,(SELECT coalesce(max(position),0)::text FROM feed_stock_events WHERE organization_id=$1) AS stock,(SELECT coalesce(max(position),0)::text FROM feed_reconciliation_reviews WHERE organization_id=$1) AS reviews FROM organizations WHERE id=$1",
      [org],
    )
  ).rows[0] as { today: string; stock: string; reviews: string };
}
async function locks(c: PoolClient, org: string, target?: string) {
  if (target) {
    const e = (
      await c.query(
        "SELECT unit_id FROM feed_stock_events WHERE organization_id=$1 AND id=$2",
        [org, target],
      )
    ).rows[0];
    if (e?.unit_id)
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [e.unit_id]);
  }
  await c.query("SELECT pg_advisory_xact_lock(813,hashtext($1))", [org]);
  await c.query("SELECT pg_advisory_xact_lock(814,hashtext($1))", [org]);
}
async function readReview(
  c: PoolClient,
  org: string,
  id: string,
): Promise<FeedReview> {
  const row = (
    await c.query(
      "SELECT to_jsonb(r)||jsonb_build_object('position',r.position::text,'expected_stock_position',r.expected_stock_position::text,'expected_review_position',r.expected_review_position::text,'reviewed_on',r.reviewed_on::text) AS review FROM feed_reconciliation_reviews r WHERE organization_id=$1 AND id=$2",
      [org, id],
    )
  ).rows[0];
  if (!row) fail(404, "Saved feed review not found.");
  return row.review;
}
function report(review: FeedReview): FeedReviewReport {
  if (review.model_version !== feedReviewModel)
    fail(422, "Unsupported saved feed review model.");
  const n = {
      modelVersion: feedReviewModel,
      review,
      results: feedReviewResults(review),
    },
    r = {
      ...n,
      evidenceSha256: createHash("sha256")
        .update(JSON.stringify(n))
        .digest("hex"),
    };
  if (
    Buffer.byteLength(JSON.stringify(n)) > 1024 * 1024 ||
    Buffer.byteLength(feedReviewCsv(r)) > 3 * 1024 * 1024
  )
    fail(422, "This review exceeds its 1 MiB evidence / 3 MiB CSV limit.");
  return r;
}
async function source(
  c: PoolClient,
  org: string,
  kind: string,
  target: string,
) {
  return (
    await c.query(
      "SELECT snapshot,CASE WHEN $2='source' THEN encode(sha256(convert_to((snapshot->'currentSource')::text,'UTF8')),'hex') ELSE encode(sha256(convert_to(snapshot::text,'UTF8')),'hex') END AS sha FROM (SELECT feed_review_snapshot($1,$2,$3) AS snapshot)s",
      [org, kind, target],
    )
  ).rows[0];
}
export async function feedReviewApi(
  request: NextRequest,
  user: { id: string },
  path: string,
) {
  if (
    path !== "inventory/feed/reviews" ||
    !["GET", "POST"].includes(request.method)
  )
    return null;
  if (request.method === "GET") {
    const org = z
        .uuid()
        .parse(request.nextUrl.searchParams.get("organizationId")),
      id = z
        .uuid()
        .nullable()
        .parse(request.nextUrl.searchParams.get("reviewId")),
      target = z
        .uuid()
        .nullable()
        .parse(request.nextUrl.searchParams.get("targetId")),
      kind = z
        .enum(["source", "cost"])
        .parse(request.nextUrl.searchParams.get("kind") ?? "cost"),
      format = z
        .enum(["workspace", "json", "csv"])
        .parse(request.nextUrl.searchParams.get("format") ?? "workspace");
    const value = await tenant(user.id, async (c) => {
      await role(c, org);
      if (format !== "workspace") {
        if (!id) fail(400, "Select an exact saved review for export.");
        return report(await readReview(c, org, id));
      }
      await locks(c, org, target ?? undefined);
      const context = await ctx(c, org),
        history = (
          await c.query(
            "SELECT id,kind,target_id,revision,reviewed_on::text FROM feed_reconciliation_reviews WHERE organization_id=$1 ORDER BY position DESC LIMIT 1000",
            [org],
          )
        ).rows,
        targets = (
          await c.query(
            "SELECT e.id,e.kind,e.recorded_on::text AS date,e.lot_id AS \"lotId\",e.weight_kg::text AS \"weightKg\",e.currency,(l.input->>'feedName')||' · '||l.reference AS label FROM active_feed_stock_events e JOIN active_feed_stock_events l ON l.id=e.lot_id AND l.organization_id=e.organization_id AND l.kind='receipt' WHERE e.organization_id=$1 AND e.kind IN ('receipt','consume') ORDER BY e.recorded_on DESC,e.position DESC LIMIT 1000",
            [org],
          )
        ).rows;
      let selected: FeedReviewWorkspace["selected"] = null,
        r: FeedReviewReport | null = null,
        current: boolean | null = null;
      if (target) {
        const s = await source(c, org, kind, target),
          latest = history.find(
            (h) => h.kind === kind && h.target_id === target,
          );
        if (
          s.snapshot &&
          Buffer.byteLength(JSON.stringify(s.snapshot)) > 524288
        )
          fail(
            422,
            "Current review source exceeds 512 KiB; exact saved review exports remain available.",
          );
        selected = {
          kind,
          targetId: target,
          latestId: latest?.id ?? null,
          sourceSha256: s.sha,
          snapshot: s.snapshot,
        };
        if (!id && latest) r = report(await readReview(c, org, latest.id));
      }
      if (id) r = report(await readReview(c, org, id));
      if (r) {
        const s = await source(c, org, r.review.kind, r.review.target_id);
        current = s.sha === r.review.source_sha256 && s.snapshot !== null;
        if (current && r.review.kind === "source")
          current = !!(
            await c.query(
              "SELECT coalesce(source_current,false) AS current FROM financial_feed_sources WHERE organization_id=$1 AND source_id=$2",
              [org, r.review.target_id],
            )
          ).rows[0]?.current;
      }
      return {
        today: context.today,
        expectedStockPosition: context.stock,
        expectedReviewPosition: context.reviews,
        targets,
        history,
        selected,
        report: r,
        sourceCurrent: current,
      } satisfies FeedReviewWorkspace;
    });
    if (format === "workspace") return NextResponse.json(value, { headers });
    const r = value as FeedReviewReport,
      common = {
        ...headers,
        "X-Evidence-SHA256": r.evidenceSha256,
        "Content-Disposition": `attachment; filename="feed-reconciliation-review.${format}"`,
      };
    return format === "json"
      ? NextResponse.json(r, { headers: common })
      : new NextResponse(feedReviewCsv(r), {
          headers: { ...common, "Content-Type": "text/csv; charset=utf-8" },
        });
  }
  const p = feedReviewInput.parse(await jsonBody(request));
  const result = await tenant(user.id, async (c) => {
    await role(c, p.organizationId, true);
    await locks(c, p.organizationId, p.data.targetId);
    const old = (
      await c.query(
        "SELECT id,submission=$2::jsonb AS same FROM feed_reconciliation_reviews WHERE id=$1",
        [p.reviewId, JSON.stringify(p)],
      )
    ).rows[0];
    if (old) {
      if (!old.same)
        fail(
          409,
          "This review receipt was already used for different evidence.",
        );
      return { id: old.id, replayed: true };
    }
    const context = await ctx(c, p.organizationId),
      s = await source(c, p.organizationId, p.data.kind, p.data.targetId);
    if (
      p.expectedStockPosition !== context.stock ||
      p.expectedReviewPosition !== context.reviews ||
      !s.snapshot ||
      s.sha !== p.expectedSourceSha256
    )
      fail(
        409,
        "Stock, review head or source evidence changed. Keep a working copy, reload and confirm again.",
      );
    await c.query(
      "INSERT INTO feed_reconciliation_reviews(id,organization_id,kind,target_id,reviewed_on,expected_stock_position,expected_review_position,expected_source_sha256,input) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        p.reviewId,
        p.organizationId,
        p.data.kind,
        p.data.targetId,
        p.date,
        p.expectedStockPosition,
        p.expectedReviewPosition,
        p.expectedSourceSha256,
        JSON.stringify(p.data),
      ],
    );
    report(await readReview(c, p.organizationId, p.reviewId));
    await audit(c, p.organizationId, "feed.review_" + p.data.kind, p.reviewId);
    return { id: p.reviewId, replayed: false };
  });
  return NextResponse.json(result, {
    status: result.replayed ? 200 : 201,
    headers,
  });
}
