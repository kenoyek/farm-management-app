import { layerReportApi } from "./layer-report-api";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { tenant, audit } from "./db";
import { id } from "./validation";
import { jsonBody, fail } from "./http";
import { feedForecast, eggForecast } from "./forecast";
const day = z.iso.date();
const fraction = z.number().min(0).max(1);
const forecast = z.discriminatedUnion("kind", [
  z.object({
    organizationId: id,
    name: z.string().trim().min(2).max(100),
    kind: z.literal("layer-feed"),
    opening: z.number().positive().max(1e8),
    weeks: z
      .array(
        z.object({
          ration: z.number().nonnegative().max(1000),
          price: z.number().nonnegative().max(1e8),
          mortality: fraction,
        }),
      )
      .min(1)
      .max(104),
  }),
  z.object({
    organizationId: id,
    name: z.string().trim().min(2).max(100),
    kind: z.literal("layer-eggs"),
    opening: z.number().positive().max(1e8),
    startMonth: z.string().regex(/^\d{4}-\d{2}$/),
    traySize: z.number().int().min(1).max(1000),
    legacy28: z.boolean().default(false),
    periods: z
      .array(z.object({ lay: fraction, mortality: fraction, cracks: fraction }))
      .min(1)
      .max(60),
  }),
]);
export async function productionApi(
  request: NextRequest,
  user: { id: string },
  path: string,
) {
  const report = await layerReportApi(request, user, path);
  if (report) return report;
  const method = request.method;
  if (path === "forecasts" && method === "GET") {
    const org = id.parse(request.nextUrl.searchParams.get("organizationId"));
    return NextResponse.json(
      await tenant(
        user.id,
        async (c) =>
          (
            await c.query(
              "SELECT * FROM forecasts WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100",
              [org],
            )
          ).rows,
      ),
    );
  }
  if (
    ["forecasts/calculate", "forecasts/save"].includes(path) &&
    method === "POST"
  ) {
    const input = forecast.parse(await jsonBody(request));
    const result =
      input.kind === "layer-feed"
        ? feedForecast(input.opening, input.weeks)
        : eggForecast(
            input.opening,
            input.startMonth,
            input.periods,
            input.traySize,
            input.legacy28,
          );
    return NextResponse.json(
      await tenant(user.id, async (c) => {
        if (
          !(
            await c.query("SELECT id FROM organizations WHERE id=$1", [
              input.organizationId,
            ])
          ).rowCount
        )
          fail(404, "Organization not found.");
        if (path === "forecasts/calculate") return result;
        const r = (
          await c.query(
            "INSERT INTO forecasts(organization_id,name,kind,input,result) VALUES($1,$2,$3,$4,$5) RETURNING id",
            [
              input.organizationId,
              input.name,
              input.kind,
              JSON.stringify(input),
              JSON.stringify(result),
            ],
          )
        ).rows[0];
        await audit(c, input.organizationId, "forecast.saved", r.id);
        return { id: r.id, ...result };
      }),
    );
  }
  if (path === "production" && method === "GET") {
    const org = id.parse(request.nextUrl.searchParams.get("organizationId"));
    return NextResponse.json(
      await tenant(user.id, async (c) => ({
        units: (
          await c.query(
            "SELECT id,organization_id,farm_id,name,kind,stocked_on::text,opening_count,initial_weight_g,created_at FROM production_units WHERE organization_id=$1 ORDER BY created_at DESC",
            [org],
          )
        ).rows,
        records: (
          await c.query(
            "SELECT id,organization_id,unit_id,recorded_on::text,mortality,eggs,cracked,feed_kg,average_weight_g,sample_size,water_quality,notes,created_at FROM daily_records WHERE organization_id=$1 ORDER BY recorded_on,id",
            [org],
          )
        ).rows,
      })),
    );
  }
  if (path === "units" && method === "POST") {
    const input = z
      .object({
        organizationId: id,
        farmId: id,
        name: z.string().trim().min(2).max(100),
        kind: z.enum(["layers", "broilers", "catfish"]),
        stockedOn: day,
        openingCount: z.number().int().positive().max(1e8),
        initialWeightG: z.number().positive().max(1e6),
      })
      .parse(await jsonBody(request));
    if (input.stockedOn > new Date().toISOString().slice(0, 10))
      fail(400, "Stocking date must not be in the future.");
    return NextResponse.json(
      await tenant(user.id, async (c) => {
        const r = (
          await c.query(
            "INSERT INTO production_units(organization_id,farm_id,name,kind,stocked_on,opening_count,initial_weight_g) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
            [
              input.organizationId,
              input.farmId,
              input.name,
              input.kind,
              input.stockedOn,
              input.openingCount,
              input.initialWeightG,
            ],
          )
        ).rows[0];
        await audit(c, input.organizationId, "unit.stocked", r.id);
        return r;
      }),
      { status: 201 },
    );
  }
  if (path === "records" && method === "POST") {
    const input = z
      .object({
        organizationId: id,
        unitId: id,
        recordedOn: day,
        mortality: z.number().int().nonnegative().max(1e8),
        eggs: z.number().int().nonnegative().max(1e8),
        cracked: z.number().int().nonnegative().max(1e8),
        feedKg: z.number().nonnegative().max(1e8),
        averageWeightG: z.number().positive().max(1e6).nullable(),
        sampleSize: z.number().int().positive().nullable(),
        waterQuality: z
          .object({
            temperature: z.number().min(0).max(60).nullable(),
            ph: z.number().min(0).max(14).nullable(),
            oxygen: z.number().nonnegative().nullable(),
            ammonia: z.number().nonnegative().nullable(),
          })
          .nullable(),
        notes: z.string().max(2000),
      })
      .parse(await jsonBody(request));
    if (input.cracked > input.eggs)
      fail(400, "Cracked eggs cannot exceed total eggs.");
    return NextResponse.json(
      await tenant(user.id, async (c) => {
        const r = (
          await c.query(
            "INSERT INTO daily_records(organization_id,unit_id,recorded_on,mortality,eggs,cracked,feed_kg,average_weight_g,sample_size,water_quality,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id",
            [
              input.organizationId,
              input.unitId,
              input.recordedOn,
              input.mortality,
              input.eggs,
              input.cracked,
              input.feedKg,
              input.averageWeightG,
              input.sampleSize,
              input.waterQuality ? JSON.stringify(input.waterQuality) : null,
              input.notes,
            ],
          )
        ).rows[0];
        await audit(c, input.organizationId, "production.recorded", r.id);
        return r;
      }),
      { status: 201 },
    );
  }
  return null;
}
