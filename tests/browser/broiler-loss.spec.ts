import { test, expect } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import pg from "pg";
config({ path: ".env.local", quiet: true });
test("reviews measured broiler loss biomass, recovers a receipt and keeps stale-source FCR and auditor access honest", async ({
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
    org = "",
    auditor = "";
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
      mortality: 2,
      eggs: 0,
      cracked: 0,
      feedKg: 10,
      averageWeightG: 2000,
      sampleSize: 10,
      waterQuality: null,
      notes: "Synthetic actual observation",
    });
    const path = `broilers/lifecycle?organizationId=${org}&unitId=${unit}`,
      snapshot = async () => (await page.request.get("/api/" + path)).json();
    const event = async (values: Record<string, unknown>) => {
      const h = await snapshot();
      return post("broilers/lifecycle", {
        organizationId: org,
        unitId: unit,
        eventId: randomUUID(),
        date: h.summary.asOf,
        kind: "health",
        description: "Synthetic loss source event",
        reason: "Synthetic reviewed actual source",
        evidence: "Synthetic source register",
        expectedPosition: h.summary.expectedPosition,
        expectedDailyId: h.summary.expectedDailyId,
        ...values,
      });
    };
    await event({ kind: "cull", quantity: 3, weightKg: null });
    await event({
      kind: "harvest",
      quantity: 10,
      weightKg: "20",
      priceBasis: "kg",
      pricePerUnit: "3",
      reference: "SYNTHETIC-LOSS-BROWSER",
      customer: "Synthetic buyer",
    });
    await post("records", {
      organizationId: org,
      unitId: unit,
      recordedOn: "2024-02-02",
      mortality: 1,
      eggs: 0,
      cracked: 0,
      feedKg: 20,
      averageWeightG: 2500,
      sampleSize: 10,
      waterQuality: null,
      notes: "Synthetic subsequent observation",
    });
    const original = await snapshot(),
      errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => void d.accept());
    await page.goto("/");
    await page.getByRole("button", { name: "Production", exact: true }).click();
    const region = page.getByRole("region", {
        name: "Measured broiler loss biomass",
        exact: true,
      }),
      lifecycle = page.getByRole("region", {
        name: "Broiler lifecycle",
        exact: true,
      });
    const fill = async (key: string, weight: string | null) => {
      await region
        .getByRole("combobox", { name: "Loss to review", exact: true })
        .selectOption(key);
      if (weight === null)
        await region
          .getByLabel("Weight is explicitly unknown", { exact: false })
          .check();
      else
        await region
          .getByLabel("Measured whole-bird loss kg", { exact: true })
          .fill(weight);
      await region
        .getByRole("textbox", {
          name: "Loss weight review reason",
          exact: true,
        })
        .fill("Synthetic recovered original whole-bird mass");
      await region
        .getByRole("textbox", {
          name: "Measurement record and source evidence",
          exact: true,
        })
        .fill("Synthetic dated scale register; measured whole birds at loss");
      await region
        .getByLabel("I reviewed this exact loss count", { exact: false })
        .check();
    };
    const save = async () => {
      const response = page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/broilers/loss-biomass") &&
          r.request().method() === "POST",
      );
      await region
        .getByRole("button", { name: "Save loss biomass review", exact: true })
        .click();
      expect((await response).ok()).toBe(true);
      await expect(
        region.getByRole("combobox", { name: "Loss to review", exact: true }),
      ).toHaveValue("");
    };
    await fill("daily:2024-02-01", "2.4");
    let lose = true;
    await page.route("**/api/broilers/loss-biomass", async (route) => {
      if (lose && route.request().method() === "POST") {
        lose = false;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await region
      .getByRole("button", { name: "Save loss biomass review", exact: true })
      .click();
    await expect(
      region.getByRole("button", {
        name: "Retry loss biomass receipt",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      lifecycle.getByRole("button", {
        name: "Save broiler lifecycle record",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      lifecycle.getByRole("button", {
        name: "Save broiler recovery review",
        exact: true,
      }),
    ).toBeDisabled();
    await page.reload();
    await page.getByRole("button", { name: "Production", exact: true }).click();
    await region
      .getByRole("button", { name: "Retry loss biomass receipt", exact: true })
      .click();
    await expect(region.getByRole("status")).toContainText(
      "Loss biomass review saved",
    );
    await page.unroute("**/api/broilers/loss-biomass");
    expect((await snapshot()).lossReviews).toHaveLength(1);
    expect(
      (
        await db.query(
          "SELECT count(*) FROM audit_logs WHERE organization_id=$1 AND action='broiler.loss_biomass_review'",
          [org],
        )
      ).rows[0].count,
    ).toBe("1");
    await fill("daily:2024-02-02", "1.5");
    await save();
    const cull = original.events.find(
      (e: { kind: string }) => e.kind === "cull",
    );
    await fill("cull:" + cull.id, "4.5");
    await save();
    await expect(
      lifecycle.getByText(
        "Recorded cohort FCR: 0.216763 kg feed/kg biomass gain.",
        { exact: true },
      ),
    ).toBeVisible();
    await fill("daily:2024-02-01", "2.4");
    await region
      .getByRole("textbox", { name: "Loss weight review reason", exact: true })
      .fill("Synthetic retained local measurement edit");
    const before = await snapshot();
    await post("broilers/recovery", {
      organizationId: org,
      unitId: unit,
      eventId: randomUUID(),
      kind: "daily",
      date: "2024-02-01",
      previousId: null,
      baseRecordId: before.originalRecords[0].id,
      mortality: 2,
      feedKg: "11",
      averageWeightG: "2000",
      sampleSize: 10,
      notes: "Synthetic daily replacement",
      reason: "Synthetic corrected daily source",
      evidence: "Synthetic revised register",
      expectedPosition: before.summary.expectedPosition,
      expectedDailyId: before.summary.expectedDailyId,
    });
    await region
      .getByRole("button", { name: "Save loss biomass review", exact: true })
      .click();
    await expect(region.getByRole("alert")).toContainText("batch changed");
    await expect(
      region.getByRole("textbox", {
        name: "Loss weight review reason",
        exact: true,
      }),
    ).toHaveValue("Synthetic retained local measurement edit");
    let download = page.waitForEvent("download");
    await region
      .getByRole("button", {
        name: "Download loss weight working copy",
        exact: true,
      })
      .click();
    await (await download).saveAs(".local/browser-broiler-loss-working.json");
    expect(
      JSON.parse(
        readFileSync(".local/browser-broiler-loss-working.json", "utf8"),
      ).reason,
    ).toBe("Synthetic retained local measurement edit");
    expect((await snapshot()).summary.fcr).toBeNull();
    await region
      .getByRole("button", { name: "Load selected loss evidence", exact: true })
      .click();
    await expect(region.getByRole("status")).toContainText("Evidence reloaded");
    await expect(
      region.getByLabel("I reviewed this exact loss count", { exact: false }),
    ).not.toBeChecked();
    await expect(
      region.getByLabel("Measured whole-bird loss kg", { exact: true }),
    ).toHaveValue("2.4");
    await region
      .getByLabel("I reviewed this exact loss count", { exact: false })
      .check();
    await save();
    await expect(
      lifecycle.getByText(
        "Recorded cohort FCR: 0.223988 kg feed/kg biomass gain.",
        { exact: true },
      ),
    ).toBeVisible();
    await fill("cull:" + cull.id, null);
    await save();
    expect((await snapshot()).summary.fcr).toBeNull();
    await fill("cull:" + cull.id, "4.5");
    await save();
    download = page.waitForEvent("download");
    await lifecycle
      .getByRole("button", { name: "Download broiler JSON", exact: true })
      .click();
    await (await download).saveAs(".local/browser-broiler-loss.json");
    const report = JSON.parse(
      readFileSync(".local/browser-broiler-loss.json", "utf8"),
    );
    expect(
      createHash("sha256")
        .update(
          JSON.stringify({
            modelVersion: report.modelVersion,
            originalRecords: report.originalRecords,
            reviews: report.reviews,
            lossReviews: report.lossReviews,
            unit: report.unit,
            records: report.records,
            events: report.events,
            timezone: report.timezone,
          }),
        )
        .digest("hex"),
    ).toBe(report.evidenceSha256);
    expect(report.events).toEqual(original.events);
    expect(report.originalRecords).toEqual(original.originalRecords);
    expect(report.summary).toMatchObject({
      balance: 84,
      feedKg: "31.000000",
      measuredDeathKg: "3.900000",
      cohortGainKg: "138.400000",
      fcr: "0.223988",
    });
    download = page.waitForEvent("download");
    await lifecycle
      .getByRole("button", { name: "Download broiler CSV", exact: true })
      .click();
    await (await download).saveAs(".local/browser-broiler-loss.csv");
    expect(readFileSync(".local/browser-broiler-loss.csv", "utf8")).toContain(
      '"Complete original loss source"',
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await region
      .getByRole("heading", {
        name: "Measured broiler loss biomass",
        exact: true,
      })
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: ".local/broiler-loss-mobile.png",
      animations: "disabled",
      fullPage: false,
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    auditor = (
      await db.query(
        "INSERT INTO users(email,password_hash) VALUES($1,'fixture-not-a-login') RETURNING id",
        [randomUUID() + "@test.invalid"],
      )
    ).rows[0].id;
    await db.query("INSERT INTO memberships VALUES($1,$2,'auditor')", [
      org,
      auditor,
    ]);
    await context.addCookies([
      {
        name: cookieName,
        value: await createSession(auditor),
        url: "http://localhost:3000",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await page.goto("/");
    await page.getByRole("button", { name: "Production", exact: true }).click();
    await expect(
      region.getByRole("heading", {
        name: "Immutable loss-weight review history",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      region.getByRole("button", {
        name: "Save loss biomass review",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      lifecycle.getByRole("button", {
        name: "Download broiler JSON",
        exact: true,
      }),
    ).toBeEnabled();
    expect(errors).toEqual([]);
  } finally {
    if (org) await db.query("DELETE FROM organizations WHERE id=$1", [org]);
    for (const id of [owner, auditor])
      if (id) await db.query("DELETE FROM users WHERE id=$1", [id]);
    await db.end();
  }
});
