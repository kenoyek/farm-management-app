import { admin } from "./admin-db";
import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { pool, tenant } from "../src/lib/db";
let owner: string,
  other: string,
  org: string,
  foreignOrg: string,
  farm: string,
  foreignFarm: string,
  unit: string;
beforeAll(async () => {
  owner = (
    await admin.query(
      "INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id",
      [`${randomUUID()}@test.invalid`, "test"],
    )
  ).rows[0].id;
  other = (
    await admin.query(
      "INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id",
      [`${randomUUID()}@test.invalid`, "test"],
    )
  ).rows[0].id;
  org = await tenant(
    owner,
    async (c) =>
      (await c.query("SELECT create_organization('Production test') AS id"))
        .rows[0].id,
  );
  foreignOrg = await tenant(
    other,
    async (c) =>
      (await c.query("SELECT create_organization('Foreign test') AS id"))
        .rows[0].id,
  );
  farm = (
    await tenant(owner, (c) =>
      c.query(
        "INSERT INTO farms(organization_id,name,kind) VALUES($1,'Home farm','mixed') RETURNING id",
        [org],
      ),
    )
  ).rows[0].id;
  foreignFarm = (
    await tenant(other, (c) =>
      c.query(
        "INSERT INTO farms(organization_id,name,kind) VALUES($1,'Away farm','mixed') RETURNING id",
        [foreignOrg],
      ),
    )
  ).rows[0].id;
  unit = (
    await tenant(owner, (c) =>
      c.query(
        "INSERT INTO production_units(organization_id,farm_id,name,kind,stocked_on,opening_count,initial_weight_g) VALUES($1,$2,'Flock A','layers','2020-01-01',100,100) RETURNING id",
        [org, farm],
      ),
    )
  ).rows[0].id;
  await tenant(owner, async (c) => {
    const ingredient = (
      await c.query(
        "INSERT INTO ingredients(organization_id,name,source,nutrients) VALUES($1,'Unverified source','Fixture provenance','{}') RETURNING id",
        [org],
      )
    ).rows[0];
    await c.query(
      "INSERT INTO formula_versions(organization_id,name,batch_kg,lines,ingredient_snapshot,result) VALUES($1,'Draft fixture',100,'[]','[]','{}')",
      [org],
    );
    await c.query(
      "INSERT INTO forecasts(organization_id,name,kind,input,result) VALUES($1,'Forecast fixture','layer-feed','{}','{}')",
      [org],
    );
    await c.query(
      "INSERT INTO imports(organization_id,source_hashes,raw_data) VALUES($1,'[]','[]')",
      [org],
    );
    await c.query(
      "INSERT INTO optimization_runs(organization_id,request,result) VALUES($1,'{}','{}')",
      [org],
    );
    expect(ingredient.id).toBeTruthy();
  });
});
afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])", [
    [org, foreignOrg],
  ]);
  await admin.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
    [owner, other],
  ]);
  await pool.end();
  await admin.end();
});
it("enforces composite tenant parent ownership", async () => {
  await expect(
    tenant(owner, (c) =>
      c.query(
        "INSERT INTO production_units(organization_id,farm_id,name,kind,stocked_on,opening_count,initial_weight_g) VALUES($1,$2,'Forged','layers','2020-01-01',100,100)",
        [org, foreignFarm],
      ),
    ),
  ).rejects.toMatchObject({ code: "23503" });
});
it("persists real production and prevents duplicate, out-of-order, future or excessive mortality", async () => {
  await tenant(owner, (c) =>
    c.query(
      "INSERT INTO daily_records(organization_id,unit_id,recorded_on,mortality,eggs,cracked,feed_kg) VALUES($1,$2,'2020-01-02',5,80,2,10)",
      [org, unit],
    ),
  );
  for (const [date, deaths] of [
    ["2020-01-02", 0],
    ["2019-12-01", 0],
    ["2199-01-01", 0],
    ["2020-01-03", 96],
  ] as const)
    await expect(
      tenant(owner, (c) =>
        c.query(
          "INSERT INTO daily_records(organization_id,unit_id,recorded_on,mortality) VALUES($1,$2,$3,$4)",
          [org, unit, date, deaths],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  expect(
    (
      await tenant(owner, (c) =>
        c.query(
          "SELECT sum(mortality)::int AS deaths FROM daily_records WHERE unit_id=$1",
          [unit],
        ),
      )
    ).rows[0].deaths,
  ).toBe(5);
});
it("serializes concurrent mortality entries so live stock cannot become negative", async () => {
  const settled = await Promise.allSettled([
    tenant(owner, (c) =>
      c.query(
        "INSERT INTO daily_records(organization_id,unit_id,recorded_on,mortality) VALUES($1,$2,'2020-01-04',60)",
        [org, unit],
      ),
    ),
    tenant(owner, (c) =>
      c.query(
        "INSERT INTO daily_records(organization_id,unit_id,recorded_on,mortality) VALUES($1,$2,'2020-01-04',60)",
        [org, unit],
      ),
    ),
  ]);
  expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(
    (
      await tenant(owner, (c) =>
        c.query(
          "SELECT sum(mortality)::int AS deaths FROM daily_records WHERE unit_id=$1",
          [unit],
        ),
      )
    ).rows[0].deaths,
  ).toBe(65);
});
it("denies outsiders production, reference, recipe, forecast and import data", async () => {
  for (const table of [
    "production_units",
    "daily_records",
    "ingredients",
    "formula_versions",
    "optimization_runs",
    "forecasts",
    "imports",
  ]) {
    expect(
      (
        await tenant(owner, (c) =>
          c.query(`SELECT * FROM ${table} WHERE organization_id=$1`, [org]),
        )
      ).rows.length,
    ).toBeGreaterThan(0);
    expect(
      (
        await tenant(other, (c) =>
          c.query(`SELECT * FROM ${table} WHERE organization_id=$1`, [org]),
        )
      ).rows,
    ).toHaveLength(0);
  }
  await expect(
    tenant(other, (c) =>
      c.query(
        "INSERT INTO daily_records(organization_id,unit_id,recorded_on) VALUES($1,$2,'2020-01-05')",
        [org, unit],
      ),
    ),
  ).rejects.toMatchObject({ code: "23503" });
});
it("does not allow owners to approve scientific data or manufacture approved recipes", async () => {
  await expect(
    tenant(owner, (c) =>
      c.query(
        "INSERT INTO ingredients(organization_id,name,source,nutrients,review_status) VALUES($1,'Unsafe','unknown','{}','approved')",
        [org],
      ),
    ),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    tenant(owner, (c) =>
      c.query(
        "INSERT INTO requirement_profiles(organization_id,name,species,stage,limits,source,basis,energy_system) VALUES($1,'Unsafe','poultry','starter','{}','unknown','as-fed','ME')",
        [org],
      ),
    ),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    tenant(owner, (c) =>
      c.query(
        "INSERT INTO formula_versions(organization_id,name,batch_kg,lines,ingredient_snapshot,result,status) VALUES($1,'Unsafe',100,'[]','[]','{}','approved')",
        [org],
      ),
    ),
  ).rejects.toMatchObject({ code: "42501" });
});
it("makes formula versions, forecasts and daily records immutable to the runtime role", async () => {
  for (const table of ["formula_versions", "forecasts", "daily_records"])
    await expect(
      tenant(owner, (c) =>
        c.query(`DELETE FROM ${table} WHERE organization_id=$1`, [org]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
});

it("application login has no direct tenant-table or administrator privileges", async () => {
  const r = (
    await pool.query(
      "SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
    )
  ).rows[0];
  expect(r.name).toBe("farm_server");
  expect(r.rolsuper).toBe(false);
  expect(r.rolbypassrls).toBe(false);
  await expect(pool.query("SELECT * FROM farms")).rejects.toMatchObject({
    code: "42501",
  });
  await expect(pool.query("DELETE FROM users")).rejects.toMatchObject({
    code: "42501",
  });
});
