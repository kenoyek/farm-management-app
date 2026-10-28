import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { tenant, audit } from "./db";
import { fail, jsonBody, HttpError } from "./http";
import {
  eggStoreInput,
  eggEventInput,
  eggSale,
  eggSummary,
  eggSheets,
  type EggSource,
  type EggBatch,
  type EggEvent,
} from "./egg-inventory";
import { sheetsCsv } from "./recipe-reports";
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
export async function eggInventoryApi(
  request: NextRequest,
  user: { id: string },
  path: string,
) {
  if (!["eggs", "eggs/stores", "eggs/events"].includes(path)) return null;
  if (path === "eggs" && request.method === "GET") {
    const org = z
        .uuid()
        .parse(request.nextUrl.searchParams.get("organizationId")),
      format = z
        .enum(["json", "csv"])
        .nullable()
        .parse(request.nextUrl.searchParams.get("format"));
    const source: EggSource = await tenant(user.id, async (c) => {
      const row = (
        await c.query(
          `SELECT jsonb_build_object('id',o.id,'name',o.name,'currency',o.currency,'timezone',o.timezone,'today',(now() AT TIME ZONE o.timezone)::date::text) AS organization,
    coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.name,s.id) FROM (SELECT * FROM egg_stores WHERE organization_id=$1 ORDER BY name,id LIMIT 201) s),'[]'::jsonb) AS stores,
    coalesce((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.received_on,b.id) FROM (SELECT * FROM egg_batches WHERE organization_id=$1 ORDER BY received_on,id LIMIT 10001) b),'[]'::jsonb) AS batches,
    coalesce((SELECT jsonb_agg(to_jsonb(e)||jsonb_build_object('position',e.position::text,'amount',e.amount::text,'expected_position',e.expected_position::text) ORDER BY e.position) FROM (SELECT * FROM egg_events WHERE organization_id=$1 ORDER BY position LIMIT 10001) e),'[]'::jsonb) AS events,
    coalesce((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.recorded_on,d.unit_id) FROM (SELECT r.*,r.feed_kg::text AS feed_text,u.name AS unit_name,u.farm_id FROM effective_daily_records r JOIN production_units u ON u.id=r.unit_id WHERE r.organization_id=$1 AND u.kind='layers' ORDER BY r.recorded_on,r.unit_id LIMIT 10001) d),'[]'::jsonb) AS collections
    FROM organizations o WHERE o.id=$1`,
          [org],
        )
      ).rows[0];
      if (!row) fail(404, "Organization not found.");
      return row;
    });
    if (
      source.stores.length > 200 ||
      source.batches.length > 10000 ||
      source.events.length > 10000 ||
      source.collections.length > 10000 ||
      Buffer.byteLength(JSON.stringify(source)) > 4 * 1024 * 1024
    )
      fail(
        422,
        "This inventory exceeds snapshot limits. Contact an administrator for a scoped ledger export. Nothing has been truncated.",
      );
    let summary;
    try {
      summary = eggSummary(source);
    } catch {
      fail(
        422,
        "The saved egg ledger is inconsistent and needs administrator review.",
      );
    }
    const modelVersion = "whole-egg-ledger-v1",
      digest = createHash("sha256")
        .update(JSON.stringify({ modelVersion, source, summary }))
        .digest("hex");
    const document = {
      ...source,
      modelVersion,
      summary,
      evidenceSha256: digest,
      generatedAt: new Date().toISOString(),
    };
    const privateHeaders = { ...headers, "X-Egg-Snapshot-SHA256": digest };
    if (!format)
      return NextResponse.json(document, { headers: privateHeaders });
    return new NextResponse(
      format === "csv"
        ? sheetsCsv(eggSheets(source, summary, digest))
        : JSON.stringify(document, null, 2),
      {
        headers: {
          ...privateHeaders,
          "Content-Type":
            format === "csv"
              ? "text/csv; charset=utf-8"
              : "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="farmstead-eggs-${org}.${format}"`,
        },
      },
    );
  }
  if (request.method !== "POST" || path === "eggs") return null;
  const input =
    path === "eggs/stores"
      ? eggStoreInput.parse(await jsonBody(request))
      : eggEventInput.parse(await jsonBody(request));
  try {
    const result = await tenant(user.id, async (c) => {
      const org = (
        await c.query(
          "SELECT id,currency,timezone,(now() AT TIME ZONE timezone)::date::text AS today,member_role(id) AS role FROM organizations WHERE id=$1",
          [input.organizationId],
        )
      ).rows[0];
      if (
        !org ||
        !["owner", "admin", "manager", "inventory"].includes(org.role)
      )
        fail(
          403,
          "Only an owner, administrator, manager or inventory officer can post egg stock.",
        );
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1),618)", [
        input.organizationId,
      ]);
      if ("storeId" in input && !("kind" in input)) {
        const old = (
          await c.query(
            "SELECT id,submission=$2::jsonb AS same FROM egg_stores WHERE id=$1",
            [input.storeId, JSON.stringify(input)],
          )
        ).rows[0];
        if (old) {
          if (!old.same)
            fail(
              409,
              "This store receipt was already used for different values.",
            );
          return { id: old.id, replayed: true };
        }
        if (
          !(
            await c.query(
              "SELECT id FROM farms WHERE id=$1 AND organization_id=$2",
              [input.farmId, input.organizationId],
            )
          ).rowCount
        )
          fail(404, "Farm not found.");
        await c.query(
          "INSERT INTO egg_stores(id,organization_id,farm_id,name,submission) VALUES($1,$2,$3,$4,$5)",
          [
            input.storeId,
            input.organizationId,
            input.farmId,
            input.name,
            JSON.stringify(input),
          ],
        );
        await audit(
          c,
          input.organizationId,
          "egg.store_created",
          input.storeId,
        );
        return { id: input.storeId, replayed: false };
      }
      if (!("kind" in input)) throw Error("Unsupported egg posting.");
      if (
        ["count", "reversal"].includes(input.kind) &&
        !["owner", "admin", "manager"].includes(org.role)
      )
        fail(403, "A manager must review physical counts and reversals.");
      const existing = (
        await c.query(
          "SELECT id,submission=$2::jsonb AS same FROM egg_events WHERE id=$1",
          [input.eventId, JSON.stringify(input)],
        )
      ).rows[0];
      if (existing) {
        if (!existing.same)
          fail(
            409,
            "This stock receipt was already used for different values.",
          );
        return { id: existing.id, replayed: true };
      }
      if (input.date > org.today)
        fail(
          400,
          "Stock movements cannot be future dated in the organization timezone.",
        );
      let batch: EggBatch | undefined = (
        await c.query(
          "SELECT *,received_on::text,collected_on::text FROM egg_batches WHERE id=$1 AND organization_id=$2",
          [input.batchId, input.organizationId],
        )
      ).rows[0];
      let source: Record<string, unknown> | null = null,
        sourceQuantity: number | null = null,
        quantity = 0,
        grade = "ungraded",
        target: string | null = null,
        previous: string | null = null,
        reverses: string | null = null,
        stockCount: number | null = null,
        expectedPosition: string | null = null,
        pricing: unknown = null,
        amount: string | null = null,
        currency: string | null = null,
        customer: string | null = null,
        reference: string | null = null;
      if (input.kind === "receipt") {
        await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          input.unitId,
        ]);
        source =
          (
            await c.query(
              `SELECT to_jsonb(d)||jsonb_build_object('feed_kg',d.feed_kg::text) AS source FROM effective_daily_records d JOIN production_units u ON u.id=d.unit_id WHERE d.organization_id=$1 AND d.unit_id=$2 AND d.recorded_on=$3 AND u.kind='layers'`,
              [input.organizationId, input.unitId, input.collectionDate],
            )
          ).rows[0]?.source ?? null;
        if (!source)
          fail(
            404,
            "Layer collection not found. Missing or forecast collections cannot be received.",
          );
        if (
          source.id !== input.expectedRecordId ||
          (source.adjustment_id ?? null) !== input.expectedAdjustmentId
        )
          fail(
            409,
            "The collection changed after you loaded it. Reload before receiving or reconciling it.",
          );
        const existingBatch = (
          await c.query(
            "SELECT id FROM egg_batches WHERE unit_id=$1 AND collected_on=$2",
            [input.unitId, input.collectionDate],
          )
        ).rows[0];
        if (existingBatch && existingBatch.id !== input.batchId)
          fail(
            409,
            "This collection already has an inventory batch. Reload before reconciling its receipt.",
          );
        if (
          batch &&
          (batch.unit_id !== input.unitId ||
            batch.collected_on !== input.collectionDate ||
            batch.store_id !== input.storeId ||
            batch.name !== input.batchName)
        )
          fail(
            409,
            "This receipt does not match the original batch and store.",
          );
        const head: EggEvent | undefined = batch
          ? (
              await c.query(
                `SELECT e.* FROM egg_events e WHERE batch_id=$1 AND kind='receipt' AND NOT EXISTS(SELECT 1 FROM egg_events n WHERE n.previous_id=e.id)`,
                [batch.id],
              )
            ).rows[0]
          : undefined;
        if ((head?.id ?? null) !== input.previousId)
          fail(
            409,
            "The collection receipt changed. Reload before reconciling it.",
          );
        if (
          head &&
          head.source_snapshot?.id === source.id &&
          (head.source_snapshot?.adjustment_id ?? null) ===
            (source.adjustment_id ?? null)
        )
          fail(409, "This collection is already reconciled.");
        sourceQuantity = Number(source.eggs) - Number(source.cracked);
        quantity = sourceQuantity - (head?.source_quantity ?? 0);
        previous = input.previousId;
      }
      if (!batch) {
        if (input.kind !== "receipt" && input.kind !== "opening")
          fail(404, "Egg batch not found.");
        const store = (
          await c.query(
            "SELECT * FROM egg_stores WHERE id=$1 AND organization_id=$2",
            [input.storeId, input.organizationId],
          )
        ).rows[0];
        if (!store) fail(404, "Egg store not found.");
        const baseline = (
          await c.query(
            "SELECT min(received_on)::text AS date FROM egg_batches WHERE store_id=$1 AND source_kind='opening'",
            [store.id],
          )
        ).rows[0].date;
        if (input.kind === "opening") {
          const used = (
            await c.query(
              "SELECT 1 FROM egg_events e JOIN egg_batches b ON b.id=e.batch_id WHERE b.store_id=$1 AND e.kind<>'opening' LIMIT 1",
              [store.id],
            )
          ).rowCount;
          if (used || (baseline && baseline !== input.date))
            fail(
              400,
              "Opening stock must use one opening-of-day baseline before other store operations. Use reviewed physical counts afterward.",
            );
        } else if (baseline && input.collectionDate < baseline)
          fail(
            400,
            "This collection predates the store's opening stock baseline and cannot be received again.",
          );
        if (input.kind === "receipt" && input.date < input.collectionDate)
          fail(400, "Receive collections on or after their observation date.");
        batch = (
          await c.query(
            `INSERT INTO egg_batches(id,organization_id,store_id,name,source_kind,unit_id,collected_on,received_on) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *,received_on::text,collected_on::text`,
            [
              input.batchId,
              input.organizationId,
              input.storeId,
              input.batchName,
              input.kind === "opening" ? "opening" : "collection",
              input.kind === "receipt" ? input.unitId : null,
              input.kind === "receipt" ? input.collectionDate : null,
              input.date,
            ],
          )
        ).rows[0];
      } else if (input.kind === "opening")
        fail(
          409,
          "Opening stock already has a batch. Use a reviewed count to reconcile it.",
        );
      if (!batch) throw Error("Batch creation failed.");
      const last = (
        await c.query(
          "SELECT position::text,occurred_on::text FROM egg_events WHERE batch_id=$1 ORDER BY position DESC LIMIT 1",
          [batch.id],
        )
      ).rows[0];
      if (
        input.date < batch.received_on ||
        (last && input.date < last.occurred_on)
      )
        fail(
          400,
          "Post movements on or after the latest movement date for this batch. Earlier stock history stays unchanged.",
        );
      if ("grade" in input) grade = input.grade;
      if (input.kind === "opening") quantity = input.quantity;
      if (input.kind === "grade") {
        quantity = input.quantity;
        target = input.targetGrade;
      }
      if (input.kind === "loss") quantity = -input.quantity;
      if (input.kind === "count") {
        if (input.expectedPosition !== (last?.position ?? "0"))
          fail(
            409,
            "This batch changed after you loaded the physical count. Reload before reviewing it.",
          );
        const balance = Number(
          (
            await c.query(
              "SELECT eggs::text FROM egg_balances WHERE batch_id=$1 AND grade=$2",
              [batch.id, input.grade],
            )
          ).rows[0]?.eggs ?? 0,
        );
        quantity = input.counted - balance;
        stockCount = input.counted;
        expectedPosition = input.expectedPosition;
      }
      if (input.kind === "sale") {
        if (input.currency !== org.currency)
          fail(
            409,
            "The organization currency changed. Reload before recording this sale.",
          );
        let sale;
        try {
          sale = eggSale(input.pricing);
        } catch (e) {
          fail(400, (e as Error).message);
        }
        quantity = -sale.quantity;
        pricing = sale.pricing;
        amount = sale.total;
        currency = input.currency;
        customer = input.customer;
        reference = input.reference;
      }
      if (input.kind === "reversal") {
        const old: EggEvent | undefined = (
          await c.query(
            "SELECT *,amount::text FROM egg_events WHERE id=$1 AND batch_id=$2",
            [input.reversesId, batch.id],
          )
        ).rows[0];
        if (!old || !["sale", "grade", "loss", "count"].includes(old.kind))
          fail(
            400,
            "Only a sale, grading, loss or count movement can be reversed in full. Collection changes use receipt reconciliation.",
          );
        if (
          (
            await c.query("SELECT id FROM egg_events WHERE reverses_id=$1", [
              old.id,
            ])
          ).rowCount
        )
          fail(409, "This movement was already reversed.");
        quantity = -old.quantity;
        grade = old.grade;
        target = old.target_grade;
        reverses = old.id;
        pricing = old.pricing;
        amount =
          old.amount === null
            ? null
            : old.amount.startsWith("-")
              ? old.amount.slice(1)
              : "-" + old.amount;
        currency = old.currency;
        customer = old.customer;
        reference = old.reference;
      }
      await c.query(
        `INSERT INTO egg_events(id,organization_id,batch_id,kind,occurred_on,grade,target_grade,quantity,previous_id,reverses_id,source_snapshot,source_quantity,stock_count,expected_position,pricing,amount,currency,customer,reference,reason,evidence,submission)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [
          input.eventId,
          input.organizationId,
          input.batchId,
          input.kind,
          input.date,
          grade,
          target,
          quantity,
          previous,
          reverses,
          source === null ? null : JSON.stringify(source),
          sourceQuantity,
          stockCount,
          expectedPosition,
          pricing === null ? null : JSON.stringify(pricing),
          amount,
          currency,
          customer,
          reference,
          input.reason,
          input.evidence,
          JSON.stringify(input),
        ],
      );
      await audit(c, input.organizationId, "egg." + input.kind, input.eventId);
      return { id: input.eventId, replayed: false };
    });
    return NextResponse.json(result, {
      status: result.replayed ? 200 : 201,
      headers,
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const e = error as { code?: string; message?: string };
    if (e.code === "23505")
      fail(
        409,
        "This collection, sale reference, receipt successor or reversal already exists. Reload the inventory before posting again.",
      );
    if (e.code === "23514")
      fail(
        400,
        e.message?.startsWith("Insufficient")
          ? e.message
          : "The movement violates a stock, date, source or sale-value constraint. Reload and check the recorded evidence.",
      );
    throw error;
  }
}
