import { test, expect } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import pg from "pg";
config({ path: ".env.local", quiet: true });
test("plans a sourced broiler batch, previews honest forecasts, recovers one save and preserves versions under stale managers", async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  const secret = readFileSync(".local/postgres.env", "utf8").match(
      /POSTGRES_PASSWORD=(.+)/,
    )![1],
    db = new pg.Pool({
      connectionString: `postgresql://postgres:${secret}@127.0.0.1:54329/farmstead`,
    });
  const { createSession, cookieName } = await import("../../src/lib/auth");
  let owner = "",
    org = "";
  try {
    owner = (
      await db.query(
        "INSERT INTO users(email,password_hash) VALUES($1,'fixture-not-a-login') RETURNING id",
        ["planning-browser-" + randomUUID() + "@test.invalid"],
      )
    ).rows[0].id;
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE farm_app");
      await c.query("SELECT set_config('app.user_id',$1,true)", [owner]);
      org = (
        await c.query(
          "SELECT create_organization('Synthetic planning browser') AS id",
        )
      ).rows[0].id;
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    await context.addCookies([
      {
        name: cookieName,
        value: await createSession(owner),
        url: "http://localhost:3000",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const headers = { Origin: "http://localhost:3000" };
    const post = async (path: string, data: unknown) => {
      const r = await page.request.post("/api/" + path, { headers, data });
      expect(r.ok(), await r.text()).toBe(true);
      return r.json();
    };
    const farm = (
        await post("farms", {
          organizationId: org,
          name: "Synthetic planning farm",
          kind: "broilers",
          location: "Synthetic fixture",
        })
      ).id,
      unit = (
        await post("units", {
          organizationId: org,
          farmId: farm,
          name: "Synthetic planning batch",
          kind: "broilers",
          stockedOn: "2024-02-01",
          openingCount: 100,
          initialWeightG: 1000,
        })
      ).id;
    await post("records", {
      organizationId: org,
      unitId: unit,
      recordedOn: "2024-02-01",
      mortality: 0,
      eggs: 0,
      cracked: 0,
      feedKg: 1,
      averageWeightG: 1100,
      sampleSize: 10,
      waterQuality: null,
      notes: "Synthetic actual observation",
    });
    const path = `broilers/plans?organizationId=${org}&unitId=${unit}`,
      workspace = async () => (await page.request.get("/api/" + path)).json();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    await page.getByRole("button", { name: "Production", exact: true }).click();
    const region = page.getByRole("region", {
      name: "Broiler batch planning",
      exact: true,
    });
    for (const [label, value] of [
      ["Plan name", "=Synthetic sourced plan"],
      ["Poultry house · optional", "Synthetic house"],
      ["Breed / strain · optional", "Synthetic cited strain"],
      ["Hatch date · optional", "2024-01-25"],
      ["Age at placement (days)", "7"],
      ["Planned harvest age (days)", "10"],
      ["Chick price per bird · optional", "1.2345"],
      ["Market weight goal (g) · optional", "2500"],
      ["Planned live sale price · optional", "10"],
      ["Guide title", "Synthetic breeder guide"],
      [
        "Guide version / page / source reference",
        "Synthetic revision / tables A–B",
      ],
    ])
      await region.getByLabel(label, { exact: true }).fill(value);
    await region
      .getByRole("combobox", { name: "Planned live sale basis", exact: true })
      .selectOption("kg");
    await region
      .getByRole("combobox", { name: "Stage 1 type", exact: true })
      .selectOption("starter");
    for (const [key, value] of [
      ["startAge", "7"],
      ["endAge", "8"],
      ["rationG", "100"],
      ["mortalityDaily", "0.1"],
      ["pricePerKg", "2.5"],
      ["tempMinC", "28"],
      ["tempMaxC", "30"],
      ["evidence", "Synthetic guide feed table A"],
    ])
      await region.getByLabel("Stage 1 " + key, { exact: true }).fill(value);
    await region
      .getByRole("button", { name: "Add feed stage", exact: true })
      .click();
    await region
      .getByRole("combobox", { name: "Stage 2 type", exact: true })
      .selectOption("grower");
    for (const [key, value] of [
      ["startAge", "9"],
      ["endAge", "9"],
      ["rationG", "200"],
      ["mortalityDaily", "0"],
      ["pricePerKg", "3"],
      ["evidence", "Synthetic guide feed table B"],
    ])
      await region.getByLabel("Stage 2 " + key, { exact: true }).fill(value);
    for (const [key, value] of [
      ["ageDays", "9"],
      ["weightG", "2000"],
      ["evidence", "Synthetic guide growth table A"],
    ])
      await region.getByLabel("Target 1 " + key, { exact: true }).fill(value);
    await region
      .getByRole("button", { name: "Add growth point", exact: true })
      .click();
    for (const [key, value] of [
      ["ageDays", "10"],
      ["weightG", "2200"],
      ["evidence", "Synthetic guide growth table B"],
    ])
      await region.getByLabel("Target 2 " + key, { exact: true }).fill(value);
    await region.getByRole("checkbox").check();
    await region
      .getByRole("button", { name: "Preview broiler forecast", exact: true })
      .click();
    await expect(
      region.getByRole("heading", {
        name: "Unsaved planning preview",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      region.getByText("96.1000", { exact: true }).first(),
    ).toBeVisible();
    expect((await workspace()).history).toHaveLength(0);
    let lose = true;
    await page.route("**/api/broilers/plans", async (route) => {
      if (lose && route.request().method() === "POST") {
        lose = false;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await region
      .getByRole("button", { name: "Save broiler plan version", exact: true })
      .click();
    await expect(
      region.getByRole("button", {
        name: "Retry broiler plan receipt",
        exact: true,
      }),
    ).toBeVisible();
    page.on("dialog", (d) => void d.accept());
    await page.reload();
    await page.getByRole("button", { name: "Production", exact: true }).click();
    await region
      .getByRole("button", { name: "Retry broiler plan receipt", exact: true })
      .click();
    await expect(region.getByRole("status")).toContainText(
      "Broiler plan version saved",
    );
    await page.unroute("**/api/broilers/plans");
    let w = await workspace();
    expect(w.history).toHaveLength(1);
    const first = w.selected;
    expect(first.forecast).toMatchObject({
      feedKg: "35.200000",
      expectedClosingBirds: "81.00000000",
      feedCost: "96.1000",
    });
    const dl = page.waitForEvent("download");
    await region
      .getByRole("button", { name: "Download broiler plan JSON", exact: true })
      .click();
    const download = await dl;
    await download.saveAs(".local/browser-broiler-plan.json");
    const saved = JSON.parse(
      readFileSync(".local/browser-broiler-plan.json", "utf8"),
    );
    expect(
      createHash("sha256")
        .update(
          JSON.stringify({ source: saved.source, forecast: saved.forecast }),
        )
        .digest("hex"),
    ).toBe(saved.evidenceSha256);
    await region
      .getByRole("button", { name: "Prepare a new plan revision", exact: true })
      .click();
    await region.getByLabel("Stage 1 pricePerKg", { exact: true }).fill("4");
    await region.getByRole("checkbox").check();
    await region
      .getByRole("button", { name: "Save broiler plan version", exact: true })
      .click();
    await expect(region.getByRole("status")).toContainText(
      "Broiler plan version saved",
    );
    w = await workspace();
    expect(w.selected.forecast.feedCost).toBe("124.6000");
    expect(w.selected.source.previous_id).toBe(first.source.id);
    await region
      .getByRole("combobox", { name: "Saved planning version", exact: true })
      .selectOption(first.source.id);
    await expect(
      region.getByRole("heading", {
        name: "Saved planning forecast · revision 1",
        exact: true,
      }),
    ).toBeVisible();
    await region
      .getByRole("button", { name: "Prepare a new plan revision", exact: true })
      .click();
    await region
      .getByLabel("Plan name", { exact: true })
      .fill("Synthetic local unsaved edit");
    w = await workspace();
    await post("broilers/plans", {
      organizationId: org,
      unitId: unit,
      planId: randomUUID(),
      previousId: w.history[0].id,
      data: { ...first.source.input, name: "Synthetic second manager" },
    });
    await region.getByRole("checkbox").check();
    await region
      .getByRole("button", { name: "Save broiler plan version", exact: true })
      .click();
    await expect(region.getByRole("alert")).toContainText(
      "newer planning version",
    );
    await expect(region.getByLabel("Plan name", { exact: true })).toHaveValue(
      "Synthetic local unsaved edit",
    );
    await region
      .getByRole("button", {
        name: "Reload planning and observations",
        exact: true,
      })
      .click();
    await expect(
      region.getByRole("heading", {
        name: "Saved planning forecast · revision 3",
        exact: true,
      }),
    ).toBeVisible();
    const old = await page.request.get(
      "/api/" + path + "&planId=" + first.source.id + "&format=json",
    );
    expect((await old.json()).evidenceSha256).toBe(first.evidenceSha256);
    expect(
      (
        await db.query(
          "SELECT recorded_balance FROM production_population_balances WHERE id=$1",
          [unit],
        )
      ).rows[0].recorded_balance,
    ).toBe("100");
    expect(
      (
        await db.query("SELECT count(*) FROM daily_records WHERE unit_id=$1", [
          unit,
        ])
      ).rows[0].count,
    ).toBe("1");
    expect(
      (
        await db.query("SELECT count(*) FROM broiler_events WHERE unit_id=$1", [
          unit,
        ])
      ).rows[0].count,
    ).toBe("0");
    await page.setViewportSize({ width: 390, height: 844 });
    await region
      .getByRole("heading", { name: "Broiler batch planning", exact: true })
      .scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: ".local/broiler-planning-mobile.png",
      animations: "disabled",
      fullPage: false,
    });
    expect(errors).toEqual([]);
  } finally {
    if (org) await db.query("DELETE FROM organizations WHERE id=$1", [org]);
    if (owner) await db.query("DELETE FROM users WHERE id=$1", [owner]);
    await db.end();
  }
});
