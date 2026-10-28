import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { tenant, audit } from "./db";
import { fail, jsonBody } from "./http";
import { layerAdjustmentInput } from "./layer-recovery";
export async function layerRecoveryApi(
  request: NextRequest,
  user: { id: string },
  path: string,
) {
  if (path !== "layers/recovery" || !["GET", "POST"].includes(request.method))
    return null;
  const headers = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (request.method === "GET") {
    const org = z
        .uuid()
        .parse(request.nextUrl.searchParams.get("organizationId")),
      unit = z.uuid().parse(request.nextUrl.searchParams.get("unitId"));
    const source = await tenant(user.id, async (c) => {
      const row = (
        await c.query(
          `SELECT to_jsonb(u) AS unit,o.timezone,(now() AT TIME ZONE o.timezone)::date::text AS today,
   (SELECT to_jsonb(b) FROM production_population_balances b WHERE b.id=u.id) AS balance,
   coalesce((SELECT jsonb_agg(to_jsonb(d)||jsonb_build_object('feed_kg',d.feed_kg::text) ORDER BY d.recorded_on,d.id) FROM
    (SELECT * FROM daily_records WHERE organization_id=$1 AND unit_id=$2 ORDER BY recorded_on,id LIMIT 10001) d),'[]'::jsonb) AS originals,
   coalesce((SELECT jsonb_agg(to_jsonb(a)||jsonb_build_object('feed_kg',a.feed_kg::text) ORDER BY a.created_at,a.id) FROM
    (SELECT * FROM layer_adjustments WHERE organization_id=$1 AND unit_id=$2 ORDER BY created_at,id LIMIT 10001) a),'[]'::jsonb) AS adjustments
   FROM production_units u JOIN organizations o ON o.id=u.organization_id WHERE u.organization_id=$1 AND u.id=$2`,
          [org, unit],
        )
      ).rows[0];
      if (!row || row.unit.kind !== "layers")
        fail(404, "Layer flock not found.");
      return row;
    });
    if (
      source.originals.length > 10000 ||
      source.adjustments.length > 10000 ||
      Buffer.byteLength(JSON.stringify(source)) > 2 * 1024 * 1024
    )
      fail(
        422,
        "This flock history exceeds recovery limits. Contact an administrator to review its source records.",
      );
    const digest = createHash("sha256")
      .update(JSON.stringify(source))
      .digest("hex");
    return NextResponse.json(
      { ...source, evidenceSha256: digest },
      { headers },
    );
  }
  const input = layerAdjustmentInput.parse(await jsonBody(request));
  const result = await tenant(user.id, async (c) => {
    const role = (
      await c.query("SELECT member_role($1) AS role", [input.organizationId])
    ).rows[0].role;
    if (!["owner", "admin", "manager"].includes(role))
      fail(
        403,
        "Only an owner, administrator or manager can review layer recovery.",
      );
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [input.unitId]);
    const existing = (
      await c.query(
        "SELECT id,submission=$2::jsonb AS same FROM layer_adjustments WHERE id=$1",
        [input.eventId, JSON.stringify(input)],
      )
    ).rows[0];
    if (existing) {
      if (!existing.same)
        fail(
          409,
          "This recovery receipt was already used for different values.",
        );
      return { id: existing.id, replayed: true };
    }
    const u = (
      await c.query(
        "SELECT u.id,u.stocked_on::text,(now() AT TIME ZONE o.timezone)::date::text AS today FROM production_units u JOIN organizations o ON o.id=u.organization_id WHERE u.id=$1 AND u.organization_id=$2 AND u.kind='layers'",
        [input.unitId, input.organizationId],
      )
    ).rows[0];
    if (!u) fail(404, "Layer flock not found.");
    if (input.date < u.stocked_on || input.date > u.today)
      fail(
        400,
        "Choose an observation date from stocking through today in the organization timezone.",
      );
    const head = (
      await c.query(
        "SELECT id FROM current_layer_adjustments WHERE unit_id=$1 AND kind=$2 AND observed_on=$3",
        [input.unitId, input.kind, input.date],
      )
    ).rows[0];
    if ((head?.id ?? null) !== input.previousId)
      fail(
        409,
        "This date changed after you loaded it. Reload the recovery history before reviewing again.",
      );
    if (input.kind === "daily") {
      const base = (
        await c.query(
          "SELECT id FROM daily_records WHERE unit_id=$1 AND recorded_on=$2",
          [input.unitId, input.date],
        )
      ).rows[0];
      if ((base?.id ?? null) !== input.baseRecordId)
        fail(
          409,
          "The original daily record changed. Reload recovery history.",
        );
    }
    const row = (
      await c.query(
        `INSERT INTO layer_adjustments(id,organization_id,unit_id,kind,observed_on,previous_id,base_record_id,mortality,eggs,cracked,feed_kg,notes,opening_hens,reason,evidence,submission)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [
          input.eventId,
          input.organizationId,
          input.unitId,
          input.kind,
          input.date,
          input.previousId,
          input.kind === "daily" ? input.baseRecordId : null,
          input.kind === "daily" ? input.mortality : null,
          input.kind === "daily" ? input.eggs : null,
          input.kind === "daily" ? input.cracked : null,
          input.kind === "daily" ? input.feedKg : null,
          input.kind === "daily" ? input.notes : null,
          input.kind === "census" ? input.openingHens : null,
          input.reason,
          input.evidence,
          JSON.stringify(input),
        ],
      )
    ).rows[0];
    await audit(
      c,
      input.organizationId,
      input.kind === "daily"
        ? "layer.daily_reconciled"
        : "layer.opening_census",
      row.id,
    );
    return { id: row.id, replayed: false };
  });
  return NextResponse.json(result, {
    status: result.replayed ? 200 : 201,
    headers,
  });
}
