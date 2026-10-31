import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { tenant, audit } from "./db";
import { fail, jsonBody } from "./http";
import { readBroilerSource } from "./broiler-source";
import { broilerSummary } from "./broiler-lifecycle";
import {
  productInput,
  productEvidence,
  productCsv,
  type ProductEvent,
} from "./broiler-products";
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
async function report(c: PoolClient, org: string, unit: string) {
  // All source and product writers use this lock; the two reads describe one state.
  await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [unit]);
  const s = await readBroilerSource(c, org, unit);
  const events: ProductEvent[] = (
    await c.query(
      `SELECT to_jsonb(e)||jsonb_build_object('recorded_on',e.recorded_on::text,'position',e.position::text,'expected_position',e.expected_position::text,'expected_source_position',e.expected_source_position::text,'weight_kg',e.weight_kg::text,'price_per_kg',e.price_per_kg::text,'amount',e.amount::text) AS event FROM broiler_product_events e WHERE organization_id=$1 AND unit_id=$2 ORDER BY e.position LIMIT 1001`,
      [org, unit],
    )
  ).rows.map((r) => r.event);
  const evidence = productEvidence(s, events),
    bytes = JSON.stringify(evidence);
  if (events.length > 1000 || Buffer.byteLength(bytes) > 1024 * 1024)
    fail(
      422,
      "This batch exceeds the 1000-event / 1 MiB product evidence limit. Ask an administrator to review its history.",
    );
  const summary = broilerSummary(s);
  return {
    ...evidence,
    evidenceSha256: createHash("sha256").update(bytes).digest("hex"),
    today: s.today,
    expectedSourcePosition: summary.expectedPosition,
    expectedDailyId: summary.expectedDailyId,
  };
}
export async function broilerProductsApi(
  request: NextRequest,
  user: { id: string },
  path: string,
) {
  if (path !== "broilers/products" || !["GET", "POST"].includes(request.method))
    return null;
  if (request.method === "GET") {
    const org = z
        .uuid()
        .parse(request.nextUrl.searchParams.get("organizationId")),
      unit = z.uuid().parse(request.nextUrl.searchParams.get("unitId")),
      format = z
        .enum(["json", "csv"])
        .parse(request.nextUrl.searchParams.get("format") ?? "json");
    const r = await tenant(user.id, (c) => report(c, org, unit)),
      common = {
        ...headers,
        "X-Evidence-SHA256": r.evidenceSha256,
        "Content-Disposition": `attachment; filename="broiler-product-stock.${format}"`,
      };
    return format === "csv"
      ? new NextResponse(productCsv(r), {
          headers: { ...common, "Content-Type": "text/csv; charset=utf-8" },
        })
      : NextResponse.json(r, { headers: common });
  }
  const p = productInput.parse(await jsonBody(request));
  const result = await tenant(user.id, async (c) => {
    const role = (
      await c.query("SELECT member_role($1) AS role", [p.organizationId])
    ).rows[0].role;
    if (!["owner", "admin", "manager"].includes(role))
      fail(
        403,
        "Only an owner, administrator or manager can post broiler product stock and sales.",
      );
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [p.unitId]);
    const old = (
      await c.query(
        "SELECT id,submission=$2::jsonb AS same FROM broiler_product_events WHERE id=$1",
        [p.eventId, JSON.stringify(p)],
      )
    ).rows[0];
    if (old) {
      if (!old.same)
        fail(
          409,
          "This product receipt was already used for different values.",
        );
      return { id: old.id, replayed: true };
    }
    const current = await report(c, p.organizationId, p.unitId);
    if (
      p.data.kind === "void" &&
      (
        await c.query(
          "SELECT financial_sale_is_booked($1,'product',$2) AS booked",
          [p.organizationId, p.data.voidOfId],
        )
      ).rows[0].booked
    )
      fail(
        409,
        "Reverse the financial sale recognition before voiding its operational source. Accounting reversals do not move cash or physical stock.",
      );
    if (
      p.expectedPosition !== current.results.expectedPosition ||
      p.expectedSourcePosition !== current.expectedSourcePosition ||
      p.expectedDailyId !== current.expectedDailyId
    )
      fail(
        409,
        "Product stock or batch evidence changed. Keep your inputs, reload the source and review again.",
      );
    if (p.date > current.today)
      fail(
        400,
        "Product observations cannot be future dated in the organization timezone.",
      );
    await c.query(
      "INSERT INTO broiler_product_events(id,organization_id,unit_id,lot_id,recorded_on,expected_position,expected_source_position,expected_daily_id,input) VALUES($1,$2,$3,$1,$4,$5,$6,$7,$8)",
      [
        p.eventId,
        p.organizationId,
        p.unitId,
        p.date,
        p.expectedPosition,
        p.expectedSourcePosition,
        p.expectedDailyId,
        JSON.stringify(p.data),
      ],
    );
    // Every committed movement must remain available in its mandatory complete-source report.
    await report(c, p.organizationId, p.unitId);
    await audit(
      c,
      p.organizationId,
      "broiler.product_" + p.data.kind,
      p.eventId,
    );
    return { id: p.eventId, replayed: false };
  });
  return NextResponse.json(result, {
    status: result.replayed ? 200 : 201,
    headers,
  });
}
