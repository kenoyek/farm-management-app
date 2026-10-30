import { broilerPlanningApi } from "./broiler-planning-api";
import { broilerRecoveryApi } from "./broiler-recovery-api";
import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { tenant, audit } from "./db";
import { fail, jsonBody } from "./http";
import {
  broilerEventInput,
  broilerSummary,
  broilerCsv,
  harvestAmount,
  type BroilerSource,
} from "./broiler-lifecycle";
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
export async function broilerApi(
  request: NextRequest,
  user: { id: string },
  path: string,
) {
  const planning = await broilerPlanningApi(request, user, path);
  if (planning) return planning;
  const recovery = await broilerRecoveryApi(request, user, path);
  if (recovery) return recovery;
  if (
    path !== "broilers/lifecycle" ||
    !["GET", "POST"].includes(request.method)
  )
    return null;
  if (request.method === "GET") {
    const org = z
        .uuid()
        .parse(request.nextUrl.searchParams.get("organizationId")),
      unit = z.uuid().parse(request.nextUrl.searchParams.get("unitId"));
    const format = z
      .enum(["json", "csv"])
      .parse(request.nextUrl.searchParams.get("format") ?? "json");
    const source: BroilerSource = await tenant(user.id, async (c) => {
      const r = (
        await c.query(
          `SELECT to_jsonb(u)||jsonb_build_object('stocked_on',u.stocked_on::text,'initial_weight_g',u.initial_weight_g::text) AS unit,o.timezone,(now() AT TIME ZONE o.timezone)::date::text AS today,
   coalesce((SELECT jsonb_agg(to_jsonb(d)||jsonb_build_object('feed_kg',d.feed_kg::text,'average_weight_g',d.average_weight_g::text) ORDER BY d.recorded_on,d.id) FROM (SELECT * FROM effective_daily_records WHERE organization_id=$1 AND unit_id=$2 ORDER BY recorded_on,id LIMIT 10001)d),'[]'::jsonb) AS records,
   coalesce((SELECT jsonb_agg(to_jsonb(d)||jsonb_build_object('feed_kg',d.feed_kg::text,'average_weight_g',d.average_weight_g::text) ORDER BY d.recorded_on,d.id) FROM (SELECT * FROM daily_records WHERE organization_id=$1 AND unit_id=$2 ORDER BY recorded_on,id LIMIT 10001)d),'[]'::jsonb) AS "originalRecords",
   coalesce((SELECT jsonb_agg(to_jsonb(r)||jsonb_build_object('position',r.position::text,'expected_position',r.expected_position::text,'feed_kg',r.feed_kg::text,'average_weight_g',r.average_weight_g::text) ORDER BY r.position) FROM (SELECT * FROM broiler_reviews WHERE organization_id=$1 AND unit_id=$2 ORDER BY position LIMIT 10001)r),'[]'::jsonb) AS reviews,
   coalesce((SELECT jsonb_agg(to_jsonb(e)||jsonb_build_object('position',e.position::text,'expected_position',e.expected_position::text,'weight_kg',e.weight_kg::text,'price_per_unit',e.price_per_unit::text,'amount',e.amount::text) ORDER BY e.position) FROM (SELECT * FROM broiler_events WHERE organization_id=$1 AND unit_id=$2 ORDER BY position LIMIT 10001)e),'[]'::jsonb) AS events
   FROM production_units u JOIN organizations o ON o.id=u.organization_id WHERE u.organization_id=$1 AND u.id=$2 AND u.kind='broilers'`,
          [org, unit],
        )
      ).rows[0];
      if (!r) fail(404, "Broiler batch not found.");
      return r;
    });
    if (
      source.events.length > 10000 ||
      source.records.length > 10000 ||
      (source.originalRecords?.length ?? 0) > 10000 ||
      (source.reviews?.length ?? 0) > 10000 ||
      Buffer.byteLength(JSON.stringify(source)) > 4 * 1024 * 1024
    )
      fail(
        422,
        "This batch exceeds lifecycle report limits. Ask an administrator to review its source history.",
      );
    // Calendar context is returned for forms; evidence remains stable across days.
    const normalized = {
      modelVersion: "broiler-reviewed-lifecycle-v2",
      originalRecords: source.originalRecords,
      reviews: source.reviews,
      unit: source.unit,
      records: source.records,
      events: source.events,
      timezone: source.timezone,
    };
    const summary = broilerSummary(source);
    const evidenceSha256 = createHash("sha256")
      .update(JSON.stringify(normalized))
      .digest("hex");
    const snapshot = { ...source, ...normalized, summary, evidenceSha256 };
    if (format === "csv")
      return new NextResponse(broilerCsv(snapshot), {
        headers: {
          ...headers,
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="broiler-lifecycle.csv"',
          "X-Evidence-SHA256": evidenceSha256,
        },
      });
    return NextResponse.json(snapshot, {
      headers: { ...headers, "X-Evidence-SHA256": evidenceSha256 },
    });
  }
  const p = broilerEventInput.parse(await jsonBody(request));
  const result = await tenant(user.id, async (c) => {
    const role = (
      await c.query("SELECT member_role($1) AS role", [p.organizationId])
    ).rows[0].role;
    if (!["owner", "admin", "manager"].includes(role))
      fail(
        403,
        "Only an owner, administrator or manager can review broiler lifecycle records.",
      );
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [p.unitId]);
    const old = (
      await c.query(
        "SELECT id,submission=$2::jsonb AS same FROM broiler_events WHERE id=$1",
        [p.eventId, JSON.stringify(p)],
      )
    ).rows[0];
    if (old) {
      if (!old.same)
        fail(409, "This receipt was already used for different values.");
      return { id: old.id, replayed: true };
    }
    const u = (
      await c.query(
        `SELECT u.id,u.stocked_on::text,o.currency,(now() AT TIME ZONE o.timezone)::date::text AS today,
   broiler_latest_position(u.id)::text AS position,
   (SELECT id FROM effective_daily_records WHERE unit_id=u.id ORDER BY recorded_on DESC LIMIT 1) AS daily_id,
   (SELECT recorded_balance FROM production_population_balances WHERE id=u.id) AS balance,
   greatest((SELECT max(recorded_on) FROM broiler_events WHERE unit_id=u.id),(SELECT max(recorded_on) FROM effective_daily_records WHERE unit_id=u.id),(SELECT max(observed_on) FROM broiler_reviews WHERE unit_id=u.id AND kind='withdrawal'))::text AS last_day
   FROM production_units u JOIN organizations o ON o.id=u.organization_id WHERE u.id=$1 AND u.organization_id=$2 AND u.kind='broilers'`,
        [p.unitId, p.organizationId],
      )
    ).rows[0];
    if (!u) fail(404, "Broiler batch not found.");
    if (p.expectedPosition !== u.position || p.expectedDailyId !== u.daily_id)
      fail(
        409,
        "This batch changed after you loaded it. Reload lifecycle records and review again.",
      );
    if (
      p.date < u.stocked_on ||
      p.date > u.today ||
      (u.last_day && p.date < u.last_day)
    )
      fail(
        400,
        "Enter lifecycle records in date order, from stocking through today in the organization timezone. Enter the daily observation first.",
      );
    if ("quantity" in p && p.quantity > Number(u.balance))
      fail(
        409,
        "Bird count exceeds the recorded population balance. Reload and review the count.",
      );
    if (
      p.kind === "treatment" &&
      p.earliestHarvestOn !== null &&
      p.earliestHarvestOn < p.date
    )
      fail(400, "The earliest harvest date cannot precede treatment.");
    if (p.kind === "harvest") {
      const hold = (
        await c.query(
          "SELECT id FROM effective_broiler_treatments WHERE unit_id=$1 AND (earliest_harvest_on IS NULL OR earliest_harvest_on>$2) LIMIT 1",
          [p.unitId, p.date],
        )
      ).rows[0];
      if (hold)
        fail(
          409,
          "A recorded treatment has an unknown or unexpired withdrawal date. Obtain veterinary guidance and review the treatment before harvesting.",
        );
      if (
        p.reference &&
        (
          await c.query(
            "SELECT id FROM broiler_events WHERE organization_id=$1 AND reference=$2",
            [p.organizationId, p.reference],
          )
        ).rowCount
      )
        fail(409, "This harvest reference is already recorded.");
    }
    if (p.kind === "void") {
      const original = (
        await c.query(
          "SELECT * FROM active_broiler_events WHERE id=$1 AND organization_id=$2 AND unit_id=$3",
          [p.voidOfId, p.organizationId, p.unitId],
        )
      ).rows[0];
      if (!original)
        fail(409, "The original event is missing or already voided.");
      if (
        ["cull", "harvest"].includes(original.kind) &&
        (
          await c.query(
            "SELECT 1 FROM effective_daily_records WHERE unit_id=$1 AND recorded_on>$2 UNION ALL SELECT 1 FROM active_broiler_events WHERE unit_id=$1 AND position>$3 UNION ALL SELECT 1 FROM broiler_reviews WHERE unit_id=$1 AND position>$3 LIMIT 1",
            [p.unitId, original.recorded_on, original.position],
          )
        ).rowCount
      )
        fail(
          409,
          "Only the latest withdrawal can be corrected, before subsequent production activity. A void records an erroneous entry; it is not a physical return.",
        );
    }
    const priced = p.kind === "harvest" && p.priceBasis !== "unpriced";
    const amount = priced
      ? harvestAmount(
          p.quantity,
          p.weightKg,
          p.priceBasis as "bird" | "kg",
          p.pricePerUnit!,
        )
      : null;
    await c.query(
      `INSERT INTO broiler_events(id,organization_id,unit_id,kind,recorded_on,expected_position,expected_daily_id,quantity,weight_kg,description,product,administration,earliest_harvest_on,price_basis,price_per_unit,amount,currency,reference,customer,void_of_id,reason,evidence,submission)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
      [
        p.eventId,
        p.organizationId,
        p.unitId,
        p.kind,
        p.date,
        p.expectedPosition,
        p.expectedDailyId,
        "quantity" in p ? p.quantity : null,
        "weightKg" in p ? p.weightKg : null,
        p.description,
        p.kind === "treatment" ? p.product : null,
        p.kind === "treatment" ? p.administration : null,
        p.kind === "treatment" ? p.earliestHarvestOn : null,
        p.kind === "harvest" ? p.priceBasis : null,
        p.kind === "harvest" ? p.pricePerUnit : null,
        amount,
        priced ? u.currency : null,
        p.kind === "harvest" ? p.reference : null,
        p.kind === "harvest" ? p.customer : null,
        p.kind === "void" ? p.voidOfId : null,
        p.reason,
        p.evidence,
        JSON.stringify(p),
      ],
    );
    await audit(c, p.organizationId, "broiler." + p.kind, p.eventId);
    return { id: p.eventId, replayed: false };
  });
  return NextResponse.json(result, {
    status: result.replayed ? 200 : 201,
    headers,
  });
}
