import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import pg from "pg";
config({ path: ".env.local", quiet: true });
test("reviews broiler treatment, withdrawal, cull and weighed partial harvest with receipt recovery and cohort FCR", async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  const secret = readFileSync(".local/postgres.env", "utf8").match(
    /POSTGRES_PASSWORD=(.+)/,
  )![1];
  const db = new pg.Pool({
    connectionString: `postgresql://postgres:${secret}@127.0.0.1:54329/farmstead`,
  });
  const { createSession, cookieName } = await import("../../src/lib/auth");
  let owner = "",
    org = "";
  try {
    owner = (
      await db.query(
        "INSERT INTO users(email,password_hash) VALUES($1,'fixture-not-a-login') RETURNING id",
        ["broiler-browser-" + randomUUID() + "@test.invalid"],
      )
    ).rows[0].id;
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE farm_app");
      await c.query("SELECT set_config('app.user_id',$1,true)", [owner]);
      org = (
        await c.query(
          "SELECT create_organization('Synthetic broiler browser') AS id",
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
        name: "Synthetic broiler farm",
        kind: "broilers",
        location: "Synthetic fixture",
      })
    ).id;
    const unit = (
      await post("units", {
        organizationId: org,
        farmId: farm,
        name: "Synthetic lifecycle batch",
        kind: "broilers",
        stockedOn: "2024-02-01",
        openingCount: 100,
        initialWeightG: 1000,
      })
    ).id;
    const record = async (date: string, weight: number) =>
      post("records", {
        organizationId: org,
        unitId: unit,
        recordedOn: date,
        mortality: 0,
        eggs: 0,
        cracked: 0,
        feedKg: 10,
        averageWeightG: weight,
        sampleSize: 10,
        waterQuality: null,
        notes: "Synthetic daily source",
      });
    await record("2024-02-01", 2000);
    const snapshot = async () =>
      (
        await page.request.get(
          `/api/broilers/lifecycle?organizationId=${org}&unitId=${unit}`,
        )
      ).json();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    await page.getByRole("button", { name: "Production", exact: true }).click();
    const region = page.getByRole("region", {
      name: "Broiler lifecycle",
      exact: true,
    });
    await expect(
      region.getByRole("heading", { name: "Cohort feed efficiency" }),
    ).toBeVisible();
    const select = region.getByRole("combobox", {
      name: "Lifecycle activity",
      exact: true,
    });
    const review = async () => {
      await region
        .getByLabel("Description", { exact: true })
        .fill("Synthetic observed activity");
      await region
        .getByLabel("Review reason", { exact: true })
        .fill("Synthetic checked source record");
      await region
        .getByLabel("Evidence / veterinary reference", { exact: true })
        .fill("Synthetic dated veterinary / weighbridge register");
      await region
        .getByRole("group", { name: "Review lifecycle activity", exact: true })
        .getByRole("checkbox")
        .check();
      await region
        .getByRole("button", {
          name: "Save broiler lifecycle record",
          exact: true,
        })
        .click();
    };
    const saved = async () => {
      await expect(region.getByRole("status")).toContainText(
        "Broiler lifecycle record saved",
      );
    };
    await select.selectOption("treatment");
    await region
      .getByLabel("Observed / treated birds", { exact: true })
      .fill("100");
    await region
      .getByLabel("Product name", { exact: true })
      .fill("Synthetic product");
    await region
      .getByLabel("Actual administration and route", { exact: true })
      .fill("Synthetic administered product; no dosage advice");
    await region
      .getByLabel("Earliest harvest date · leave blank if unknown", {
        exact: true,
      })
      .fill("2024-02-02");
    await review();
    await saved();
    // Historical harvest date is checked even though today's hold list has expired.
    await select.selectOption("harvest");
    await region.getByLabel("Birds removed", { exact: true }).fill("10");
    await region
      .getByLabel("Measured total live weight (kg)", { exact: true })
      .fill("20");
    await review();
    await expect(region.getByRole("alert")).toContainText("withdrawal date");
    await region
      .getByRole("button", { name: "Reload lifecycle records", exact: true })
      .click();
    // Record day two first, then the inspected cull and partial live harvest.
    await record("2024-02-02", 2200);
    await region
      .getByRole("button", { name: "Reload lifecycle records", exact: true })
      .click();
    await expect(
      region.getByLabel("Lifecycle date", { exact: true }),
    ).toHaveValue("2024-02-02");
    await select.selectOption("cull");
    await region.getByLabel("Birds removed", { exact: true }).fill("2");
    await region
      .getByLabel("Measured total live weight (kg) · optional", { exact: true })
      .fill("4");
    await review();
    await saved();
    await select.selectOption("harvest");
    await region.getByLabel("Birds removed", { exact: true }).fill("10");
    await region
      .getByLabel("Measured total live weight (kg)", { exact: true })
      .fill("22.123456");
    await region
      .getByRole("combobox", { name: "Harvest price basis", exact: true })
      .selectOption("kg");
    await region.getByLabel("Price per unit", { exact: true }).fill("100.1234");
    await region
      .getByLabel("Customer", { exact: true })
      .fill("Synthetic buyer");
    await region
      .getByLabel("Unique harvest reference", { exact: true })
      .fill("SYNTHETIC-BROWSER-HARVEST");
    let lose = true;
    await page.route("**/api/broilers/lifecycle", async (route) => {
      if (
        lose &&
        route.request().method() === "POST" &&
        JSON.parse(route.request().postData() ?? "{}").kind === "harvest"
      ) {
        lose = false;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await review();
    await expect(
      region.getByRole("button", {
        name: "Retry broiler receipt",
        exact: true,
      }),
    ).toBeVisible();
    page.on("dialog", (d) => void d.accept());
    await page.reload();
    await page.getByRole("button", { name: "Production", exact: true }).click();
    await region
      .getByRole("button", { name: "Retry broiler receipt", exact: true })
      .click();
    await saved();
    await page.unroute("**/api/broilers/lifecycle");
    let h = await snapshot();
    expect(h.events).toHaveLength(3);
    expect(h.summary).toMatchObject({
      balance: 88,
      culled: 2,
      harvested: 10,
      sales: { NGN: "2215.0756" },
      fcr: null,
    });
    const harvest = h.events.find(
      (e: { kind: string }) => e.kind === "harvest",
    );
    // Correct an erroneous entry immediately, preserving its original evidence.
    await select.selectOption("void");
    await region
      .getByRole("combobox", { name: "Original erroneous event", exact: true })
      .selectOption(harvest.id);
    await review();
    await saved();
    expect((await snapshot()).summary.balance).toBe(98);
    await select.selectOption("harvest");
    await region.getByLabel("Birds removed", { exact: true }).fill("10");
    await region
      .getByLabel("Measured total live weight (kg)", { exact: true })
      .fill("22");
    await region
      .getByRole("combobox", { name: "Harvest price basis", exact: true })
      .selectOption("bird");
    await region
      .getByLabel("Price per unit", { exact: true })
      .fill("2500.1234");
    await region
      .getByLabel("Customer", { exact: true })
      .fill("Synthetic corrected buyer");
    await region
      .getByLabel("Unique harvest reference", { exact: true })
      .fill("SYNTHETIC-BROWSER-CORRECTED");
    await review();
    await saved();
    // A separate browser tab changes the loaded review state.
    const stale = await snapshot();
    await post("broilers/lifecycle", {
      organizationId: org,
      unitId: unit,
      eventId: randomUUID(),
      kind: "health",
      date: "2024-02-02",
      expectedPosition: stale.summary.expectedPosition,
      expectedDailyId: stale.summary.expectedDailyId,
      quantity: 1,
      description: "Synthetic concurrent observation",
      reason: "Synthetic concurrent review",
      evidence: "Synthetic second register",
    });
    await select.selectOption("health");
    await region
      .getByLabel("Observed / treated birds", { exact: true })
      .fill("1");
    await review();
    await expect(region.getByRole("alert")).toContainText(
      "changed after you loaded",
    );
    await record("2024-02-03", 2500);
    await region
      .getByRole("button", { name: "Reload lifecycle records", exact: true })
      .click();
    await expect(
      region.getByText(
        "Recorded cohort FCR: 0.205479 kg feed/kg biomass gain.",
        { exact: true },
      ),
    ).toBeVisible();
    h = await snapshot();
    expect(h.summary).toMatchObject({
      balance: 88,
      cohortGainKg: "146.000000",
      sales: { NGN: "25001.2340" },
      fcr: "0.205479",
    });
    expect(h.events).toHaveLength(6);
    const download = page.waitForEvent("download");
    await region
      .getByRole("button", { name: "Download broiler CSV", exact: true })
      .click();
    expect((await download).suggestedFilename()).toBe("broiler-lifecycle.csv");
    const json = await page.request.get(
      `/api/broilers/lifecycle?organizationId=${org}&unitId=${unit}&format=json`,
    );
    expect((await json.json()).evidenceSha256).toBe(h.evidenceSha256);
    await page.setViewportSize({ width: 390, height: 844 });
    await region.scrollIntoViewIfNeeded();
    await expect(
      region.getByRole("heading", { name: "Broiler lifecycle", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: ".local/broiler-mobile.png",
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    if (org) await db.query("DELETE FROM organizations WHERE id=$1", [org]);
    if (owner) await db.query("DELETE FROM users WHERE id=$1", [owner]);
    await db.end();
  }
});
