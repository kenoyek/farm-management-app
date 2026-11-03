import type { PoolClient } from "pg";
import { NextRequest, NextResponse } from "next/server";
import { tenant } from "./db";
import { fail, jsonBody } from "./http";
import {
  journalInput,
  reviewedCostLines,
  type JournalInput,
  type JournalLine,
} from "./financial-journal";
export type FeedCostBasis = {
  policy: string;
  lotId: string;
  review: Record<string, unknown>;
  parentPostingId: string | null;
  currency: string;
  postedOn: string;
  reference: string;
  bookedPurchaseValue: string;
  reviewedPurchaseValue: string;
  purchaseDelta: string;
  components: {
    eventId: string;
    kind: string;
    unitId: string | null;
    date: string;
    weightKg: string;
    account: string;
    bookedValue: string;
    reviewedValue: string;
    delta: string;
    sourceEvidence: {
      currentSource: Record<string, unknown>;
      sourceReview: Record<string, unknown> | null;
    } | null;
    basis: { entryId: string; kind: string; value: string; account: string }[];
  }[];
  lines: JournalLine[];
};
export async function lockFeedCost(c: PoolClient, org: string, id: string) {
  await c.query("SELECT lock_feed_cost_posting($1,$2)", [org, id]);
}
export async function feedCostBasis(
  c: PoolClient,
  p: JournalInput,
): Promise<FeedCostBasis> {
  if (p.data.kind !== "recognize_feed_cost")
    throw Error("Reviewed cost posting required.");
  try {
    const basis: FeedCostBasis = (
      await c.query("SELECT feed_cost_posting_basis($1,$2,$3,$4) AS basis", [
        p.organizationId,
        p.data.reviewId,
        p.data.settlement,
        p.data.consumptionTreatment,
      ])
    ).rows[0].basis;
    if (
      JSON.stringify(
        basis.lines.map(({ account, side, amount }) => [account, side, amount]),
      ) !==
      JSON.stringify(
        reviewedCostLines(basis.components, p.data.settlement).map(
          ({ account, side, amount }) => [account, side, amount],
        ),
      )
    )
      throw Error("Reviewed cost lines failed independent verification.");
    return basis;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (["23514", "23505"].includes(code ?? ""))
      fail(409, (e as Error).message);
    throw e;
  }
}
export async function feedCostPreviewApi(
  request: NextRequest,
  user: { id: string },
  path: string,
) {
  if (path !== "finance/feed-costs/preview" || request.method !== "POST")
    return null;
  const p = journalInput.parse(await jsonBody(request));
  if (p.data.kind !== "recognize_feed_cost")
    fail(400, "Choose a reviewed feed-cost posting.");
  const selectedReviewId = p.data.reviewId;
  const v = await tenant(user.id, async (c) => {
    const r = (
      await c.query("SELECT member_role($1) AS role", [p.organizationId])
    ).rows[0].role;
    if (!["owner", "admin", "manager"].includes(r))
      fail(403, "Only a financial manager may preview cost postings.");
    await lockFeedCost(c, p.organizationId, selectedReviewId);
    const head = (
      await c.query(
        "SELECT coalesce(max(position),0)::text AS head FROM financial_journal_entries WHERE organization_id=$1",
        [p.organizationId],
      )
    ).rows[0].head;
    if (head !== p.expectedPosition)
      fail(
        409,
        "The journal changed. Keep your inputs, reload and confirm again.",
      );
    return feedCostBasis(c, p);
  });
  return NextResponse.json(v, {
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
