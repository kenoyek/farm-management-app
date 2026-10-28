import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { admin } from "./admin-db";
import { pool, tenant } from "../src/lib/db";
import { productionApi } from "../src/lib/production-api";
let owner: string,
  auditor: string,
  outsider: string,
  org: string,
  foreignOrg: string,
  farm: string,
  unit: string,
  broiler: string,
  baseline: string,
  legacy: string,
  foreignForecast: string;
async function post(actor: string, path: string, data: unknown) {
  return (await productionApi(
    new NextRequest("http://localhost/api/" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
    { id: actor },
    path,
  ))!;
}
const options = () => ({
  organizationId: org,
  unitId: unit,
  from: "2024-02-01",
  to: "2024-02-03",
  traySize: 30,
  forecastId: baseline,
});
const forecast = () => ({
  organizationId: org,
  name: "Synthetic layer calendar",
  kind: "layer-eggs",
  opening: 100,
  startMonth: "2024-02",
  traySize: 30,
  legacy28: false,
  periods: [{ lay: 0.8, mortality: 0.1, cracks: 0.05 }],
});
async function exportReport(actor: string, format = "csv", data = options()) {
  const query = new URLSearchParams({
    ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
    format,
  });
  return (await productionApi(
    new NextRequest("http://localhost/api/layers/report?" + query),
    { id: actor },
    "layers/report",
  ))!;
}
beforeAll(async () => {
  const users = [];
  for (let i = 0; i < 3; i++)
    users.push(
      (
        await admin.query(
          "INSERT INTO users(email,password_hash) VALUES($1,'fixture') RETURNING id",
          [randomUUID() + "@test.invalid"],
        )
      ).rows[0].id,
    );
  [owner, auditor, outsider] = users;
  org = (
    await tenant(owner, (c) =>
      c.query("SELECT create_organization('Synthetic layer report') AS id"),
    )
  ).rows[0].id;
  foreignOrg = (
    await tenant(outsider, (c) =>
      c.query("SELECT create_organization('Foreign layer report') AS id"),
    )
  ).rows[0].id;
  await admin.query("INSERT INTO memberships VALUES($1,$2,'auditor')", [
    org,
    auditor,
  ]);
  farm = (
    await tenant(owner, (c) =>
      c.query(
        "INSERT INTO farms(organization_id,name,kind) VALUES($1,'Synthetic layer farm','layers') RETURNING id",
        [org],
      ),
    )
  ).rows[0].id;
  for (const kind of ["layers", "broilers"]) {
    const r = await post(owner, "units", {
      organizationId: org,
      farmId: farm,
      name: "=Synthetic " + kind,
      kind,
      stockedOn: "2024-02-01",
      openingCount: 100,
      initialWeightG: 100,
    });
    const id = (await r.json()).id;
    if (kind === "layers") unit = id;
    else broiler = id;
  }
  for (const [i, r] of [
    { mortality: 2, eggs: 80, cracked: 2, feedKg: 1.125 },
    { mortality: 0, eggs: 0, cracked: 0, feedKg: 0 },
    { mortality: 1, eggs: 90, cracked: 1, feedKg: 1.4 },
  ].entries())
    await post(owner, "records", {
      organizationId: org,
      unitId: unit,
      recordedOn: `2024-02-0${i + 1}`,
      ...r,
      averageWeightG: null,
      sampleSize: null,
      waterQuality: null,
      notes: "Synthetic actual observation only",
    });
  baseline = (await (await post(owner, "forecasts/save", forecast())).json())
    .id;
  legacy = (
    await (
      await post(owner, "forecasts/save", {
        ...forecast(),
        name: "Synthetic legacy 28-day",
        legacy28: true,
      })
    ).json()
  ).id;
  foreignForecast = (
    await (
      await post(outsider, "forecasts/save", {
        ...forecast(),
        organizationId: foreignOrg,
      })
    ).json()
  ).id;
});
afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])", [
    [org, foreignOrg],
  ]);
  await admin.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
    [owner, auditor, outsider],
  ]);
  await pool.end();
  await admin.end();
});
it("reports real owner/auditor-visible records with weighted hen-days, exact totals and aligned forecast variances", async () => {
  const response = await post(auditor, "layers/report", options());
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const r = await response.json();
  expect(r).toMatchObject({
    henDays: 296,
    actualTotals: { eggs: 170, cracked: 3, saleable: 167, feedKg: "2.525000" },
    deltas: { gross: -70, cracked: -9, saleable: -61 },
    wholeTrays: 5,
    remainderEggs: 17,
  });
  expect(r.henDayPercent).toBeCloseTo((170 / 296) * 100, 10);
  expect(r.rows[1]).toMatchObject({ eggs: 0, henDayPercent: 0 });
  expect(r.sourceSnapshot.records).toHaveLength(3);
  expect(r.sourceSnapshot.forecast.id).toBe(baseline);
});
it("exports authenticated source snapshots with matching digests and spreadsheet-safe names without writing production or forecasts", async () => {
  const before = (
    await tenant(owner, (c) =>
      c.query("SELECT count(*) FROM audit_logs WHERE organization_id=$1", [
        org,
      ]),
    )
  ).rows[0].count;
  const calculated = await (
      await post(owner, "layers/report", options())
    ).json(),
    csv = await exportReport(auditor),
    json = await exportReport(owner, "json");
  expect(csv.headers.get("x-layer-snapshot-sha256")).toBe(
    calculated.evidenceSha256,
  );
  expect((await json.json()).evidenceSha256).toBe(calculated.evidenceSha256);
  const text = await csv.text();
  expect(text).toContain("'=Synthetic layers");
  expect(text).toContain("2.525000");
  expect(text).toContain("-70");
  expect(csv.headers.get("content-disposition")).toContain(".csv");
  expect(
    (
      await tenant(owner, (c) =>
        c.query("SELECT count(*) FROM audit_logs WHERE organization_id=$1", [
          org,
        ]),
      )
    ).rows[0].count,
  ).toBe(before);
});
it("denies outsiders, forged tenant/forecast IDs, wrong unit types and unsupported historical forecast evidence", async () => {
  for (const [actor, data] of [
    [outsider, options()],
    [owner, { ...options(), organizationId: foreignOrg }],
    [owner, { ...options(), forecastId: foreignForecast }],
  ] as [string, ReturnType<typeof options>][])
    await expect(post(actor, "layers/report", data)).rejects.toMatchObject({
      status: 404,
    });
  await expect(exportReport(outsider)).rejects.toMatchObject({ status: 404 });
  await expect(
    post(owner, "layers/report", { ...options(), unitId: broiler }),
  ).rejects.toMatchObject({ status: 422 });
  const broken = (
    await tenant(owner, (c) =>
      c.query(
        "INSERT INTO forecasts(organization_id,name,kind,input,result) VALUES($1,'Synthetic incomplete historical forecast','layer-eggs','{}','{}') RETURNING id",
        [org],
      ),
    )
  ).rows[0].id;
  await expect(
    post(owner, "layers/report", { ...options(), forecastId: broken }),
  ).rejects.toMatchObject({ status: 422 });
  const r = await (
    await post(auditor, "layers/report", { ...options(), forecastId: legacy })
  ).json();
  expect(r.actualTotals.eggs).toBe(170);
  expect(r.expectedTotals).toBeNull();
  expect(r.deltas).toBeNull();
});
it("keeps historical-window report evidence and original forecasts unchanged after later actual observations", async () => {
  const before = await (await post(owner, "layers/report", options())).json(),
    csv = await (await exportReport(owner)).text();
  await post(owner, "records", {
    organizationId: org,
    unitId: unit,
    recordedOn: "2024-02-04",
    mortality: 0,
    eggs: 70,
    cracked: 0,
    feedKg: 1,
    averageWeightG: null,
    sampleSize: null,
    waterQuality: null,
    notes: "Synthetic later actual observation",
  });
  const after = await (await post(auditor, "layers/report", options())).json();
  expect(after.evidenceSha256).toBe(before.evidenceSha256);
  expect(after.sourceSnapshot).toEqual(before.sourceSnapshot);
  expect(await (await exportReport(auditor)).text()).toBe(csv);
  await expect(
    tenant(owner, (c) =>
      c.query("UPDATE forecasts SET result='{}' WHERE id=$1", [baseline]),
    ),
  ).rejects.toMatchObject({ code: "42501" });
});
it("withholds full-window totals after a missing date while retaining recorded subtotals and exact source IDs", async () => {
  await post(owner, "records", {
    organizationId: org,
    unitId: unit,
    recordedOn: "2024-02-06",
    mortality: 0,
    eggs: 65,
    cracked: 1,
    feedKg: 1,
    averageWeightG: null,
    sampleSize: null,
    waterQuality: null,
    notes: "Synthetic observation after missing day",
  });
  const r = await (
    await post(auditor, "layers/report", {
      ...options(),
      from: "2024-02-05",
      to: "2024-02-06",
    })
  ).json();
  expect(r.coverage.missingDates).toEqual(["2024-02-05"]);
  expect(r.actualTotals).toBeNull();
  expect(r.recordedTotals.eggs).toBe(65);
  expect(r.henDays).toBeNull();
  expect(r.rows[1].openingHens).toBeNull();
  expect(r.deltas).toBeNull();
});
