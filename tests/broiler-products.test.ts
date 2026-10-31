import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  productAmount,
  productInput,
  productWorkspace,
  productCsv,
  productEvidence,
  type ProductEvent,
} from "../src/lib/broiler-products";
import {
  processingSource,
  processingReview,
} from "./broiler-processing-fixture";
function fixture() {
  const s = processingSource(),
    review = processingReview(s);
  s.processingReviews = [review];
  const receipt = {
    id: randomUUID(),
    kind: "receipt",
    position: "1",
    source_review_id: review.id,
    output_index: 0,
    weight_kg: "14.000000",
    source_snapshot: review,
    input: {
      kind: "receipt",
      location: "Synthetic room",
      reason: "Synthetic owned stock confirmation",
      evidence: "Synthetic source",
    },
  } as ProductEvent;
  receipt.lot_id = receipt.id;
  const sale = {
    id: randomUUID(),
    lot_id: receipt.id,
    kind: "sale",
    position: "2",
    weight_kg: "3.123456",
    amount: "3.8559",
    price_per_kg: "1.2345",
    currency: "NGN",
    input: {
      kind: "sale",
      reason: "Synthetic dispatched kg",
      evidence: "Synthetic source",
    },
  } as ProductEvent;
  return { s, receipt, sale };
}
it("uses six-place stock quantities and half-up four-place sale values without float arithmetic", () => {
  expect(productAmount("3.123456", "1.2345")).toBe("3.8559");
  expect(productAmount("0.5", "0.0001")).toBe("0.0001");
  expect(productAmount("14", "0")).toBe("0.0000");
});
it("conserves partial sales/losses and explicit erroneous reversals while retaining every original movement", () => {
  const { s, receipt, sale } = fixture(),
    loss = {
      ...sale,
      id: randomUUID(),
      kind: "loss",
      position: "3",
      weight_kg: "0.123456",
      amount: null,
      currency: null,
    } as ProductEvent;
  const events = [receipt, sale, loss];
  expect(productWorkspace(s, events).lots[0]).toMatchObject({
    balanceKg: "10.753088",
    soldKg: "3.123456",
    lostKg: "0.123456",
  });
  const reversal = {
    ...sale,
    id: randomUUID(),
    kind: "void",
    position: "4",
    void_of_id: sale.id,
  } as ProductEvent;
  events.push(reversal);
  expect(productWorkspace(s, events).lots[0].balanceKg).toBe("13.876544");
  expect(events[1]).toEqual(sale);
});
it("offers only current active, known intended outputs and never treats unknown or classification as received inventory", () => {
  const { s, receipt } = fixture();
  expect(productWorkspace(s, []).outputs).toHaveLength(2);
  expect(productWorkspace(s, []).lots).toEqual([]);
  expect(productWorkspace(s, [receipt]).outputs.map((o) => o.index)).toEqual([
    1,
  ]);
  const input = s.processingReviews![0].input;
  if (input.kind !== "record") throw Error();
  input.products[1].weightKg = null;
  expect(productWorkspace(s, [receipt]).outputs).toEqual([]);
  input.products[1].weightKg = "2";
  input.products[1].disposition = "unassessed";
  expect(productWorkspace(s, [receipt]).outputs).toEqual([]);
});
it("keeps original currencies separate and removes reversed sales without fabricating cash, costs or profit", () => {
  const { s, receipt, sale } = fixture(),
    usd = {
      ...sale,
      id: randomUUID(),
      position: "3",
      currency: "USD",
      amount: "1.0000",
      weight_kg: "1.000000",
    };
  const r = productWorkspace(s, [receipt, sale, usd]);
  expect(r.salesByCurrency).toEqual({ NGN: "3.8559", USD: "1.0000" });
  expect(r).not.toHaveProperty("profit");
  expect(r).not.toHaveProperty("cash");
});
it("normalizes strict receipts and distinguishes zero prices from missing values, invalid units and extra result claims", () => {
  const p = {
    organizationId: randomUUID(),
    unitId: randomUUID(),
    eventId: randomUUID(),
    date: "2024-02-03",
    expectedPosition: "0",
    expectedSourcePosition: "2",
    expectedDailyId: null,
    data: {
      kind: "sale",
      lotId: randomUUID(),
      weightKg: "0.000001",
      pricePerKg: "0",
      reference: "SYNTHETIC",
      customer: "Synthetic buyer",
      reason: "Synthetic measured dispatch",
      evidence: "Synthetic record",
    },
  };
  expect(productInput.parse(p).data).toMatchObject({
    weightKg: "0.000001",
    pricePerKg: "0.0000",
  });
  for (const patch of [
    { weightKg: "0" },
    { weightKg: "-1" },
    { weightKg: "1.0000001" },
    { pricePerKg: null },
    { pricePerKg: "NaN" },
    { pricePerKg: "1.23456" },
    { profit: "20" },
  ])
    expect(
      productInput.safeParse({ ...p, data: { ...p.data, ...patch } }).success,
    ).toBe(false);
});
it("retains complete source histories and neutralizes formula-looking labels in readable CSV", () => {
  const { s, receipt, sale } = fixture();
  receipt.input.reason = "=Synthetic original confirmation";
  const evidence = productEvidence(s, [receipt, sale]),
    csv = productCsv({
      ...evidence,
      evidenceSha256: "fixture",
      today: s.today,
      expectedSourcePosition: "3",
      expectedDailyId: null,
    });
  expect(csv).toContain("'=Synthetic original confirmation");
  expect(csv).toContain('"Complete source"');
  expect(csv).toContain(receipt.source_review_id);
  expect(evidence.source.processingReviews).toEqual(s.processingReviews);
});
