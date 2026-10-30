import { NextRequest, NextResponse } from "next/server";
import { tenant, audit } from "./db";
import { fail, jsonBody } from "./http";
import { broilerLossInput } from "./broiler-loss";
export async function broilerLossApi(
  request: NextRequest,
  user: { id: string },
  path: string,
) {
  if (path !== "broilers/loss-biomass" || request.method !== "POST")
    return null;
  const p = broilerLossInput.parse(await jsonBody(request));
  const result = await tenant(user.id, async (c) => {
    const role = (
      await c.query("SELECT member_role($1) AS role", [p.organizationId])
    ).rows[0].role;
    if (!["owner", "admin", "manager"].includes(role))
      fail(
        403,
        "Only an owner, administrator or manager can review loss biomass.",
      );
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [p.unitId]);
    const old = (
      await c.query(
        "SELECT id,submission=$2::jsonb AS same FROM broiler_loss_reviews WHERE id=$1",
        [p.reviewId, JSON.stringify(p)],
      )
    ).rows[0];
    if (old) {
      if (!old.same)
        fail(
          409,
          "This loss review receipt was already used for different values.",
        );
      return { id: old.id, replayed: true };
    }
    const u = (
      await c.query(
        "SELECT u.id,broiler_latest_position(u.id)::text AS position,(SELECT id FROM effective_daily_records WHERE unit_id=u.id ORDER BY recorded_on DESC LIMIT 1) AS daily_id FROM production_units u WHERE organization_id=$1 AND id=$2 AND kind='broilers'",
        [p.organizationId, p.unitId],
      )
    ).rows[0];
    if (!u) fail(404, "Broiler batch not found.");
    if (p.expectedPosition !== u.position || p.expectedDailyId !== u.daily_id)
      fail(
        409,
        "This batch changed after you loaded it. Keep your inputs, reload the evidence and review again.",
      );
    let source;
    if (p.kind === "daily")
      source = (
        await c.query(
          "SELECT coalesce(adjustment_id,id) AS source_id,mortality AS count FROM effective_daily_records WHERE organization_id=$1 AND unit_id=$2 AND recorded_on=$3",
          [p.organizationId, p.unitId, p.date],
        )
      ).rows[0];
    else
      source = (
        await c.query(
          "SELECT id AS source_id,quantity AS count FROM active_broiler_events WHERE organization_id=$1 AND unit_id=$2 AND id=$3 AND recorded_on=$4 AND kind='cull'",
          [p.organizationId, p.unitId, p.targetEventId, p.date],
        )
      ).rows[0];
    if (!source || source.count <= 0)
      fail(
        404,
        "Choose an existing positive daily death count or active cull from this batch.",
      );
    if (source.source_id !== p.sourceId || source.count !== p.sourceCount)
      fail(
        409,
        "The effective loss source or count changed. Reload and review the measured evidence.",
      );
    const head = (
      await c.query(
        "SELECT id FROM current_broiler_loss_reviews WHERE unit_id=$1 AND kind=$2 AND (($2='daily' AND observed_on=$3) OR ($2='cull' AND target_event_id=$4))",
        [p.unitId, p.kind, p.date, p.targetEventId],
      )
    ).rows[0];
    if ((head?.id ?? null) !== p.previousId)
      fail(
        409,
        "This loss has a newer weight review. Reload before making another decision.",
      );
    await c.query(
      "INSERT INTO broiler_loss_reviews(id,organization_id,unit_id,kind,observed_on,target_event_id,source_id,source_count,weight_kg,measurement_basis,previous_id,expected_position,expected_daily_id,reason,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
      [
        p.reviewId,
        p.organizationId,
        p.unitId,
        p.kind,
        p.date,
        p.targetEventId,
        p.sourceId,
        p.sourceCount,
        p.weightKg,
        p.measurementBasis,
        p.previousId,
        p.expectedPosition,
        p.expectedDailyId,
        p.reason,
        p.evidence,
      ],
    );
    await audit(c, p.organizationId, "broiler.loss_biomass_review", p.reviewId);
    return { id: p.reviewId, replayed: false };
  });
  return NextResponse.json(result, {
    status: result.replayed ? 200 : 201,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
