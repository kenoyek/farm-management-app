import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { tenant, audit } from "./db";
import { fail, jsonBody } from "./http";
import {
  chart,
  chartVersion,
  journalModel,
  journalDay,
  journalInput,
  journalCsv,
  trialBalance,
  type JournalEntry,
  type JournalReport,
  type JournalInput,
  type FinancialSource,
  type JournalWorkspace,
} from "./financial-journal";
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const position = z.string().regex(/^(0|[1-9]\d{0,18})$/);
async function financeRole(c: PoolClient, org: string, write = false) {
  const role = (await c.query("SELECT member_role($1) AS role", [org])).rows[0]
    .role;
  if (
    !(
      write
        ? ["owner", "admin", "manager"]
        : ["owner", "admin", "manager", "auditor"]
    ).includes(role)
  )
    fail(
      403,
      write
        ? "Only an owner, administrator or manager can post financial entries."
        : "Your current role cannot read this organization's financial journal.",
    );
}
async function context(c: PoolClient, org: string) {
  return (
    await c.query(
      "SELECT (now() AT TIME ZONE timezone)::date::text AS today,(SELECT coalesce(max(position),0)::text FROM financial_journal_entries WHERE organization_id=$1) AS head FROM organizations WHERE id=$1",
      [org],
    )
  ).rows[0] as { today: string; head: string };
}
async function report(
  c: PoolClient,
  org: string,
  asOf: string,
  through: string,
): Promise<JournalReport> {
  const entries: JournalEntry[] = (
    await c.query(
      `SELECT to_jsonb(e)||jsonb_build_object('position',e.position::text,'expected_position',e.expected_position::text,'posted_on',e.posted_on::text) AS entry FROM financial_journal_entries e WHERE organization_id=$1 AND posted_on<=$2::date AND position<=$3::bigint ORDER BY position LIMIT 1001`,
      [org, asOf, through],
    )
  ).rows.map((r) => r.entry);
  if (
    entries.length > 1000 ||
    entries.some(
      (e) =>
        e.model_version !== journalModel || e.chart_version !== chartVersion,
    )
  )
    fail(
      422,
      "This journal exceeds its entry limit or uses an unsupported model.",
    );
  const normalized = {
      modelVersion: journalModel,
      chartVersion,
      organizationId: org,
      asOf,
      throughPosition: through,
      accounts: chart,
      entries,
      trialBalance: trialBalance(entries),
    },
    r = { ...normalized, evidenceSha256: digest(normalized) };
  if (
    Buffer.byteLength(JSON.stringify(normalized)) > 1024 * 1024 ||
    Buffer.byteLength(journalCsv(r)) > 3 * 1024 * 1024
  )
    fail(
      422,
      "This report exceeds the 1 MiB journal evidence / 3 MiB CSV limit. Select an earlier date or append-position cutoff.",
    );
  return r;
}
async function lockEntry(c: PoolClient, p: JournalInput) {
  let unit: string | null = null;
  if (p.data.kind === "manual") unit = p.data.unitId;
  else if (p.data.kind === "recognize_sale")
    unit =
      (
        await c.query(
          p.data.sourceKind === "live"
            ? "SELECT unit_id FROM broiler_events WHERE organization_id=$1 AND id=$2"
            : "SELECT unit_id FROM broiler_product_events WHERE organization_id=$1 AND id=$2",
          [p.organizationId, p.data.sourceId],
        )
      ).rows[0]?.unit_id ?? null;
  else
    unit =
      (
        await c.query(
          "SELECT unit_id FROM financial_journal_entries WHERE organization_id=$1 AND id=$2",
          [p.organizationId, p.data.originalId],
        )
      ).rows[0]?.unit_id ?? null;
  if (unit) await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [unit]);
  await c.query("SELECT pg_advisory_xact_lock(812,hashtext($1))", [
    p.organizationId,
  ]);
}
export async function financialJournalApi(
  request: NextRequest,
  user: { id: string },
  path: string,
) {
  if (path !== "finance/journal" || !["GET", "POST"].includes(request.method))
    return null;
  if (request.method === "GET") {
    const org = z
        .uuid()
        .parse(request.nextUrl.searchParams.get("organizationId")),
      asOf = journalDay
        .nullable()
        .parse(request.nextUrl.searchParams.get("asOf")),
      through = position
        .nullable()
        .parse(request.nextUrl.searchParams.get("throughPosition")),
      format = z
        .enum(["workspace", "json", "csv"])
        .parse(request.nextUrl.searchParams.get("format") ?? "workspace"),
      search = z
        .string()
        .trim()
        .max(80)
        .parse(request.nextUrl.searchParams.get("search") ?? ""),
      status = z
        .enum(["unrecognized", "all"])
        .parse(
          request.nextUrl.searchParams.get("sourceStatus") ?? "unrecognized",
        );
    const w = await tenant(user.id, async (c) => {
      await financeRole(c, org);
      await c.query("SELECT pg_advisory_xact_lock(812,hashtext($1))", [org]);
      const ctx = await context(c, org),
        day = asOf ?? ctx.today,
        cutoff = through ?? ctx.head;
      if (day > ctx.today || BigInt(cutoff) > BigInt(ctx.head))
        fail(
          400,
          "Choose a journal date and append-position cutoff no later than the loaded ledger.",
        );
      const r = await report(c, org, day, cutoff);
      if (format !== "workspace") return r;
      const needle = "%" + search.replace(/[\\%_]/g, "\\$&") + "%";
      const rows = (
        await c.query(
          `SELECT s.*,s.recorded_on::text,(SELECT j.id FROM financial_journal_entries j WHERE j.organization_id=s.organization_id AND j.kind='recognize_sale' AND j.source_kind=s.source_kind AND j.source_id=s.source_id AND NOT EXISTS(SELECT 1 FROM financial_journal_entries v WHERE v.reversal_of_id=j.id) LIMIT 1) AS recognized_id,count(*) OVER()::int AS matches FROM financial_broiler_sources s WHERE s.organization_id=$1 AND (s.reference ILIKE $2 OR s.customer ILIKE $2 OR s.unit_name ILIKE $2) AND ($3='all' OR NOT financial_sale_is_booked(s.organization_id,s.source_kind,s.source_id)) ORDER BY s.recorded_on DESC,s.source_kind,s.source_id LIMIT 200`,
          [org, needle, status],
        )
      ).rows;
      const counts = (
        await c.query(
          "SELECT count(*)::int AS active,count(*) FILTER(WHERE NOT financial_sale_is_booked(organization_id,source_kind,source_id))::int AS unrecognized FROM financial_broiler_sources WHERE organization_id=$1",
          [org],
        )
      ).rows[0];
      const units = (
        await c.query(
          "SELECT id,name FROM production_units WHERE organization_id=$1 AND kind='broilers' ORDER BY stocked_on DESC,id LIMIT 1000",
          [org],
        )
      ).rows;
      const reversible = (
        await c.query(
          "SELECT id,posted_on::text,currency,reference,unit_id,lines,kind FROM financial_journal_entries e WHERE organization_id=$1 AND kind<>'reverse' AND NOT EXISTS(SELECT 1 FROM financial_journal_entries r WHERE r.reversal_of_id=e.id) ORDER BY position DESC LIMIT 1000",
          [org],
        )
      ).rows;
      return {
        today: ctx.today,
        expectedPosition: ctx.head,
        report: r,
        sources: rows.map((row) => ({
          ...row,
          matches: undefined,
        })) as FinancialSource[],
        sourceMatches: rows[0]?.matches ?? 0,
        activeSales: counts.active,
        unrecognizedSales: counts.unrecognized,
        units,
        reversible,
      } satisfies JournalWorkspace;
    });
    if (format === "workspace") return NextResponse.json(w, { headers });
    const r = w as JournalReport,
      common = {
        ...headers,
        "Content-Disposition": `attachment; filename="financial-journal.${format}"`,
        "X-Evidence-SHA256": r.evidenceSha256,
      };
    return format === "json"
      ? NextResponse.json(r, { headers: common })
      : new NextResponse(journalCsv(r), {
          headers: { ...common, "Content-Type": "text/csv; charset=utf-8" },
        });
  }
  const p = journalInput.parse(await jsonBody(request));
  const result = await tenant(user.id, async (c) => {
    await financeRole(c, p.organizationId, true);
    await lockEntry(c, p);
    const old = (
      await c.query(
        "SELECT id,submission=$2::jsonb AS same FROM financial_journal_entries WHERE id=$1",
        [p.entryId, JSON.stringify(p)],
      )
    ).rows[0];
    if (old) {
      if (!old.same)
        fail(
          409,
          "This journal receipt was already used for different values.",
        );
      return { id: old.id, replayed: true };
    }
    const ctx = await context(c, p.organizationId);
    if (p.expectedPosition !== ctx.head)
      fail(
        409,
        "The journal changed after you loaded it. Keep your inputs, reload the ledger and confirm again.",
      );
    if (p.data.kind === "recognize_sale") {
      const src = (
        await c.query(
          "SELECT source_id FROM financial_broiler_sources WHERE organization_id=$1 AND source_kind=$2 AND source_id=$3",
          [p.organizationId, p.data.sourceKind, p.data.sourceId],
        )
      ).rows[0];
      if (
        !src ||
        (
          await c.query("SELECT financial_sale_is_booked($1,$2,$3) AS booked", [
            p.organizationId,
            p.data.sourceKind,
            p.data.sourceId,
          ])
        ).rows[0].booked
      )
        fail(
          409,
          "This recorded sale is missing, voided or already recognized. Keep a working copy and reload the source list.",
        );
    }
    await c.query(
      "INSERT INTO financial_journal_entries(id,organization_id,expected_position,input) VALUES($1,$2,$3,$4)",
      [p.entryId, p.organizationId, p.expectedPosition, JSON.stringify(p.data)],
    );
    const after = await context(c, p.organizationId);
    await report(c, p.organizationId, after.today, after.head);
    await audit(c, p.organizationId, "finance." + p.data.kind, p.entryId);
    return { id: p.entryId, replayed: false };
  });
  return NextResponse.json(result, {
    status: result.replayed ? 200 : 201,
    headers,
  });
}
