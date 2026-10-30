import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import pg from "pg";
config({ path: ".env.local", quiet: true });
test("recovers a genuine broiler treatment and full daily evidence without duplicating stock or historical administration", async ({
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
        ["recovery-browser-" + randomUUID() + "@test.invalid"],
      )
    ).rows[0].id;
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE farm_app");
      await c.query("SELECT set_config('app.user_id',$1,true)", [owner]);
      org = (
        await c.query(
          "SELECT create_organization('Synthetic broiler recovery browser') AS id",
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
        name: "Synthetic recovery farm",
        kind: "broilers",
        location: "Synthetic fixture",
      })
    ).id;
    const unit = (
      await post("units", {
        organizationId: org,
        farmId: farm,
        name: "Synthetic recovery batch",
        kind: "broilers",
        stockedOn: "2024-02-01",
        openingCount: 100,
        initialWeightG: 1000,
      })
    ).id;
    const daily = async (date: string, mortality: number, weight: number) =>
      post("records", {
        organizationId: org,
        unitId: unit,
        recordedOn: date,
        mortality,
        eggs: 0,
        cracked: 0,
        feedKg: 10,
        averageWeightG: weight,
        sampleSize: 10,
        waterQuality: null,
        notes: "Synthetic immutable daily source",
      });
    const snap = async () =>
      (
        await page.request.get(
          `/api/broilers/lifecycle?organizationId=${org}&unitId=${unit}`,
        )
      ).json();
    await daily("2024-02-01", 1, 2000);
    let h = await snap();
    const treatment = (
      await post("broilers/lifecycle", {
        organizationId: org,
        unitId: unit,
        eventId: randomUUID(),
        kind: "treatment",
        date: "2024-02-01",
        expectedPosition: h.summary.expectedPosition,
        expectedDailyId: h.summary.expectedDailyId,
        quantity: 99,
        product: "Synthetic actual administration",
        administration: "Synthetic administered product and route",
        earliestHarvestOn: null,
        description: "Synthetic genuine original treatment",
        reason: "Synthetic actual administration recorded",
        evidence: "Synthetic dated original product register",
      })
    ).id;
    await daily("2024-02-03", 2, 2500);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    await page.getByRole("button", { name: "Production", exact: true }).click();
    const parent = page.getByRole("region", {
        name: "Broiler lifecycle",
        exact: true,
      }),
      recovery = page.getByRole("region", {
        name: "Broiler record recovery",
        exact: true,
      });
    const review = async () => {
      await recovery
        .getByLabel("Recovery review reason", { exact: true })
        .fill("Synthetic original evidence reviewed");
      await recovery
        .getByLabel("Recovery source / veterinary evidence", { exact: true })
        .fill("Synthetic dated veterinary / actual daily register");
      await recovery.getByRole("checkbox").check();
      await recovery
        .getByRole("button", {
          name: "Save broiler recovery review",
          exact: true,
        })
        .click();
    };
    const saved = async () => {
      await expect(recovery.getByRole("status")).toContainText(
        "Broiler recovery review saved",
      );
    };
    const reload = async () => {
      await parent
        .getByRole("button", { name: "Reload lifecycle records", exact: true })
        .click();
      await expect(
        parent.getByRole("button", {
          name: "Save broiler lifecycle record",
          exact: true,
        }),
      ).toBeEnabled();
    };
    await recovery
      .getByRole("combobox", {
        name: "Original administered treatment",
        exact: true,
      })
      .selectOption(treatment);
    await recovery
      .getByLabel("Reviewed earliest harvest date · blank means unknown", {
        exact: true,
      })
      .fill("2024-02-03");
    let lose = true;
    await page.route("**/api/broilers/recovery", async (route) => {
      if (lose && route.request().method() === "POST") {
        lose = false;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await review();
    await expect(
      recovery.getByRole("button", {
        name: "Retry broiler recovery receipt",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      parent.getByRole("button", {
        name: "Save broiler lifecycle record",
        exact: true,
      }),
    ).toBeDisabled();
    page.on("dialog", (d) => void d.accept());
    await page.reload();
    await page.getByRole("button", { name: "Production", exact: true }).click();
    await recovery
      .getByRole("button", {
        name: "Retry broiler recovery receipt",
        exact: true,
      })
      .click();
    await saved();
    await page.unroute("**/api/broilers/recovery");
    h = await snap();
    expect(h.reviews).toHaveLength(1);
    expect(h.events).toHaveLength(1);
    expect(h.events[0].earliest_harvest_on).toBeNull();
    expect(h.summary.treatments[0].earliest_harvest_on).toBe("2024-02-03");
    const lifecycle = parent.getByRole("group", {
      name: "Review lifecycle activity",
      exact: true,
    });
    await lifecycle
      .getByRole("combobox", { name: "Lifecycle activity", exact: true })
      .selectOption("harvest");
    await lifecycle.getByLabel("Birds removed", { exact: true }).fill("10");
    await lifecycle
      .getByLabel("Measured total live weight (kg)", { exact: true })
      .fill("25");
    await lifecycle
      .getByRole("combobox", { name: "Harvest price basis", exact: true })
      .selectOption("kg");
    await lifecycle
      .getByLabel("Price per unit", { exact: true })
      .fill("100.1234");
    await lifecycle
      .getByLabel("Customer", { exact: true })
      .fill("Synthetic recovery customer");
    await lifecycle
      .getByLabel("Unique harvest reference", { exact: true })
      .fill("SYNTHETIC-RECOVERY-BROWSER");
    await lifecycle
      .getByLabel("Description", { exact: true })
      .fill("Synthetic actual live harvest");
    await lifecycle
      .getByLabel("Review reason", { exact: true })
      .fill("Synthetic completed harvest reviewed");
    await lifecycle
      .getByLabel("Evidence / veterinary reference", { exact: true })
      .fill("Synthetic live weighbridge register");
    await lifecycle.getByRole("checkbox").check();
    await lifecycle
      .getByRole("button", {
        name: "Save broiler lifecycle record",
        exact: true,
      })
      .click();
    await expect(
      parent
        .getByRole("status")
        .filter({ hasText: "Broiler lifecycle record saved" }),
    ).toBeVisible();
    await recovery
      .getByRole("combobox", { name: "Recovery type", exact: true })
      .selectOption("daily");
    await recovery
      .getByLabel("Recovery observation date", { exact: true })
      .fill("2024-02-02");
    await recovery
      .getByLabel("Reviewed daily deaths", { exact: true })
      .fill("0");
    await recovery
      .getByLabel("Reviewed daily feed (kg)", { exact: true })
      .fill("5");
    await recovery
      .getByLabel("Reviewed daily notes", { exact: true })
      .fill("Synthetic observed zero-death missing day");
    await review();
    await saved();
    h = await snap();
    expect(h.originalRecords).toHaveLength(2);
    expect(h.records).toHaveLength(3);
    expect(h.summary.balance).toBe(87);
    for (const [date, feed] of [
      ["2024-02-01", "11"],
      ["2024-02-03", "20"],
    ]) {
      await recovery
        .getByLabel("Recovery observation date", { exact: true })
        .fill(date);
      await recovery
        .getByLabel("Reviewed daily deaths", { exact: true })
        .fill("0");
      await recovery
        .getByLabel("Reviewed daily feed (kg)", { exact: true })
        .fill(feed);
      await review();
      await saved();
    }
    await daily("2024-02-04", 0, 2800);
    await reload();
    await expect(
      parent.getByText(
        "Recorded cohort FCR: 0.259887 kg feed/kg biomass gain.",
        { exact: true },
      ),
    ).toBeVisible();
    h = await snap();
    expect(h.summary).toMatchObject({
      balance: 90,
      mortality: 0,
      feedKg: "46.000000",
      fcr: "0.259887",
    });
    expect(
      h.originalRecords
        .slice(0, 2)
        .map((r: { mortality: number }) => r.mortality),
    ).toEqual([1, 2]);
    const count = h.reviews.length;
    await recovery
      .getByLabel("Recovery observation date", { exact: true })
      .fill("2024-02-01");
    await recovery
      .getByLabel("Reviewed daily deaths", { exact: true })
      .fill("95");
    await recovery
      .getByLabel("Reviewed average sample weight (g) · optional", {
        exact: true,
      })
      .fill("");
    await recovery
      .getByLabel("Reviewed sample size · optional", { exact: true })
      .fill("");
    await review();
    await expect(recovery.getByRole("alert")).toContainText("data constraint");
    expect((await snap()).reviews).toHaveLength(count);
    // A second review invalidates the first tab's exact batch state.
    await recovery
      .getByLabel("Recovery observation date", { exact: true })
      .fill("2024-02-02");
    await recovery
      .getByLabel("Reviewed daily feed (kg)", { exact: true })
      .fill("7");
    h = await snap();
    const old = h.reviews.find(
      (r: { kind: string; observed_on: string }) =>
        r.kind === "daily" && r.observed_on === "2024-02-02",
    );
    await post("broilers/recovery", {
      organizationId: org,
      unitId: unit,
      eventId: randomUUID(),
      kind: "daily",
      date: "2024-02-02",
      previousId: old.id,
      baseRecordId: null,
      expectedPosition: h.summary.expectedPosition,
      expectedDailyId: h.summary.expectedDailyId,
      mortality: 0,
      feedKg: "6",
      averageWeightG: null,
      sampleSize: null,
      notes: "Synthetic second manager observation",
      reason: "Synthetic second manager reviewed source",
      evidence: "Synthetic second register",
    });
    await review();
    await expect(recovery.getByRole("alert")).toContainText(
      "changed after you loaded",
    );
    await reload();
    await recovery
      .getByRole("combobox", { name: "Recovery type", exact: true })
      .selectOption("withdrawal");
    await recovery
      .getByRole("combobox", {
        name: "Original administered treatment",
        exact: true,
      })
      .selectOption(treatment);
    await recovery
      .getByLabel("Reviewed earliest harvest date · blank means unknown", {
        exact: true,
      })
      .fill("");
    await review();
    await saved();
    await expect(
      parent
        .getByRole("alert")
        .filter({ hasText: "conflicts with 1 earlier recorded harvest" }),
    ).toBeVisible();
    h = await snap();
    expect(h.summary.harvestGuidance[0].recordedHolds).toEqual([]);
    expect(h.summary.harvestGuidance[0].currentConcerns).toHaveLength(1);
    await recovery
      .getByLabel("Reviewed earliest harvest date · blank means unknown", {
        exact: true,
      })
      .fill("2024-02-03");
    await review();
    await saved();
    expect((await snap()).summary.harvestGuidance[0].currentConcerns).toEqual(
      [],
    );
    const download = page.waitForEvent("download");
    await parent
      .getByRole("button", { name: "Download broiler CSV", exact: true })
      .click();
    expect((await download).suggestedFilename()).toBe("broiler-lifecycle.csv");
    h = await snap();
    expect(h.modelVersion).toBe("broiler-reviewed-loss-biomass-v3");
    expect(
      h.events.filter((e: { kind: string }) => e.kind === "treatment"),
    ).toHaveLength(1);
    expect(
      h.events.filter((e: { kind: string }) => e.kind === "void"),
    ).toHaveLength(0);
    expect(h.reviews).toHaveLength(7);
    await page.setViewportSize({ width: 390, height: 844 });
    await recovery
      .getByRole("heading", { name: "Broiler record recovery", exact: true })
      .scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: ".local/broiler-recovery-mobile.png",
      fullPage: false,
    });
    expect(errors).toEqual([]);
  } finally {
    if (org) await db.query("DELETE FROM organizations WHERE id=$1", [org]);
    if (owner) await db.query("DELETE FROM users WHERE id=$1", [owner]);
    await db.end();
  }
});
