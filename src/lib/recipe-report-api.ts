import { remoteWorker } from "./remote-worker";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { PoolClient } from "pg";
import { tenant } from "./db";
import { fail, HttpError, jsonBody, rateLimit } from "./http";
import { id } from "./validation";
import {
  recipeReport,
  compareRecipes,
  recipeSheets,
  sheetsCsv,
  type ReportSheet,
} from "./recipe-reports";

let exporting = 0;
export async function workbookBytes(sheets: ReportSheet[]): Promise<Buffer> {
  const payload = JSON.stringify({ sheets });
  if (Buffer.byteLength(payload) > 2 * 1024 * 1024)
    fail(422, "Report is too large.");
  if (exporting >= 2) fail(429, "Workbook export is busy. Try again shortly.");
  exporting++;
  try {
    const remote = await remoteWorker("export", Buffer.from(payload));
    if (remote !== null) {
      if (remote.length < 4 || remote.readUInt32LE(0) !== 0x04034b50)
        fail(503, "Workbook could not be generated.");
      return remote;
    }
    return await new Promise((resolve, reject) => {
      const child = spawn(
        /* turbopackIgnore: true */ process.env.FARM_PYTHON ?? "python",
        ["scripts/export_recipe.py"],
        {
          cwd: process.cwd(),
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            OPENPYXL_DEFUSEDXML: "True",
            OPENPYXL_LXML: "False",
          },
        },
      );
      let stopped = false,
        size = 0;
      const chunks: Buffer[] = [];
      const stop = (error: HttpError) => {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        child.kill();
        reject(error);
      };
      const timer = setTimeout(
        () =>
          stop(new HttpError(503, "Workbook export exceeded its time limit.")),
        10000,
      );
      child.on("error", () =>
        stop(new HttpError(503, "Workbook exporter is unavailable.")),
      );
      child.stdin.on("error", () => {});
      child.stderr.on("data", () => {});
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024)
          stop(new HttpError(422, "Workbook output is too large."));
        else chunks.push(chunk);
      });
      child.on("close", (code) => {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        const bytes = Buffer.concat(chunks);
        if (
          code !== 0 ||
          bytes.length < 4 ||
          bytes.readUInt32LE(0) !== 0x04034b50
        )
          reject(
            new HttpError(
              503,
              "Workbook could not be generated. CSV export remains available.",
            ),
          );
        else resolve(bytes);
      });
      child.stdin.end(payload);
    });
  } finally {
    exporting--;
  }
}
export async function loadRecipeReports(
  c: PoolClient,
  org: string,
  ids: string[],
) {
  const rows = (
    await c.query(
      "SELECT f.*,row_to_json(p) AS profile_reference FROM formula_versions f LEFT JOIN requirement_profiles p ON p.organization_id=f.organization_id AND p.id=f.profile_id WHERE f.organization_id=$1 AND f.id=ANY($2::uuid[])",
      [org, ids],
    )
  ).rows;
  if (rows.length !== ids.length) fail(404, "Saved recipe version not found.");
  return ids.map((id) => {
    try {
      return recipeReport(rows.find((r) => r.id === id));
    } catch {
      fail(
        422,
        "This saved version has incomplete report evidence. Its historical data has not been changed.",
      );
    }
  });
}
export async function recipeReportApi(
  request: NextRequest,
  user: { id: string },
  path: string,
) {
  if (path === "formulas/compare" && request.method === "POST") {
    const input = z
      .object({
        organizationId: id,
        recipeIds: z
          .array(id)
          .min(2)
          .max(4)
          .refine(
            (ids) => new Set(ids).size === ids.length,
            "Choose distinct saved versions.",
          ),
        batchKg: z.number().finite().positive().max(1e8),
      })
      .strict()
      .parse(await jsonBody(request));
    const reports = await tenant(user.id, (c) =>
      loadRecipeReports(c, input.organizationId, input.recipeIds),
    );
    return NextResponse.json(compareRecipes(reports, input.batchKg), {
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  const match = /^formulas\/([^/]+)\/export$/.exec(path);
  if (!match || request.method !== "GET") return null;
  const recipeId = id.parse(match[1]);
  const org = id.parse(request.nextUrl.searchParams.get("organizationId"));
  const format = z
    .enum(["csv", "xlsx"])
    .parse(request.nextUrl.searchParams.get("format"));
  const [report] = await tenant(user.id, (c) =>
    loadRecipeReports(c, org, [recipeId]),
  );
  rateLimit(`recipe-export:${user.id}`);
  const digest = createHash("sha256")
    .update(JSON.stringify(report))
    .digest("hex");
  const sheets = recipeSheets(report, org, digest);
  const headers = {
    "Content-Type":
      format === "csv"
        ? "text/csv; charset=utf-8"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="farmstead-${recipeId}.${format}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Recipe-Snapshot-SHA256": digest,
  };
  if (format === "csv") return new NextResponse(sheetsCsv(sheets), { headers });
  return new NextResponse(new Uint8Array(await workbookBytes(sheets)), {
    headers,
  });
}
