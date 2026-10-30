import type { PoolClient } from "pg";
import type { BroilerSource } from "./broiler-lifecycle";
import { fail } from "./http";
export async function readBroilerSource(
  c: PoolClient,
  org: string,
  unit: string,
): Promise<BroilerSource> {
  const source: BroilerSource | undefined = (
    await c.query(
      `SELECT to_jsonb(u)||jsonb_build_object('stocked_on',u.stocked_on::text,'initial_weight_g',u.initial_weight_g::text) AS unit,o.timezone,(now() AT TIME ZONE o.timezone)::date::text AS today,
   coalesce((SELECT jsonb_agg(to_jsonb(d)||jsonb_build_object('feed_kg',d.feed_kg::text,'average_weight_g',d.average_weight_g::text) ORDER BY d.recorded_on,d.id) FROM (SELECT * FROM effective_daily_records WHERE organization_id=$1 AND unit_id=$2 ORDER BY recorded_on,id LIMIT 10001)d),'[]'::jsonb) AS records,
   coalesce((SELECT jsonb_agg(to_jsonb(d)||jsonb_build_object('feed_kg',d.feed_kg::text,'average_weight_g',d.average_weight_g::text) ORDER BY d.recorded_on,d.id) FROM (SELECT * FROM daily_records WHERE organization_id=$1 AND unit_id=$2 ORDER BY recorded_on,id LIMIT 10001)d),'[]'::jsonb) AS "originalRecords",
   coalesce((SELECT jsonb_agg(to_jsonb(r)||jsonb_build_object('position',r.position::text,'expected_position',r.expected_position::text,'feed_kg',r.feed_kg::text,'average_weight_g',r.average_weight_g::text) ORDER BY r.position) FROM (SELECT * FROM broiler_reviews WHERE organization_id=$1 AND unit_id=$2 ORDER BY position LIMIT 10001)r),'[]'::jsonb) AS reviews,
   coalesce((SELECT jsonb_agg(to_jsonb(e)||jsonb_build_object('position',e.position::text,'expected_position',e.expected_position::text,'weight_kg',e.weight_kg::text,'price_per_unit',e.price_per_unit::text,'amount',e.amount::text) ORDER BY e.position) FROM (SELECT * FROM broiler_events WHERE organization_id=$1 AND unit_id=$2 ORDER BY position LIMIT 10001)e),'[]'::jsonb) AS events,
   coalesce((SELECT jsonb_agg(to_jsonb(l)||jsonb_build_object('position',l.position::text,'expected_position',l.expected_position::text,'weight_kg',l.weight_kg::text) ORDER BY l.position) FROM (SELECT * FROM broiler_loss_reviews WHERE organization_id=$1 AND unit_id=$2 ORDER BY position LIMIT 10001)l),'[]'::jsonb) AS "lossReviews",
   coalesce((SELECT jsonb_agg(to_jsonb(p)||jsonb_build_object('position',p.position::text,'expected_position',p.expected_position::text) ORDER BY p.position) FROM (SELECT * FROM broiler_processing_reviews WHERE organization_id=$1 AND unit_id=$2 ORDER BY position LIMIT 10001)p),'[]'::jsonb) AS "processingReviews"
   FROM production_units u JOIN organizations o ON o.id=u.organization_id WHERE u.organization_id=$1 AND u.id=$2 AND u.kind='broilers'`,
      [org, unit],
    )
  ).rows[0];
  if (!source) fail(404, "Broiler batch not found.");
  if (
    [
      source.events,
      source.records,
      source.originalRecords ?? [],
      source.reviews ?? [],
      source.lossReviews ?? [],
      source.processingReviews ?? [],
    ].some((rows) => rows.length > 10000) ||
    Buffer.byteLength(JSON.stringify(source)) > 4 * 1024 * 1024
  )
    fail(
      422,
      "This batch exceeds lifecycle report limits. Ask an administrator to review its source history.",
    );
  return source;
}
