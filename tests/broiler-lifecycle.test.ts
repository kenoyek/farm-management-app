import { it, expect } from "vitest";
import {
  broilerSummary,
  harvestAmount,
  broilerEventInput,
  broilerCsv,
  type BroilerSource,
  type BroilerEvent,
} from "../src/lib/broiler-lifecycle";
import { randomUUID } from "node:crypto";
const unit = {
  id: randomUUID(),
  name: "=Synthetic broilers",
  kind: "broilers",
  stocked_on: "2024-02-01",
  opening_count: 100,
  initial_weight_g: "1000.000000",
};
const daily = (
  date: string,
  weight: string | null = "2000.000000",
  mortality = 0,
) => ({
  id: randomUUID(),
  recorded_on: date,
  mortality,
  feed_kg: "10.000000",
  average_weight_g: weight,
  sample_size: weight ? 10 : null,
});
const event = (values: Partial<BroilerEvent>): BroilerEvent =>
  ({
    id: randomUUID(),
    kind: "harvest",
    quantity: 10,
    weight_kg: "20.000000",
    recorded_on: "2024-02-01",
    position: "1",
    price_basis: "kg",
    price_per_unit: "3.1234",
    amount: "62.4680",
    currency: "NGN",
    ...values,
  }) as BroilerEvent;
const source = (values: Partial<BroilerSource> = {}): BroilerSource => ({
  unit,
  records: [daily("2024-02-01"), daily("2024-02-02")],
  events: [],
  timezone: "Africa/Lagos",
  today: "2024-02-02",
  ...values,
});
it("includes measured partial harvests once in the cohort gain and separately in sales", () => {
  const s = broilerSummary(source({ events: [event({})] }));
  expect(s).toMatchObject({
    balance: 90,
    harvested: 10,
    cohortGainKg: "100.000000",
    fcr: "0.200000",
    sales: { NGN: "62.4680" },
  });
});
it("withholds FCR for feed gaps, mortality, unweighed culls and samples before selective withdrawals", () => {
  expect(
    broilerSummary(source({ records: [daily("2024-02-02")] })).fcr,
  ).toBeNull();
  expect(
    broilerSummary(
      source({
        records: [daily("2024-02-01", "2000", 1), daily("2024-02-02")],
      }),
    ).fcrUnavailableReasons.join(" "),
  ).toContain("Dead-bird biomass");
  expect(
    broilerSummary(
      source({ events: [event({ kind: "cull", weight_kg: null })] }),
    ).fcrUnavailableReasons.join(" "),
  ).toContain("no measured");
  expect(
    broilerSummary(
      source({ events: [event({ recorded_on: "2024-02-02" })] }),
    ).fcrUnavailableReasons.join(" "),
  ).toContain("after the last withdrawal");
});
it("allows a complete weighed final harvest without inventing a remaining sample", () => {
  const s = broilerSummary(
    source({
      records: [daily("2024-02-01", null)],
      events: [event({ quantity: 100, weight_kg: "200.000000" })],
    }),
  );
  expect(s).toMatchObject({
    balance: 0,
    estimatedClosingBiomassKg: "0.000000",
    fcr: "0.100000",
  });
  expect(
    broilerSummary(
      source({
        records: [daily("2024-02-01", null)],
        events: [event({ quantity: 100, weight_kg: "50.000000" })],
      }),
    ).fcr,
  ).toBeNull();
});
it("voids only remove the original effect, preserves currencies and counts unpriced harvests", () => {
  const first = event({});
  const s = broilerSummary(
    source({
      events: [
        first,
        event({
          kind: "void",
          void_of_id: first.id,
          position: "2",
          quantity: null,
          weight_kg: null,
        }),
        event({
          id: randomUUID(),
          position: "3",
          amount: "1.0001",
          currency: "USD",
        }),
        event({
          position: "4",
          amount: null,
          currency: null,
          price_basis: "unpriced",
        }),
      ],
    }),
  );
  expect(s).toMatchObject({
    balance: 80,
    harvested: 20,
    sales: { USD: "1.0001" },
    unpricedHarvests: 1,
  });
});
it("retains unknown treatment holds and exact HALF_UP money with explicit precision", () => {
  expect(harvestAmount(3, "0.123456", "kg", "0.1234")).toBe("0.0152");
  expect(harvestAmount(3, "1", "bird", "0.3333")).toBe("0.9999");
  expect(() => harvestAmount(1, "100000000", "kg", "100000000")).toThrow(
    "money precision",
  );
  expect(
    broilerSummary(
      source({
        events: [event({ kind: "treatment", earliest_harvest_on: null })],
      }),
    ).holds,
  ).toHaveLength(1);
});
it("requires whole birds, measured harvest weight, explicit price state and rejects client amounts", () => {
  const p = {
    organizationId: randomUUID(),
    unitId: unit.id,
    eventId: randomUUID(),
    date: "2024-02-02",
    expectedPosition: "0",
    expectedDailyId: null,
    description: "Observed birds",
    reason: "Synthetic reviewed harvest",
    evidence: "Weighbridge record",
    kind: "harvest",
    quantity: 1,
    weightKg: "1.123456",
    priceBasis: "unpriced",
    pricePerUnit: null,
    customer: null,
    reference: null,
  };
  expect(broilerEventInput.safeParse(p).success).toBe(true);
  for (const values of [
    { quantity: 1.5 },
    { weightKg: null },
    { weightKg: "1.1234567" },
    { weightKg: "foo" },
    { weightKg: "" },
    { pricePerUnit: "NaN", priceBasis: "kg" },
    {
      quantity: 100000000,
      weightKg: "100000000",
      priceBasis: "kg",
      pricePerUnit: "100000000",
      reference: "Synthetic reference",
      customer: "Synthetic customer",
    },
    { amount: "1" },
    { priceBasis: "kg" },
    { pricePerUnit: "0" },
  ])
    expect(broilerEventInput.safeParse({ ...p, ...values }).success).toBe(
      false,
    );
  const snapshot = {
    ...source(),
    modelVersion: "v1",
    summary: broilerSummary(source()),
    evidenceSha256: "synthetic",
  };
  expect(broilerCsv(snapshot)).toContain("'=Synthetic broilers");
});
it("labels and round-trips every CSV source cell including literal notes and complete evidence", () => {
  const record = {
    ...daily("2024-02-01"),
    notes: 'Synthetic source "note", with a comma',
    created_at: "2024-02-01T12:00:00Z",
  };
  const s = source({ records: [record] });
  const csv = broilerCsv({
    ...s,
    modelVersion: "v1",
    summary: broilerSummary(s),
    evidenceSha256: "source-digest",
  });
  // Independent CSV reader: embedded escaped quotes remain literal.
  const rows = csv.split("\r\n").map((line) => {
    const values: string[] = [];
    let value = "",
      quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') {
          value += '"';
          i++;
        } else quoted = !quoted;
      } else if (ch === "," && !quoted) {
        values.push(value);
        value = "";
      } else value += ch;
    }
    values.push(value);
    return values;
  });
  const i = rows.findIndex((r) => r[0] === "Original daily records");
  expect(rows[i + 1]).toHaveLength(rows[i + 2].length);
  expect(rows[i + 1].at(-1)).toBe("Complete original source");
  expect(JSON.parse(rows[i + 2].at(-1)!)).toEqual(record);
  expect(
    JSON.parse(rows.find((r) => r[0] === "Original unit source")![1]),
  ).toEqual(unit);
});
