import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { admin } from "./admin-db";
import { tenant, pool } from "../src/lib/db";
import { productionApi } from "../src/lib/production-api";
import { economicsFixture } from "./broiler-economics-fixture";
import { planFixture } from "./broiler-planning-fixture";
import type {
  EconomicsReport,
  EconomicsWorkspace,
  EconomicsComparison,
} from "../src/lib/broiler-economics";
let owner: string,
  worker: string,
  auditor: string,
  outsider: string,
  org: string,
  foreign: string,
  unit: string,
  otherUnit: string,
  planId: string,
  foreignPlan: string;
const post = async (actor: string, path: string, p: unknown) =>
  (await productionApi(
    new NextRequest("http://localhost/api/" + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(p),
    }),
    { id: actor },
    path,
  ))!;
const get = async (
  actor = owner,
  id: string | null = null,
  format = "workspace",
  extra = "",
) =>
  (await productionApi(
    new NextRequest(
      `http://localhost/api/broilers/economics${extra.startsWith("compare") ? "/compare" : ""}?organizationId=${org}&unitId=${unit}${id ? "&scenarioId=" + id : ""}&format=${format}${extra.startsWith("compare") ? extra.slice(7) : extra}`,
    ),
    { id: actor },
    extra.startsWith("compare")
      ? "broilers/economics/compare"
      : "broilers/economics",
  ))!;
const workspace = async (actor = owner): Promise<EconomicsWorkspace> =>
  (await get(actor)).json();
async function payload() {
  return {
    organizationId: org,
    unitId: unit,
    scenarioId: randomUUID(),
    previousId: (await workspace()).history[0]?.id ?? null,
    planId,
    data: economicsFixture(),
  };
}
async function counts() {
  return (
    await tenant(owner, (c) =>
      c.query(
        "SELECT (SELECT count(*) FROM daily_records WHERE unit_id=$1) AS daily,(SELECT count(*) FROM broiler_events WHERE unit_id=$1) AS events,(SELECT count(*) FROM broiler_reviews WHERE unit_id=$1) AS reviews,(SELECT count(*) FROM forecasts WHERE organization_id=$2) AS forecasts,(SELECT recorded_balance FROM production_population_balances WHERE id=$1) AS balance",
        [unit, org],
      ),
    )
  ).rows[0];
}
beforeAll(async () => {
  const users = [];
  for (let i = 0; i < 4; i++)
    users.push(
      (
        await admin.query(
          "INSERT INTO users(email,password_hash) VALUES($1,'fixture') RETURNING id",
          [randomUUID() + "@test.invalid"],
        )
      ).rows[0].id,
    );
  [owner, worker, auditor, outsider] = users;
  org = (
    await tenant(owner, (c) =>
      c.query("SELECT create_organization('Synthetic economics') AS id"),
    )
  ).rows[0].id;
  foreign = (
    await tenant(outsider, (c) =>
      c.query("SELECT create_organization('Foreign economics') AS id"),
    )
  ).rows[0].id;
  await admin.query(
    "INSERT INTO memberships VALUES($1,$2,'worker'),($1,$3,'auditor')",
    [org, worker, auditor],
  );
  for (const [actor, o] of [
    [owner, org],
    [outsider, foreign],
  ]) {
    const f = (
      await tenant(actor, (c) =>
        c.query(
          "INSERT INTO farms(organization_id,name,kind) VALUES($1,'Synthetic budget farm','broilers') RETURNING id",
          [o],
        ),
      )
    ).rows[0].id;
    const u = (
      await (
        await post(actor, "units", {
          organizationId: o,
          farmId: f,
          name: "Synthetic budget batch",
          kind: "broilers",
          stockedOn: "2024-02-01",
          openingCount: 100,
          initialWeightG: 1000,
        })
      ).json()
    ).id;
    const p = await (
      await post(actor, "broilers/plans", {
        organizationId: o,
        unitId: u,
        planId: randomUUID(),
        previousId: null,
        data: planFixture(),
      })
    ).json();
    if (actor === owner) {
      unit = u;
      planId = p.source.id;
      otherUnit = (
        await (
          await post(actor, "units", {
            organizationId: o,
            farmId: f,
            name: "Other batch",
            kind: "broilers",
            stockedOn: "2024-02-01",
            openingCount: 100,
            initialWeightG: 1000,
          })
        ).json()
      ).id;
    } else foreignPlan = p.source.id;
  }
});
afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])", [
    [org, foreign],
  ]);
  await admin.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
    [owner, worker, auditor, outsider],
  ]);
  await pool.end();
  await admin.end();
});
it("previews explicit budgets for members and saves source-derived calculations without operational postings", async () => {
  const before = await counts(),
    p = await payload();
  const preview = await (
    await post(auditor, "broilers/economics/preview", p)
  ).json();
  expect(preview.economics).toMatchObject({
    totalPlannedCost: "229.5500",
    projectedMargin: "2443.4500",
  });
  expect((await workspace()).history).toHaveLength(0);
  const r = await post(owner, "broilers/economics", p);
  expect(r.status).toBe(201);
  const saved: EconomicsReport = await r.json();
  expect(saved.source.plan_snapshot.id).toBe(planId);
  expect(saved.plan.evidenceSha256).toBe(
    createHash("sha256")
      .update(
        JSON.stringify({
          source: saved.plan.source,
          forecast: saved.plan.forecast,
        }),
      )
      .digest("hex"),
  );
  expect(saved.evidenceSha256).toBe(
    createHash("sha256")
      .update(
        JSON.stringify({
          source: saved.source,
          plan: saved.plan,
          economics: saved.economics,
        }),
      )
      .digest("hex"),
  );
  expect(await counts()).toEqual(before);
});
it("normalizes exact receipt retries without repeated audit and rejects changed receipt claims", async () => {
  const p = await payload();
  expect((await post(owner, "broilers/economics", p)).status).toBe(201);
  const audit = async () =>
    (
      await tenant(owner, (c) =>
        c.query("SELECT count(*) FROM audit_logs WHERE organization_id=$1", [
          org,
        ]),
      )
    ).rows[0].count;
  const before = await audit();
  p.data.salePrice = "20.0000";
  p.data.costs[0].amount = "10.0000";
  expect((await post(owner, "broilers/economics", p)).status).toBe(200);
  expect(await audit()).toBe(before);
  await expect(
    post(owner, "broilers/economics", {
      ...p,
      data: { ...p.data, name: "Different" },
    }),
  ).rejects.toMatchObject({ status: 409 });
});
it("serializes competing manager scenarios and preserves the rejected working input", async () => {
  const p = await payload(),
    results = await Promise.allSettled([
      post(owner, "broilers/economics", p),
      post(owner, "broilers/economics", {
        ...p,
        scenarioId: randomUUID(),
        data: { ...p.data, name: "Other manager" },
      }),
    ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { status: 409 },
  });
  expect((await workspace()).history).toHaveLength(3);
});
it("proves real owner/auditor rows versus outsiders and rejects role, exact-plan and cross-batch attacks", async () => {
  const p = await payload();
  expect((await workspace(auditor)).history).toHaveLength(3);
  expect(
    (
      await tenant(outsider, (c) =>
        c.query(
          "SELECT * FROM broiler_economic_scenarios WHERE organization_id=$1",
          [org],
        ),
      )
    ).rowCount,
  ).toBe(0);
  for (const actor of [worker, auditor, outsider])
    await expect(post(actor, "broilers/economics", p)).rejects.toMatchObject({
      status: 403,
    });
  await expect(workspace(outsider)).rejects.toMatchObject({ status: 404 });
  for (const patch of [
    { planId: foreignPlan },
    { planId: randomUUID() },
    { unitId: otherUnit },
  ])
    await expect(
      post(owner, "broilers/economics", { ...p, ...patch }),
    ).rejects.toMatchObject({ status: 404 });
  await expect(
    post(owner, "broilers/economics/preview", { ...p, planId: foreignPlan }),
  ).rejects.toMatchObject({ status: 404 });
});
it("independently validates direct runtime source structure, actor/time, quantities, immutable snapshots and historical rows", async () => {
  const p = await payload();
  const insert = (
    actor: string,
    input: unknown,
    fields = "",
    values: unknown[] = [],
  ) =>
    tenant(actor, (c) =>
      c.query(
        `INSERT INTO broiler_economic_scenarios(id,organization_id,unit_id,previous_id,plan_id,input${fields}) VALUES($1,$2,$3,$4,$5,$6${values.map((_, i) => ",$" + (i + 7)).join("")}) RETURNING plan_snapshot,revision`,
        [
          randomUUID(),
          org,
          unit,
          p.previousId,
          planId,
          JSON.stringify(input),
          ...values,
        ],
      ),
    );
  for (const input of [
    { ...p.data, profit: "999" },
    { ...p.data, completeBudget: null },
    { ...p.data, costs: [...p.data.costs.slice(1), p.data.costs[1]] },
    { ...p.data, saleBasis: null },
    { ...p.data, yieldFraction: "1.1" },
    { ...p.data, priceEvidence: "" },
    {
      ...p.data,
      costs: p.data.costs.map((c, i) => (i ? c : { ...c, amount: "-1" })),
    },
  ])
    await expect(insert(owner, input)).rejects.toMatchObject({ code: "23514" });
  for (const actor of [worker, auditor, outsider])
    await expect(insert(actor, p.data)).rejects.toHaveProperty("code");
  await expect(
    insert(owner, p.data, ",created_by", [auditor]),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    insert(owner, p.data, ",created_at", ["2024-01-01"]),
  ).rejects.toMatchObject({ code: "42501" });
  const valid = (
    await insert(owner, p.data, ",plan_snapshot,revision", [
      '{"input":{"currency":"FAKE"}}',
      99,
    ])
  ).rows[0];
  expect(valid.plan_snapshot.id).toBe(planId);
  expect(valid.plan_snapshot.input.currency).toBe("NGN");
  expect(valid.revision).toBe(4);
  for (const sql of [
    "UPDATE broiler_economic_scenarios SET input='{}' WHERE unit_id=$1",
    "DELETE FROM broiler_economic_scenarios WHERE unit_id=$1",
  ])
    await expect(
      tenant(owner, (c) => c.query(sql, [unit])),
    ).rejects.toMatchObject({ code: "42501" });
});
it("rejects competing direct-runtime successors under the shared unit lock", async () => {
  const p = await payload(),
    insert = () =>
      tenant(owner, (c) =>
        c.query(
          "INSERT INTO broiler_economic_scenarios(id,organization_id,unit_id,previous_id,plan_id,input) VALUES($1,$2,$3,$4,$5,$6)",
          [
            randomUUID(),
            org,
            unit,
            p.previousId,
            planId,
            JSON.stringify(p.data),
          ],
        ),
      );
  const results = await Promise.allSettled([insert(), insert()]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { code: "23505" },
  });
});
it("compares exact two-to-four saved versions with explicit baseline, complete sources, unknown deltas and currency refusal", async () => {
  const p = await payload();
  p.data.costs[0].amount = "20";
  const a: EconomicsReport = await (
    await post(owner, "broilers/economics", p)
  ).json();
  p.previousId = a.source.id;
  p.scenarioId = randomUUID();
  p.data.costs[0].amount = null;
  const b: EconomicsReport = await (
    await post(owner, "broilers/economics", p)
  ).json();
  const query = `compare&scenarioId=${a.source.id}&scenarioId=${b.source.id}&baselineId=${a.source.id}`;
  const r = await get(auditor, null, "json", query),
    c: EconomicsComparison = await r.json();
  expect(c.reports.map((r) => r.source.id)).toEqual([a.source.id, b.source.id]);
  expect(c.comparisons[1].deltas.projectedMargin).toBeNull();
  expect(c.reports[0].economics.totalPlannedCost).toBe("239.5500");
  expect(await (await get(auditor, null, "csv", query)).text()).toContain(
    '"Comparison source"',
  );
  await expect(
    get(owner, null, "json", query.replace(b.source.id, randomUUID())),
  ).rejects.toMatchObject({ status: 404 });
  await expect(get(outsider, null, "json", query)).rejects.toMatchObject({
    status: 404,
  });
  await expect(
    get(
      owner,
      null,
      "json",
      query.replace(`baselineId=${a.source.id}`, `baselineId=${randomUUID()}`),
    ),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    get(owner, null, "json", query.replace(b.source.id, a.source.id)),
  ).rejects.toHaveProperty("issues");
});
it("keeps old report bytes after plan/settings/actual changes and forbids mixing original currencies", async () => {
  const w = await workspace(),
    old = w.selected!,
    before = await (await get(auditor, old.source.id, "csv")).text();
  await tenant(owner, (c) =>
    c.query(
      "UPDATE organizations SET currency='USD',timezone='UTC' WHERE id=$1",
      [org],
    ),
  );
  const source = planFixture();
  source.currency = "USD";
  source.stages[0].pricePerKg = "100";
  const nextPlan = await (
    await post(owner, "broilers/plans", {
      organizationId: org,
      unitId: unit,
      planId: randomUUID(),
      previousId: planId,
      data: source,
    })
  ).json();
  const p = await payload();
  p.planId = nextPlan.source.id;
  const next: EconomicsReport = await (
    await post(owner, "broilers/economics", p)
  ).json();
  await post(owner, "records", {
    organizationId: org,
    unitId: unit,
    recordedOn: "2024-02-01",
    mortality: 1,
    eggs: 0,
    cracked: 0,
    feedKg: 2,
    averageWeightG: 1100,
    sampleSize: 10,
    waterQuality: null,
    notes: "Synthetic actual",
  });
  const after: EconomicsReport = await (
    await get(auditor, old.source.id, "json")
  ).json();
  expect(after).toEqual(old);
  expect(await (await get(auditor, old.source.id, "csv")).text()).toBe(before);
  expect(after.economics.currency).toBe("NGN");
  await expect(
    get(
      owner,
      null,
      "json",
      `compare&scenarioId=${old.source.id}&scenarioId=${next.source.id}&baselineId=${old.source.id}`,
    ),
  ).rejects.toMatchObject({ status: 400 });
  expect(await counts()).toEqual({
    daily: "1",
    events: "0",
    reviews: "0",
    forecasts: "0",
    balance: "99",
  });
});
it("exports exact private source-linked evidence with formula-safe names and requires exact saved identifiers", async () => {
  const p = await payload();
  p.data.name = "=Synthetic budget";
  const saved: EconomicsReport = await (
    await post(owner, "broilers/economics", p)
  ).json();
  const r = await get(auditor, saved.source.id, "csv");
  expect(r.headers.get("cache-control")).toBe("private, no-store");
  expect(r.headers.get("x-evidence-sha256")).toBe(saved.evidenceSha256);
  const csv = await r.text();
  expect(csv).toContain('"Scenario name","\'=Synthetic budget"');
  expect(csv).toContain('"Linked plan report"');
  await expect(get(auditor, null, "json")).rejects.toMatchObject({
    status: 400,
  });
  await expect(
    post(owner, "broilers/economics", {
      ...(await payload()),
      economics: { profit: 999 },
    }),
  ).rejects.toHaveProperty("issues");
});
