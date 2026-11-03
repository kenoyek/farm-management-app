import { it, expect } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import {
  feedCountData,
  feedCountPreview,
  feedCountResults,
  feedCountCsv,
  feedCountModel,
  type FeedCountSource,
  type FeedCountEvent,
  type FeedCountReport,
} from "../src/lib/feed-counts";
import { feedReceipt, feedEvent } from "./feed-stock-fixture";
function measured(source: FeedCountSource, kg = "90"): FeedCountEvent {
  const p = feedCountPreview(source, kg),
    id = randomUUID(),
    data = feedCountData.parse({
      kind: "count",
      lotId: source.receipt.id,
      date: "2024-02-03",
      previousId: null,
      reference: "=Synthetic count reference",
      countedKg: kg,
      scope: "actual-weighed-unused-feed-lot-count",
      reason: "Synthetic weighed unused feed stocktake",
      evidence: "Synthetic identified-lot scales and count sheet",
    });
  return {
    id,
    organization_id: source.receipt.organization_id,
    model_version: feedCountModel,
    kind: "count",
    lot_id: source.receipt.id,
    count_id: null,
    previous_id: null,
    loss_event_id: null,
    position: "1",
    expected_stock_position: source.events.at(-1)!.position,
    expected_count_position: "0",
    recorded_on: "2024-02-03",
    currency: p.currency,
    recorded_kg: p.recordedKg,
    counted_kg: p.countedKg,
    variance_kg: p.varianceKg,
    recorded_value: p.recordedValue,
    shortage_value: p.shortageValue,
    expected_source_sha256: "a".repeat(64),
    source_sha256: "a".repeat(64),
    input: data,
    source_snapshot: source,
    submission: {
      organizationId: source.receipt.organization_id,
      eventId: id,
      expectedStockPosition: source.events.at(-1)!.position,
      expectedCountPosition: "0",
      expectedSourceSha256: "a".repeat(64),
      data,
    },
    created_by: randomUUID(),
    created_at: "2024-02-03T00:00:00Z",
  };
}
const source = () => {
  const r = feedEvent();
  return { receipt: r, events: [r] };
};
it("requires a measured nonnegative six-place count and exact scope/reference/evidence", () => {
  const s = source(),
    d = measured(s).input;
  expect(feedCountData.safeParse({ ...d, countedKg: "0" }).success).toBe(true);
  for (const patch of [
    { countedKg: "" },
    { countedKg: "-1" },
    { countedKg: "1.0000001" },
    { reference: "" },
    { scope: "invent-surplus-receipt" },
    { price: "10" },
  ])
    expect(feedCountData.safeParse({ ...d, ...patch }).success).toBe(false);
});
it("prices proposed shortages from original remaining cost with exact half-up and depletion residuals", () => {
  const r = feedEvent({ ...feedReceipt(), weightKg: "3", totalCost: "0.0001" }),
    s = { receipt: r, events: [r] };
  expect(feedCountPreview(s, "2")).toMatchObject({
    recordedKg: "3.000000",
    shortageKg: "1.000000",
    shortageValue: "0.0000",
  });
  expect(feedCountPreview(s, "0").shortageValue).toBe("0.0001");
});
it("keeps surplus unresolved, matching counts non-posting and original unknown/zero shortage values distinct", () => {
  const s = source(),
    before = structuredClone(s);
  expect(feedCountPreview(s, "105")).toMatchObject({
    classification: "surplus",
    varianceKg: "5.000000",
    shortageKg: "0.000000",
    shortageValue: null,
  });
  expect(feedCountPreview(s, "100").classification).toBe("match");
  expect(s).toEqual(before);
  const u = feedEvent({
      ...feedReceipt(),
      totalCost: null,
      costEvidence: null,
    }),
    z = feedEvent({ ...feedReceipt(), totalCost: "0" });
  expect(
    feedCountPreview({ receipt: u, events: [u] }, "90").shortageValue,
  ).toBeNull();
  expect(
    feedCountPreview({ receipt: z, events: [z] }, "90").shortageValue,
  ).toBe("0.0000");
});
it("validates saved recorded quantities and derived approval loss against the immutable count source", () => {
  const e = measured(source()),
    loss = feedEvent(
      {
        kind: "loss",
        lotId: e.lot_id,
        weightKg: "10",
        reason: "Synthetic approved weighed shortage",
        evidence: "Synthetic manager investigation evidence",
      },
      {
        id: randomUUID(),
        lot_id: e.lot_id,
        weight_kg: "10.000000",
        amount: "30.0000",
        recorded_on: e.recorded_on,
        created_by: e.created_by,
      },
    ),
    approval: FeedCountEvent = {
      ...e,
      id: loss.id,
      kind: "resolve_shortage",
      count_id: e.id,
      loss_event_id: loss.id,
      source_snapshot: { count: e, loss },
      input: {
        kind: "resolve_shortage",
        countId: e.id,
        scope: "approve-weighed-shortage-as-feed-loss",
        reason: "Synthetic manager-approved shortage",
        evidence: "Synthetic investigation",
      },
    };
  expect(feedCountResults(approval).appliedLossId).toBe(loss.id);
  expect(() => feedCountResults({ ...e, recorded_kg: "99.000000" })).toThrow();
  expect(() =>
    feedCountResults({
      ...approval,
      source_snapshot: { count: e, loss: { ...loss, amount: "99.0000" } },
    }),
  ).toThrow();
});
it("counts available stock after returns and refuses an inactive original lot", () => {
  const r = feedEvent(),
    ret = feedEvent(
      {
        kind: "supplier_return",
        lotId: r.id,
        weightKg: "10",
        returnReference: "Synthetic return",
        supplierEvidence: "Synthetic supplier handover",
        scope: "actual-unused-feed-return-to-original-supplier",
        reason: "Synthetic actual supplier return",
        evidence: "Synthetic dispatch",
      },
      {
        lot_id: r.id,
        weight_kg: "10.000000",
        amount: "30.0000",
        position: "2",
      },
    ),
    s = { receipt: r, events: [r, ret] };
  expect(feedCountPreview(s, "85")).toMatchObject({
    recordedKg: "90.000000",
    shortageKg: "5.000000",
    shortageValue: "15.0000",
  });
  const v = feedEvent(
    {
      kind: "void",
      voidOfId: r.id,
      reason: "Synthetic receipt never occurred",
      evidence: "Synthetic original register",
    },
    { lot_id: r.id, void_of_id: r.id, kind: "void", position: "3" },
  );
  expect(() => feedCountPreview({ receipt: r, events: [r, v] }, "0")).toThrow();
});
it("exports deterministic full immutable evidence and neutralizes human signed/formula CSV fields", () => {
  const event = measured(source()),
    n = {
      modelVersion: feedCountModel,
      event,
      results: feedCountResults(event),
    },
    r: FeedCountReport = {
      ...n,
      evidenceSha256: createHash("sha256")
        .update(JSON.stringify(n))
        .digest("hex"),
    },
    csv = feedCountCsv(r);
  expect(csv).toContain(r.evidenceSha256);
  expect(csv).toContain('"Signed variance kg","\'-10.000000"');
  expect(csv).toContain('"Complete immutable event and source"');
  expect(csv).toBe(feedCountCsv(r));
});
