import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { tenant } from "./db";
import { id } from "./validation";
import { fail, jsonBody, rateLimit } from "./http";
import {
  compareOptimizationRuns,
  optimizationComparisonSheets,
  type RunRecord,
} from "./optimization-comparison";
import { workbookBytes } from "./recipe-report-api";
import { sheetsCsv } from "./recipe-reports";
export const comparisonInput = z
  .object({
    organizationId: id,
    runIds: z
      .array(id)
      .min(2)
      .max(4)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Select distinct runs.",
      ),
    batchKg: z.number().finite().positive().max(1e8),
  })
  .strict();
export async function optimizationComparisonApi(
  request: NextRequest,
  user: { id: string },
  path: string,
) {
  if (
    path !== "optimization-runs/compare" ||
    !["GET", "POST"].includes(request.method)
  )
    return null;
  const input = comparisonInput.parse(
    request.method === "POST"
      ? await jsonBody(request)
      : {
          organizationId: request.nextUrl.searchParams.get("organizationId"),
          runIds: request.nextUrl.searchParams.getAll("runId"),
          batchKg: Number(request.nextUrl.searchParams.get("batchKg")),
        },
  );
  const format =
    request.method === "GET"
      ? z
          .enum(["csv", "xlsx"])
          .parse(request.nextUrl.searchParams.get("format"))
      : null;
  const comparison = await tenant(user.id, async (c) => {
    const records = (
      await c.query(
        "SELECT id,created_at,request,result FROM optimization_runs WHERE organization_id=$1 AND id=ANY($2::uuid[])",
        [input.organizationId, input.runIds],
      )
    ).rows as RunRecord[];
    if (records.length !== input.runIds.length)
      fail(404, "Optimization run not found.");
    return compareOptimizationRuns(
      input.runIds.map((id) => records.find((r) => r.id === id)!),
      input.batchKg,
    );
  });
  const digest = createHash("sha256")
    .update(JSON.stringify(comparison))
    .digest("hex");
  const headers = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Evidence-SHA256": digest,
  };
  if (!format)
    return NextResponse.json(
      { ...comparison, evidenceSha256: digest },
      { headers },
    );
  rateLimit(`optimization-comparison-export:${user.id}`);
  const sheets = optimizationComparisonSheets(
    comparison,
    input.organizationId,
    digest,
  );
  if (
    format === "xlsx" &&
    (sheets.some((s) => s.rows.length > 2000) ||
      sheets.reduce(
        (sum, s) => sum + s.rows.reduce((n, row) => n + row.length, 0),
        0,
      ) > 20000)
  )
    fail(
      422,
      "This comparison exceeds Excel report limits. Download CSV or JSON for the complete evidence.",
    );
  const body =
    format === "csv"
      ? sheetsCsv(sheets)
      : new Uint8Array(await workbookBytes(sheets));
  return new NextResponse(body, {
    headers: {
      ...headers,
      "Content-Type":
        format === "csv"
          ? "text/csv; charset=utf-8"
          : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="farmstead-optimizer-comparison.${format}"`,
    },
  });
}
