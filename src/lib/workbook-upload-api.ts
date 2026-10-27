import { remoteWorker } from "./remote-worker";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { tenant, audit } from "./db";
import { id } from "./validation";
import { fail, jsonBody, rateLimit, HttpError, boundedBody } from "./http";
import {
  inspectionSchema,
  suggestMapping,
  previewUpload,
  uploadMapping,
  type Inspection,
  type ImportPreview,
  type UploadMapping,
  columnName,
} from "./upload-model";
const MAX_UPLOAD = 2 * 1024 * 1024;
let inspecting = 0;
export async function inspectUpload(bytes: Buffer): Promise<Inspection> {
  if (bytes.length > MAX_UPLOAD)
    fail(413, "Workbook exceeds the 2 MB upload limit.");
  if (inspecting >= 2)
    fail(429, "Workbook inspection is busy. Try again shortly.");
  inspecting++;
  try {
    const remote = await remoteWorker("inspect", bytes);
    if (remote !== null)
      return inspectionSchema.parse(JSON.parse(remote.toString("utf8")));
    return await new Promise((resolve, reject) => {
      const worker = spawn(
        /* turbopackIgnore: true */ process.env.FARM_PYTHON ?? "python",
        ["scripts/inspect_upload.py"],
        { stdio: ["pipe", "pipe", "pipe"], cwd: process.cwd() },
      );
      let output = "";
      let stopped = false;
      const end = (error: Error) => {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        worker.kill();
        reject(error);
      };
      const timer = setTimeout(
        () =>
          end(
            new HttpError(422, "Workbook inspection exceeded its time limit."),
          ),
        10000,
      );
      worker.on("error", () =>
        end(new HttpError(503, "Workbook inspector is unavailable.")),
      );
      worker.stdin.on("error", () => {});
      worker.stdout.on("data", (d) => {
        output += d.toString();
        if (Buffer.byteLength(output) > 4 * 1024 * 1024)
          end(new HttpError(422, "Workbook inspection output is too large."));
      });
      worker.stderr.on("data", () => {});
      worker.on("close", (code, signal) => {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        try {
          if (!output.trim())
            fail(
              signal ? 422 : 503,
              signal
                ? "Workbook inspection exceeded limits."
                : "Workbook inspector is unavailable.",
            );
          const value = JSON.parse(output);
          if (code !== 0)
            fail(
              422,
              typeof value.error === "string"
                ? value.error
                : "Workbook could not be inspected.",
            );
          resolve(inspectionSchema.parse(value));
        } catch (error) {
          reject(error);
        }
      });
      worker.stdin.end(bytes);
    });
  } finally {
    inspecting--;
  }
}
export async function uploadEditor(c: PoolClient, org: string) {
  if (
    !["owner", "admin", "nutritionist"].includes(
      (await c.query("SELECT member_role($1) AS role", [org])).rows[0].role,
    )
  )
    fail(403, "Only feed editors can upload or import workbooks.");
}
const summary = "id,filename,sha256,state,revision,created_at,confirmed_at";
export async function storeUpload(
  c: PoolClient,
  org: string,
  filename: string,
  bytes: Buffer,
  inspection: Inspection,
) {
  await uploadEditor(c, org);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const inserted = await c.query(
    `INSERT INTO workbook_uploads(organization_id,filename,sha256,raw_bytes,inspection) VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,sha256) DO NOTHING RETURNING ${summary}`,
    [org, filename, digest, bytes, JSON.stringify(inspection)],
  );
  if (inserted.rowCount) {
    await audit(c, org, "workbook.uploaded", inserted.rows[0].id);
    return inserted.rows[0];
  }
  return (
    await c.query(
      `SELECT ${summary} FROM workbook_uploads WHERE organization_id=$1 AND sha256=$2`,
      [org, digest],
    )
  ).rows[0];
}
async function locked(c: PoolClient, org: string, jobId: string) {
  await uploadEditor(c, org);
  const job = (
    await c.query(
      "SELECT * FROM workbook_uploads WHERE organization_id=$1 AND id=$2 FOR UPDATE",
      [org, jobId],
    )
  ).rows[0];
  if (!job) fail(404, "Workbook upload not found.");
  return job;
}
export async function mapUpload(
  c: PoolClient,
  org: string,
  jobId: string,
  revision: number,
  mapping: UploadMapping,
) {
  const job = await locked(c, org, jobId);
  if (job.state === "confirmed")
    fail(409, "This workbook has already been imported.");
  if (job.revision !== revision)
    fail(
      409,
      "This mapping changed in another tab. Reload the upload before previewing again.",
    );
  let preview: ImportPreview;
  try {
    preview = previewUpload(job.inspection, mapping);
  } catch (e) {
    fail(400, (e as Error).message);
  }
  const changed = (
    await c.query(
      "UPDATE workbook_uploads SET mapping=$3,preview=$4,state='previewed',revision=revision+1 WHERE organization_id=$1 AND id=$2 RETURNING revision",
      [org, jobId, JSON.stringify(mapping), JSON.stringify(preview)],
    )
  ).rows[0];
  await audit(c, org, "workbook.previewed", jobId);
  return { preview, mapping, revision: changed.revision };
}
export async function confirmUpload(
  c: PoolClient,
  org: string,
  jobId: string,
  revision: number,
) {
  const job = await locked(c, org, jobId);
  if (job.revision !== revision)
    fail(409, "The preview changed. Reload and review it before confirming.");
  if (job.state === "confirmed")
    return { count: job.preview.validCount, id: job.id, alreadyImported: true };
  if (
    job.state !== "previewed" ||
    !job.preview ||
    job.preview.errorCount ||
    !job.preview.validCount
  )
    fail(
      422,
      "Preview valid rows and resolve every row error before confirming.",
    );
  const preview = job.preview as ImportPreview;
  const mapping = job.mapping as UploadMapping;
  for (const row of preview.rows.filter((r) => r.status === "valid"))
    await c.query(
      "INSERT INTO ingredients(organization_id,name,source,nutrients,price,upload_id,upload_row) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        org,
        row.name,
        `${job.filename} / ${mapping.sheet} / row ${row.row}; SHA-256 ${job.sha256}; cells ${Object.values(row.sourceCells).join(", ")}`,
        JSON.stringify(row.nutrients),
        row.price,
        job.id,
        row.row,
      ],
    );
  await c.query(
    "UPDATE workbook_uploads SET state='confirmed',confirmed_at=now() WHERE organization_id=$1 AND id=$2",
    [org, jobId],
  );
  await audit(c, org, "workbook.imported", jobId);
  return { id: job.id, count: preview.validCount, alreadyImported: false };
}
async function multipart(request: Request) {
  const type = request.headers.get("content-type");
  if (!type?.startsWith("multipart/form-data"))
    fail(415, "Upload a workbook using the file form.");
  const buffer = await boundedBody(request, MAX_UPLOAD + 65536);
  try {
    return await new Request("http://upload.local", {
      method: "POST",
      headers: { "content-type": type },
      body: buffer,
    }).formData();
  } catch {
    fail(400, "Invalid workbook upload form.");
  }
}
function publicInspection(book: Inspection) {
  return {
    sheets: book.sheets.map((s) => {
      const rows = [...new Set(s.cells.map((c) => c.row))]
        .sort((a, b) => a - b)
        .slice(0, 10);
      return {
        name: s.name,
        rows: s.rows,
        columns: s.columns,
        samples: rows.map((row) => ({
          row,
          values: Object.fromEntries(
            s.cells
              .filter((c) => c.row === row)
              .map((c) => [columnName(c.column), String(c.value)]),
          ),
        })),
      };
    }),
  };
}
export async function workbookUploadApi(
  request: NextRequest,
  user: { id: string },
  path: string,
) {
  const parts = path.split("/");
  if (parts[0] !== "workbook-uploads") return null;
  if (parts.length === 1 && request.method === "POST") {
    rateLimit(`workbook-upload:${user.id}`);
    const form = await multipart(request);
    if ([...form.keys()].length !== 2)
      fail(400, "Provide one workbook and one organization.");
    const org = id.parse(form.get("organizationId"));
    const file = form.get("file");
    if (
      !(file instanceof File) ||
      !file.name.toLowerCase().endsWith(".xlsx") ||
      file.name.length > 200 ||
      /[\\/\x00-\x1f\x7f]/.test(file.name)
    )
      fail(400, "Choose an .xlsx file with a valid filename.");
    if (file.size > MAX_UPLOAD)
      fail(413, "Workbook exceeds the 2 MB upload limit.");
    await tenant(user.id, (c) => uploadEditor(c, org));
    const bytes = Buffer.from(await file.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    const existing = await tenant(
      user.id,
      async (c) =>
        (
          await c.query(
            `SELECT ${summary} FROM workbook_uploads WHERE organization_id=$1 AND sha256=$2`,
            [org, digest],
          )
        ).rows[0],
    );
    if (existing) return NextResponse.json(existing);
    const inspection = await inspectUpload(bytes);
    return NextResponse.json(
      await tenant(user.id, (c) =>
        storeUpload(c, org, file.name, bytes, inspection),
      ),
      { status: 201 },
    );
  }
  const org = id.parse(request.nextUrl.searchParams.get("organizationId"));
  if (parts.length === 1 && request.method === "GET")
    return NextResponse.json(
      await tenant(
        user.id,
        async (c) =>
          (
            await c.query(
              `SELECT ${summary} FROM workbook_uploads WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100`,
              [org],
            )
          ).rows,
      ),
    );
  const jobId = id.parse(parts[1]);
  if (parts.length === 2 && request.method === "GET")
    return NextResponse.json(
      await tenant(user.id, async (c) => {
        const job = (
          await c.query(
            `SELECT ${summary},inspection,mapping,preview FROM workbook_uploads WHERE organization_id=$1 AND id=$2`,
            [org, jobId],
          )
        ).rows[0];
        if (!job) fail(404, "Workbook upload not found.");
        return {
          ...job,
          inspection: publicInspection(job.inspection),
          suggestedMapping: suggestMapping(job.inspection),
          suggestedMappings: Object.fromEntries(
            (job.inspection as Inspection).sheets.map((s) => [
              s.name,
              suggestMapping({ sheets: [s] }),
            ]),
          ),
        };
      }),
    );
  if (parts[2] === "download" && parts.length === 3 && request.method === "GET")
    return tenant(user.id, async (c) => {
      const job = (
        await c.query(
          "SELECT filename,raw_bytes FROM workbook_uploads WHERE organization_id=$1 AND id=$2",
          [org, jobId],
        )
      ).rows[0];
      if (!job) fail(404, "Workbook upload not found.");
      const encoded = encodeURIComponent(job.filename).replace(
        /['()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16)}`,
      );
      return new NextResponse(new Uint8Array(job.raw_bytes), {
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="source-workbook.xlsx"; filename*=UTF-8''${encoded}`,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    });
  if (
    parts[2] === "preview" &&
    parts.length === 3 &&
    request.method === "POST"
  ) {
    const input = z
      .object({
        expectedRevision: z.number().int().nonnegative().max(2147483646),
        mapping: uploadMapping,
      })
      .strict()
      .parse(await jsonBody(request));
    return NextResponse.json(
      await tenant(user.id, (c) =>
        mapUpload(c, org, jobId, input.expectedRevision, input.mapping),
      ),
    );
  }
  if (
    parts[2] === "confirm" &&
    parts.length === 3 &&
    request.method === "POST"
  ) {
    const input = z
      .object({
        expectedRevision: z.number().int().nonnegative(),
        confirmed: z.literal(true),
      })
      .strict()
      .parse(await jsonBody(request));
    return NextResponse.json(
      await tenant(user.id, (c) =>
        confirmUpload(c, org, jobId, input.expectedRevision),
      ),
    );
  }
  fail(405, "Unsupported workbook upload action.");
}
