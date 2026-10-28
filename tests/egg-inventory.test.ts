import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  eggSale,
  eggPricing,
  eggEventInput,
  eggSummary,
  eggSheets,
  type EggSource,
  type EggEvent,
} from "../src/lib/egg-inventory";
import { sheetsCsv } from "../src/lib/recipe-reports";
it("prices whole trays and loose eggs once with exact four-decimal money", () => {
  expect(
    eggSale({
      mode: "tray-and-loose",
      trays: 2,
      looseEggs: 2,
      traySize: 30,
      pricePerTray: "4500.125",
      pricePerEgg: "155.25",
    }),
  ).toMatchObject({ quantity: 62, total: "9310.7500" });
  expect(
    eggSale({ mode: "per-egg", eggs: 3, pricePerEgg: "0.1234" }).total,
  ).toBe("0.3702");
  expect(eggSale({ mode: "per-egg", eggs: 2, pricePerEgg: "0" }).total).toBe(
    "0.0000",
  );
});
it("requires explicit prices and whole counts, a proper tray remainder and bounded sale values", () => {
  for (const p of [
    { mode: "per-egg", eggs: 1 },
    { mode: "per-egg", eggs: 1.2, pricePerEgg: "2" },
    { mode: "per-egg", eggs: 1, pricePerEgg: "-1" },
    {
      mode: "tray-and-loose",
      trays: 1,
      looseEggs: 30,
      traySize: 30,
      pricePerTray: "100",
      pricePerEgg: "2",
    },
    { mode: "per-egg", eggs: 1, pricePerEgg: "0.12345" },
  ])
    expect(eggPricing.safeParse(p).success).toBe(false);
  expect(() =>
    eggSale({
      mode: "tray-and-loose",
      trays: 100000000,
      looseEggs: 0,
      traySize: 30,
      pricePerTray: "1",
      pricePerEgg: "1",
    }),
  ).toThrow(/whole eggs/);
  expect(() =>
    eggSale({ mode: "per-egg", eggs: 100000000, pricePerEgg: "100000000" }),
  ).toThrow(/monetary range/);
});
function fixture() {
  const org = randomUUID(),
    batch = randomUUID(),
    unit = randomUUID(),
    review = randomUUID(),
    record = randomUUID();
  const source: EggSource = {
    organization: {
      id: org,
      name: "Synthetic eggs",
      currency: "NGN",
      timezone: "Africa/Lagos",
      today: "2026-10-28",
    },
    stores: [
      {
        id: randomUUID(),
        organization_id: org,
        farm_id: randomUUID(),
        name: "=Synthetic store",
        created_by: randomUUID(),
        created_at: "2024-02-01T00:00:00Z",
      },
    ],
    batches: [],
    events: [],
    collections: [
      {
        id: record,
        organization_id: org,
        unit_id: unit,
        recorded_on: "2024-02-01",
        eggs: 100,
        cracked: 2,
        adjustment_id: null,
        unit_name: "Synthetic flock",
        farm_id: randomUUID(),
      },
    ],
  };
  source.batches = [
    {
      id: batch,
      organization_id: org,
      store_id: source.stores[0].id,
      name: "=Synthetic batch",
      source_kind: "collection",
      unit_id: unit,
      collected_on: "2024-02-01",
      received_on: "2024-02-01",
    },
  ];
  const event = (
    kind: EggEvent["kind"],
    quantity: number,
    values: Partial<EggEvent> = {},
  ): EggEvent => ({
    id: randomUUID(),
    position: String(source.events.length + 1),
    organization_id: org,
    batch_id: batch,
    kind,
    occurred_on: "2024-02-01",
    grade: "ungraded",
    target_grade: null,
    quantity,
    previous_id: null,
    reverses_id: null,
    source_snapshot: null,
    source_quantity: null,
    stock_count: null,
    expected_position: null,
    pricing: null,
    amount: null,
    currency: null,
    customer: null,
    reference: null,
    reason: "Synthetic evidence reviewed",
    evidence: "=Source count sheet",
    created_by: review,
    created_at: "2024-02-01T00:00:00Z",
    ...values,
  });
  return { source, event, batch };
}
it("conserves eggs through grading, losses and their full reversals without touching source collections", () => {
  const { source, event } = fixture();
  source.events.push(
    event("receipt", 98, {
      source_quantity: 98,
      source_snapshot: { id: source.collections[0].id, adjustment_id: null },
    }),
  );
  const grade = event("grade", 80, { target_grade: "large" });
  source.events.push(grade);
  const loss = event("loss", -2, { grade: "large" });
  source.events.push(loss);
  source.events.push(
    event("reversal", 2, { grade: "large", reverses_id: loss.id }),
  );
  const r = eggSummary(source);
  expect(r.totalEggs).toBe(98);
  expect(r.balances.map((r) => [r.grade, r.eggs])).toEqual([
    ["ungraded", 18],
    ["large", 80],
  ]);
  expect(source.collections[0].eggs).toBe(100);
  source.events.push(
    event("sale", -81, { grade: "large", amount: "100.0000", currency: "NGN" }),
  );
  expect(() => eggSummary(source)).toThrow(/balance/);
});
it("separates sales currencies and reverses original values rather than applying current prices", () => {
  const { source, event } = fixture();
  source.events.push(event("opening", 100));
  const sale = event("sale", -10, { amount: "1234.5670", currency: "NGN" });
  source.events.push(sale);
  source.events.push(event("sale", -2, { amount: "0.2468", currency: "USD" }));
  source.events.push(
    event("reversal", 10, {
      amount: "-1234.5670",
      currency: "NGN",
      reverses_id: sale.id,
    }),
  );
  expect(eggSummary(source).sales).toEqual([
    { currency: "NGN", netEggs: 0, netValue: "0.0000" },
    { currency: "USD", netEggs: 2, netValue: "0.2468" },
  ]);
});
it("distinguishes unreceived zeros from acknowledged zeros and flags new review IDs even without quantity changes", () => {
  const { source, event } = fixture();
  source.collections[0].eggs = 0;
  source.collections[0].cracked = 0;
  expect(eggSummary(source).reconciliation[0]).toMatchObject({
    status: "not-received",
    received: null,
    difference: 0,
  });
  source.events.push(
    event("receipt", 0, {
      source_quantity: 0,
      source_snapshot: { id: source.collections[0].id, adjustment_id: null },
    }),
  );
  expect(eggSummary(source).reconciliation[0].status).toBe("reconciled");
  source.collections[0].adjustment_id = randomUUID();
  expect(eggSummary(source).reconciliation[0]).toMatchObject({
    status: "source-changed",
    difference: 0,
  });
});
it("exports exact inventory evidence with spreadsheet-safe names and refuses client-invented receipt quantities", () => {
  const { source, event } = fixture();
  source.events.push(
    event("receipt", 98, {
      source_quantity: 98,
      source_snapshot: { id: source.collections[0].id, adjustment_id: null },
    }),
  );
  const csv = sheetsCsv(eggSheets(source, eggSummary(source), "digest"));
  expect(csv).toContain("'=Synthetic batch");
  expect(csv).toContain("'=Source count sheet");
  expect(csv).toContain(source.events[0].id);
  expect(csv).toContain("Receipt source evidence");
  expect(csv).toContain(source.collections[0].id);
  expect(
    eggEventInput.safeParse({
      kind: "receipt",
      organizationId: source.organization.id,
      eventId: randomUUID(),
      batchId: source.batches[0].id,
      date: "2024-02-01",
      storeId: source.stores[0].id,
      batchName: "Synthetic batch",
      unitId: source.collections[0].unit_id,
      collectionDate: "2024-02-01",
      expectedRecordId: source.collections[0].id,
      expectedAdjustmentId: null,
      previousId: null,
      reason: "Synthetic review",
      evidence: "Sheet",
      quantity: 100,
    }).success,
  ).toBe(false);
});
