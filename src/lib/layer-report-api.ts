import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { tenant } from "./db";
import { fail, jsonBody, rateLimit } from "./http";
import {
  layerReport,
  layerReportInput,
  layerReportSheets,
  layerSource,
} from "./layer-report";
import { sheetsCsv } from "./recipe-reports";
export async function layerReportApi(
  request: NextRequest,
  user: { id: string },
  path: string,
) {
  if (path !== "layers/report" || !["GET", "POST"].includes(request.method))
    return null;
  const query = request.nextUrl.searchParams;
  const input = layerReportInput.parse(
    request.method === "POST"
      ? await jsonBody(request)
      : {
          organizationId: query.get("organizationId"),
          unitId: query.get("unitId"),
          from: query.get("from"),
          to: query.get("to"),
          traySize: Number(query.get("traySize")),
          forecastId: query.get("forecastId"),
        },
  );
  const format =
    request.method === "GET"
      ? z.enum(["csv", "json"]).parse(query.get("format"))
      : null;
  rateLimit(`layer-report:${user.id}`);
  const raw = await tenant(user.id, async (c) => {
    const row = (
      await c.query(
        `SELECT o.timezone,to_jsonb(u) AS unit,
   coalesce((SELECT jsonb_agg(to_jsonb(d) || jsonb_build_object('feed_kg',d.feed_kg::text) ORDER BY d.recorded_on,d.id)
    FROM (SELECT * FROM daily_records WHERE organization_id=$1 AND unit_id=$2 AND recorded_on<=$3 ORDER BY recorded_on,id LIMIT 10001) d),'[]'::jsonb) AS records,
   coalesce((SELECT jsonb_agg(to_jsonb(a)||jsonb_build_object('feed_kg',a.feed_kg::text) ORDER BY a.created_at,a.id) FROM
    (SELECT * FROM layer_adjustments WHERE organization_id=$1 AND unit_id=$2 AND observed_on<=$3 ORDER BY created_at,id LIMIT 10001) a),'[]'::jsonb) AS adjustments,
   (SELECT to_jsonb(f) FROM forecasts f WHERE f.organization_id=$1 AND f.id=$4) AS forecast
   FROM production_units u JOIN organizations o ON o.id=u.organization_id WHERE u.organization_id=$1 AND u.id=$2`,
        [input.organizationId, input.unitId, input.to, input.forecastId],
      )
    ).rows[0];
    if (!row || (input.forecastId && !row.forecast))
      fail(404, "Flock or saved forecast not found.");
    if (row.unit.kind !== "layers")
      fail(422, "Choose a layer flock for hen-day reporting.");
    if (!row.adjustments.length) delete row.adjustments;
    return row;
  });
  if (Buffer.byteLength(JSON.stringify(raw)) > 1024 * 1024)
    fail(
      422,
      "This flock history exceeds report limits. Export its daily production records for review.",
    );
  const generatedAt = new Date();
  let source, report;
  try {
    source = layerSource.parse(raw);
    report = layerReport(input, source, generatedAt);
  } catch (error) {
    fail(
      422,
      error instanceof Error && !("issues" in error)
        ? error.message
        : "The saved production or forecast evidence is incomplete.",
    );
  }
  const evidence = { input, source, report };
  const digest = createHash("sha256")
    .update(JSON.stringify(evidence))
    .digest("hex");
  const document = {
    ...report,
    evidenceSha256: digest,
    generatedAt: generatedAt.toISOString(),
    sourceSnapshot: source,
  };
  const headers = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Layer-Snapshot-SHA256": digest,
  };
  if (!format) return NextResponse.json(document, { headers });
  return new NextResponse(
    format === "csv"
      ? sheetsCsv(layerReportSheets(report, digest, source))
      : JSON.stringify(document, null, 2),
    {
      headers: {
        ...headers,
        "Content-Type":
          format === "csv"
            ? "text/csv; charset=utf-8"
            : "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="farmstead-layer-${input.unitId}.${format}"`,
      },
    },
  );
}
