import { NextResponse } from "next/server";
import { tenant, audit } from "./db";
import { fail, HttpError } from "./http";
import {
  eggReturnState,
  eggReturnCredit,
  eggReversible,
  type EggEventInput,
  type EggEvent,
  type EggBatch,
} from "./egg-inventory";
type Advanced = Extract<
  EggEventInput,
  { kind: "transfer" | "return" | "reversal" }
>;
export async function eggAdvancedPost(user: { id: string }, input: Advanced) {
  try {
    const result = await tenant(user.id, async (c) => {
      const org = (
        await c.query(
          "SELECT id,member_role(id) AS role,(now() AT TIME ZONE timezone)::date::text AS today FROM organizations WHERE id=$1",
          [input.organizationId],
        )
      ).rows[0];
      const roles =
        input.kind === "transfer"
          ? ["owner", "admin", "manager", "inventory"]
          : ["owner", "admin", "manager"];
      if (!org || !roles.includes(org.role))
        fail(
          403,
          input.kind === "transfer"
            ? "Only an inventory officer or operational manager can transfer eggs."
            : "A manager must review customer returns and reversals.",
        );
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1),618)", [
        input.organizationId,
      ]);
      const prior = (
        await c.query(
          "SELECT id,submission=$2::jsonb AS same FROM egg_events WHERE id=$1",
          [input.eventId, JSON.stringify(input)],
        )
      ).rows[0];
      if (prior) {
        if (!prior.same)
          fail(409, "This receipt was already used for different values.");
        return { id: prior.id, replayed: true };
      }
      const batch: EggBatch | undefined = (
        await c.query(
          "SELECT *,received_on::text FROM egg_batches WHERE organization_id=$1 AND id=$2",
          [input.organizationId, input.batchId],
        )
      ).rows[0];
      if (!batch) fail(404, "Egg batch not found.");
      const last = (
        await c.query(
          "SELECT max(occurred_on)::text AS date FROM egg_events WHERE batch_id=$1 OR destination_batch_id=$1",
          [batch.id],
        )
      ).rows[0].date;
      if (
        input.date > org.today ||
        input.date < batch.received_on ||
        (last && input.date < last)
      )
        fail(
          400,
          "Choose a date from the latest batch movement through today in the organization timezone.",
        );
      let quantity = 0,
        grade: EggEvent["grade"] = "ungraded",
        target: string | null = null,
        destination: string | null = null,
        returnOf: string | null = null,
        trayEggs: number | null = null,
        looseEggs: number | null = null,
        expected: string | null = null,
        reverses: string | null = null,
        pricing: unknown = null,
        amount: string | null = null,
        currency: string | null = null,
        customer: string | null = null,
        reference: string | null = null;
      if (input.kind === "transfer") {
        const store = (
          await c.query(
            "SELECT id FROM egg_stores WHERE id=$1 AND organization_id=$2",
            [input.destinationStoreId, input.organizationId],
          )
        ).rows[0];
        if (!store) fail(404, "Destination egg store not found.");
        if (store.id === batch.store_id)
          fail(400, "Choose a different destination store.");
        if (
          (
            await c.query("SELECT id FROM egg_batches WHERE id=$1", [
              input.destinationBatchId,
            ])
          ).rowCount
        )
          fail(
            409,
            "The destination batch receipt already exists. Reload the stock history.",
          );
        const baseline = (
          await c.query(
            "SELECT min(received_on)::text AS date FROM egg_batches WHERE store_id=$1 AND source_kind='opening'",
            [store.id],
          )
        ).rows[0].date;
        if (baseline && input.date < baseline)
          fail(400, "Transfer on or after the destination opening baseline.");
        await c.query(
          `INSERT INTO egg_batches(id,organization_id,store_id,name,source_kind,parent_batch_id,received_on) VALUES($1,$2,$3,$4,'transfer',$5,$6)`,
          [
            input.destinationBatchId,
            input.organizationId,
            store.id,
            input.destinationBatchName,
            batch.id,
            input.date,
          ],
        );
        quantity = -input.quantity;
        grade = input.grade;
        destination = input.destinationBatchId;
      } else {
        const rows: EggEvent[] = (
          await c.query(
            "SELECT *,position::text,amount::text,expected_return_position::text FROM egg_events e WHERE batch_id=$1 ORDER BY e.position LIMIT 10001",
            [batch.id],
          )
        ).rows;
        if (rows.length > 10000)
          fail(
            422,
            "This batch exceeds posting history limits. Ask an administrator to review its ledger.",
          );
        if (input.kind === "return") {
          const sale = rows.find(
            (e) => e.id === input.saleId && e.kind === "sale",
          );
          if (!sale) fail(404, "Original egg sale not found in this batch.");
          const state = eggReturnState(sale, rows);
          if (state.expectedPosition !== input.expectedReturnPosition)
            fail(
              409,
              "The sale return state changed. Reload before reviewing this return.",
            );
          if (
            (
              await c.query(
                "SELECT id FROM egg_events WHERE organization_id=$1 AND kind='return' AND reference=$2",
                [input.organizationId, input.reference],
              )
            ).rowCount
          )
            fail(409, "This return reference already has a posting.");
          let credit;
          try {
            credit = eggReturnCredit(state, input.trayEggs, input.looseEggs);
          } catch (e) {
            fail(400, (e as Error).message);
          }
          quantity = input.restockEggs;
          grade = sale.grade;
          returnOf = sale.id;
          trayEggs = input.trayEggs;
          looseEggs = input.looseEggs;
          expected = input.expectedReturnPosition;
          pricing = sale.pricing;
          amount = "-" + credit;
          currency = sale.currency;
          customer = sale.customer;
          reference = input.reference;
        } else {
          const old = rows.find((e) => e.id === input.reversesId);
          if (
            !old ||
            !["sale", "grade", "loss", "count", "transfer", "return"].includes(
              old.kind,
            )
          )
            fail(
              400,
              "Choose a sale, grading, loss, count, transfer or customer return to reverse. Collection changes use receipt reconciliation.",
            );
          if (!eggReversible(old, rows))
            fail(
              409,
              "This movement is reversed, has active partial returns, or is not the latest active customer return. Reload and review its history.",
            );
          quantity = -old.quantity;
          grade = old.grade;
          target = old.target_grade;
          destination = old.destination_batch_id ?? null;
          returnOf = old.return_of_id ?? null;
          trayEggs = old.return_tray_eggs ?? null;
          looseEggs = old.return_loose_eggs ?? null;
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
      }
      await c.query(
        `INSERT INTO egg_events(id,organization_id,batch_id,kind,occurred_on,grade,target_grade,quantity,reverses_id,pricing,amount,currency,customer,reference,reason,evidence,submission,destination_batch_id,return_of_id,return_tray_eggs,return_loose_eggs,expected_return_position)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [
          input.eventId,
          input.organizationId,
          batch.id,
          input.kind,
          input.date,
          grade,
          target,
          quantity,
          reverses,
          pricing === null ? null : JSON.stringify(pricing),
          amount,
          currency,
          customer,
          reference,
          input.reason,
          input.evidence,
          JSON.stringify(input),
          destination,
          returnOf,
          trayEggs,
          looseEggs,
          expected,
        ],
      );
      await audit(c, input.organizationId, "egg." + input.kind, input.eventId);
      return { id: input.eventId, replayed: false };
    });
    return NextResponse.json(result, {
      status: result.replayed ? 200 : 201,
      headers: {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const e = error as { code?: string; message?: string };
    if (e.code === "23505")
      fail(
        409,
        "This transfer, return reference or reversal already exists, or its reviewed state changed. Reload the inventory.",
      );
    if (e.code === "23514")
      fail(
        400,
        e.message?.startsWith("Insufficient")
          ? e.message
          : "The transfer or return violates a stock, date, original-price or lineage constraint.",
      );
    throw error;
  }
}
