import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  eggReturnState,
  eggReturnCredit,
  eggReversible,
  eggSummary,
  eggEventInput,
  type EggEvent,
  type EggSource,
} from "../src/lib/egg-inventory";
const batch = randomUUID(),
  org = randomUUID();
function event(
  kind: EggEvent["kind"],
  quantity: number,
  position: number,
  extra: Partial<EggEvent> = {},
): EggEvent {
  return {
    id: randomUUID(),
    position: String(position),
    organization_id: org,
    batch_id: batch,
    kind,
    occurred_on: "2024-02-01",
    grade: "large",
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
    reason: "Synthetic review",
    evidence: "Synthetic sheet",
    created_by: randomUUID(),
    created_at: "2024-02-01T00:00:00Z",
    ...extra,
  };
}
function sale() {
  return event("sale", -3, 2, {
    pricing: {
      mode: "tray-and-loose",
      trays: 1,
      traySize: 3,
      looseEggs: 0,
      pricePerTray: "1.0000",
      pricePerEgg: "0.0000",
    },
    amount: "1.0000",
    currency: "NGN",
    customer: "Synthetic buyer",
    reference: "SYNTHETIC",
  });
}
it("allocates broken-tray credits cumulatively so all original eggs exactly exhaust the original price", () => {
  const s = sale(),
    events = [s],
    credits = [];
  for (let i = 0; i < 3; i++) {
    const state = eggReturnState(s, events),
      credit = eggReturnCredit(state, 1, 0);
    credits.push(credit);
    events.push(
      event("return", 1, i + 3, {
        return_of_id: s.id,
        return_tray_eggs: 1,
        return_loose_eggs: 0,
        amount: "-" + credit,
        currency: "NGN",
      }),
    );
  }
  expect(credits).toEqual(["0.3333", "0.3334", "0.3333"]);
  expect(eggReturnState(s, events)).toMatchObject({
    remainingTrayEggs: 0,
    creditedValue: "1.0000",
  });
  expect(() => eggReturnCredit(eggReturnState(s, events), 1, 0)).toThrow(
    /remaining/,
  );
});
it("separates returned sale quantities/value from inspected saleable stock and discarded returns", () => {
  const s = sale(),
    r = event("return", 1, 3, {
      return_of_id: s.id,
      return_tray_eggs: 2,
      return_loose_eggs: 0,
      amount: "-0.6667",
      currency: "NGN",
    });
  const source = {
    organization: {
      id: org,
      name: "Synthetic",
      currency: "NGN",
      timezone: "Africa/Lagos",
      today: "2024-02-01",
    },
    stores: [],
    batches: [],
    collections: [],
    events: [event("opening", 3, 1), s, r],
  } satisfies EggSource;
  const report = eggSummary(source);
  expect(report.totalEggs).toBe(1);
  expect(report.sales).toEqual([
    { currency: "NGN", netEggs: 1, netValue: "0.3333" },
  ]);
  expect(report.saleReturns[0]).toMatchObject({
    restockedEggs: 1,
    nonSaleableEggs: 1,
    returnedTrayEggs: 2,
  });
});
it("reverses customer returns latest-first and blocks full sale reversal while partial returns remain", () => {
  const s = sale(),
    r1 = event("return", 1, 3, {
      return_of_id: s.id,
      return_tray_eggs: 1,
      return_loose_eggs: 0,
      amount: "-0.3333",
      currency: "NGN",
    }),
    r2 = event("return", 1, 4, {
      return_of_id: s.id,
      return_tray_eggs: 1,
      return_loose_eggs: 0,
      amount: "-0.3334",
      currency: "NGN",
    }),
    events = [s, r1, r2];
  expect(eggReversible(s, events)).toBe(false);
  expect(eggReversible(r1, events)).toBe(false);
  expect(eggReversible(r2, events)).toBe(true);
  events.push(
    event("reversal", -1, 5, {
      reverses_id: r2.id,
      return_of_id: s.id,
      return_tray_eggs: 1,
      return_loose_eggs: 0,
      amount: "0.3334",
      currency: "NGN",
    }),
  );
  expect(eggReturnCredit(eggReturnState(s, events), 1, 0)).toBe("0.3334");
  expect(eggReturnState(s, events)).toMatchObject({
    returnedTrayEggs: 1,
    latestReturnId: r1.id,
    expectedPosition: "5",
  });
});
it("keeps transfer quantities conserved and marks incoming movement positions on the destination batch", () => {
  const dest = randomUUID(),
    events = [
      event("opening", 10, 1),
      event("transfer", -4, 2, { destination_batch_id: dest }),
      event("sale", -1, 3, {
        batch_id: dest,
        amount: "2.0000",
        currency: "NGN",
        pricing: { mode: "per-egg", eggs: 1, pricePerEgg: "2.0000" },
      }),
    ];
  const r = eggSummary({
    organization: {
      id: org,
      name: "Synthetic",
      currency: "NGN",
      timezone: "Africa/Lagos",
      today: "2024-02-01",
    },
    stores: [],
    batches: [],
    collections: [],
    events,
  });
  expect(r.balances).toEqual([
    { batchId: batch, grade: "large", eggs: 6 },
    { batchId: dest, grade: "large", eggs: 3 },
  ]);
  expect(r.totalEggs).toBe(9);
  expect(r.lastPositions[dest]).toBe("3");
});
it("uses original mixed pricing/currency and requires explicit returned/restock counts without client-supplied credit", () => {
  const s = event("sale", -62, 1, {
    amount: "9310.7500",
    currency: "USD",
    pricing: {
      mode: "tray-and-loose",
      trays: 2,
      traySize: 30,
      looseEggs: 2,
      pricePerTray: "4500.1250",
      pricePerEgg: "155.2500",
    },
  });
  expect(eggReturnCredit(eggReturnState(s, [s]), 1, 1)).toBe("305.2542");
  const input = {
    organizationId: org,
    eventId: randomUUID(),
    batchId: batch,
    date: "2024-02-01",
    kind: "return",
    saleId: s.id,
    trayEggs: 1,
    looseEggs: 1,
    restockEggs: 0,
    expectedReturnPosition: "1",
    reference: "RMA-TEST",
    reason: "Synthetic review",
    evidence: "Return sheet",
  };
  expect(eggEventInput.safeParse(input).success).toBe(true);
  for (const bad of [
    { ...input, restockEggs: 3 },
    { ...input, amount: "999" },
    { ...input, restockEggs: undefined },
    { ...input, trayEggs: 0, looseEggs: 0 },
  ])
    expect(eggEventInput.safeParse(bad).success).toBe(false);
});
