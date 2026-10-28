import { NextRequest, NextResponse } from "next/server";
import { tenant, audit } from "./db";
import { fail, jsonBody } from "./http";
import { broilerReviewInput } from "./broiler-recovery";
export async function broilerRecoveryApi(
  request: NextRequest,
  user: { id: string },
  path: string,
) {
  if (path !== "broilers/recovery" || request.method !== "POST") return null;
  const p = broilerReviewInput.parse(await jsonBody(request));
  const result = await tenant(user.id, async (c) => {
    const role = (
      await c.query("SELECT member_role($1) AS role", [p.organizationId])
    ).rows[0].role;
    if (!["owner", "admin", "manager"].includes(role))
      fail(
        403,
        "Only an owner, administrator or manager can review broiler recovery.",
      );
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [p.unitId]);
    const old = (
      await c.query(
        "SELECT id,submission=$2::jsonb AS same FROM broiler_reviews WHERE id=$1",
        [p.eventId, JSON.stringify(p)],
      )
    ).rows[0];
    if (old) {
      if (!old.same)
        fail(
          409,
          "This recovery receipt was already used for different values.",
        );
      return { id: old.id, replayed: true };
    }
    const u = (
      await c.query(
        `SELECT u.id,u.stocked_on::text,(now() AT TIME ZONE o.timezone)::date::text AS today,broiler_latest_position(u.id)::text AS position,
   (SELECT id FROM effective_daily_records WHERE unit_id=u.id ORDER BY recorded_on DESC LIMIT 1) AS daily_id,
   greatest((SELECT max(recorded_on) FROM effective_daily_records WHERE unit_id=u.id),(SELECT max(recorded_on) FROM broiler_events WHERE unit_id=u.id),(SELECT max(observed_on) FROM broiler_reviews WHERE unit_id=u.id AND kind='withdrawal'))::text AS last_day
   FROM production_units u JOIN organizations o ON o.id=u.organization_id WHERE u.id=$1 AND u.organization_id=$2 AND u.kind='broilers'`,
        [p.unitId, p.organizationId],
      )
    ).rows[0];
    if (!u) fail(404, "Broiler batch not found.");
    if (p.expectedPosition !== u.position || p.expectedDailyId !== u.daily_id)
      fail(
        409,
        "This batch changed after you loaded it. Reload and review the source evidence again.",
      );
    if (p.date < u.stocked_on || p.date > u.today)
      fail(
        400,
        "Choose an observation date from stocking through today in the organization timezone.",
      );
    let head;
    if (p.kind === "daily") {
      const original = (
        await c.query(
          "SELECT id FROM daily_records WHERE organization_id=$1 AND unit_id=$2 AND recorded_on=$3",
          [p.organizationId, p.unitId, p.date],
        )
      ).rows[0];
      if ((original?.id ?? null) !== p.baseRecordId)
        fail(
          409,
          "The original daily source does not match. Reload the batch before reviewing.",
        );
      head = (
        await c.query(
          "SELECT id FROM current_broiler_reviews WHERE unit_id=$1 AND kind='daily' AND observed_on=$2",
          [p.unitId, p.date],
        )
      ).rows[0];
    } else {
      const t = (
        await c.query(
          "SELECT id,recorded_on::text FROM active_broiler_events WHERE organization_id=$1 AND unit_id=$2 AND id=$3 AND kind='treatment'",
          [p.organizationId, p.unitId, p.treatmentId],
        )
      ).rows[0];
      if (!t) fail(404, "Choose a genuine active treatment from this batch.");
      if (
        p.date < u.last_day ||
        (p.earliestHarvestOn !== null && p.earliestHarvestOn < t.recorded_on)
      )
        fail(
          400,
          "The guidance review must follow recorded activity. Its earliest harvest date cannot precede the original administration.",
        );
      head = (
        await c.query(
          "SELECT id FROM current_broiler_reviews WHERE treatment_id=$1 AND kind='withdrawal'",
          [p.treatmentId],
        )
      ).rows[0];
    }
    if ((head?.id ?? null) !== p.previousId)
      fail(
        409,
        "This review has a newer version. Reload before recording another decision.",
      );
    await c.query(
      `INSERT INTO broiler_reviews(id,organization_id,unit_id,kind,observed_on,previous_id,base_record_id,treatment_id,mortality,feed_kg,average_weight_g,sample_size,notes,earliest_harvest_on,expected_position,expected_daily_id,reason,evidence,submission)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        p.eventId,
        p.organizationId,
        p.unitId,
        p.kind,
        p.date,
        p.previousId,
        p.kind === "daily" ? p.baseRecordId : null,
        p.kind === "withdrawal" ? p.treatmentId : null,
        p.kind === "daily" ? p.mortality : null,
        p.kind === "daily" ? p.feedKg : null,
        p.kind === "daily" ? p.averageWeightG : null,
        p.kind === "daily" ? p.sampleSize : null,
        p.kind === "daily" ? p.notes : null,
        p.kind === "withdrawal" ? p.earliestHarvestOn : null,
        p.expectedPosition,
        p.expectedDailyId,
        p.reason,
        p.evidence,
        JSON.stringify(p),
      ],
    );
    await audit(c, p.organizationId, "broiler.review_" + p.kind, p.eventId);
    return { id: p.eventId, replayed: false };
  });
  return NextResponse.json(result, {
    status: result.replayed ? 200 : 201,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
