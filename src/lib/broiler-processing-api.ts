import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { tenant, audit } from "./db";
import { fail, jsonBody } from "./http";
import { readBroilerSource } from "./broiler-source";
import { broilerEvidence, type BroilerSource } from "./broiler-lifecycle";
import {
  processingInput,
  processingModel,
  processingHeads,
  processingWorkspace,
  processingCsv,
  measuredProcessing,
} from "./broiler-processing";
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
function makeReport(s: BroilerSource) {
  const normalized = {
    modelVersion: processingModel,
    source: broilerEvidence(s),
    results: processingWorkspace(s),
  };
  const bytes = JSON.stringify(normalized);
  if (Buffer.byteLength(bytes) > 1024 * 1024)
    fail(
      422,
      "This batch exceeds the 1 MiB processing evidence limit. Ask an administrator to review its source history.",
    );
  return {
    ...normalized,
    evidenceSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
export async function broilerProcessingApi(
  request: NextRequest,
  user: { id: string },
  path: string,
) {
  if (
    path !== "broilers/processing" ||
    !["GET", "POST"].includes(request.method)
  )
    return null;
  if (request.method === "GET") {
    const org = z
        .uuid()
        .parse(request.nextUrl.searchParams.get("organizationId")),
      unit = z.uuid().parse(request.nextUrl.searchParams.get("unitId")),
      format = z
        .enum(["json", "csv"])
        .parse(request.nextUrl.searchParams.get("format") ?? "json");
    const report = makeReport(
      await tenant(user.id, (c) => readBroilerSource(c, org, unit)),
    );
    const common = {
      ...headers,
      "X-Evidence-SHA256": report.evidenceSha256,
      "Content-Disposition": `attachment; filename="broiler-processing.${format}"`,
    };
    return format === "json"
      ? NextResponse.json(report, { headers: common })
      : new NextResponse(processingCsv(report), {
          headers: { ...common, "Content-Type": "text/csv; charset=utf-8" },
        });
  }
  const p = processingInput.parse(await jsonBody(request));
  const result = await tenant(user.id, async (c) => {
    const role = (
      await c.query("SELECT member_role($1) AS role", [p.organizationId])
    ).rows[0].role;
    if (!["owner", "admin", "manager"].includes(role))
      fail(
        403,
        "Only an owner, administrator or manager can review processing measurements.",
      );
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [p.unitId]);
    const old = (
      await c.query(
        "SELECT id,submission=$2::jsonb AS same FROM broiler_processing_reviews WHERE id=$1",
        [p.reviewId, JSON.stringify(p)],
      )
    ).rows[0];
    if (old) {
      if (!old.same)
        fail(
          409,
          "This processing receipt was already used for different values.",
        );
      return { id: old.id, replayed: true };
    }
    const s = await readBroilerSource(c, p.organizationId, p.unitId);
    const positions = [
      ...s.events,
      ...(s.reviews ?? []),
      ...(s.lossReviews ?? []),
      ...(s.processingReviews ?? []),
    ].map((r) => BigInt(r.position));
    const position = positions
      .reduce((a, b) => (a > b ? a : b), BigInt(0))
      .toString();
    if (
      p.expectedPosition !== position ||
      p.expectedDailyId !== (s.records.at(-1)?.id ?? null)
    )
      fail(
        409,
        "This batch changed after you loaded it. Keep your measurements, reload the source and review again.",
      );
    const source = s.events.find(
        (e) =>
          e.id === p.harvestId &&
          e.kind === "harvest" &&
          e.price_basis === "unpriced",
      ),
      active = source && !s.events.some((e) => e.void_of_id === source.id);
    if (!source || (p.data.kind === "record" && !active))
      fail(
        404,
        "Choose an active unsold measured harvest from this batch. Priced live sales cannot also supply processed products.",
      );
    const head = processingHeads(s.processingReviews ?? []).find(
      (r) => r.harvest_id === p.harvestId,
    );
    if ((head?.id ?? null) !== p.previousId)
      fail(
        409,
        "This harvest has a newer processing version. Reload before saving another measurement.",
      );
    if (head?.revision === 100)
      fail(422, "This harvest reached its 100-version processing limit.");
    if (p.data.kind === "withdraw") {
      if (!head || head.input.kind !== "record")
        fail(
          409,
          "Only a current processing record can be withdrawn as erroneous.",
        );
    } else {
      if (p.data.processedOn > s.today)
        fail(
          400,
          "Processing observations cannot be future dated in the organization timezone.",
        );
      try {
        measuredProcessing(p.data, source);
      } catch (e) {
        fail(400, (e as Error).message);
      }
    }
    await c.query(
      "INSERT INTO broiler_processing_reviews(id,organization_id,unit_id,harvest_id,previous_id,expected_position,expected_daily_id,input) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        p.reviewId,
        p.organizationId,
        p.unitId,
        p.harvestId,
        p.previousId,
        p.expectedPosition,
        p.expectedDailyId,
        JSON.stringify(p.data),
      ],
    );
    // Refuse a measurement that would make its required source report unreadable.
    makeReport(await readBroilerSource(c, p.organizationId, p.unitId));
    await audit(
      c,
      p.organizationId,
      "broiler.processing_" + p.data.kind,
      p.reviewId,
    );
    return { id: p.reviewId, replayed: false };
  });
  return NextResponse.json(result, {
    status: result.replayed ? 200 : 201,
    headers,
  });
}
