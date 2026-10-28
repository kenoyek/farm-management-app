import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import pg from "pg";
config({ path: ".env.local", quiet: true });
test("reports weighted hen-days, preserves unknown dates and reconciles an explicit saved calendar baseline", async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
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
    // No extra login attempt: a private local session fixture preserves auth limits.
    owner = (
      await db.query(
        "INSERT INTO users(email,password_hash) VALUES($1,'fixture-not-a-login') RETURNING id",
        [`layer-browser-${randomUUID()}@test.invalid`],
      )
    ).rows[0].id;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE farm_app");
      await client.query("SELECT set_config('app.user_id',$1,true)", [owner]);
      org = (
        await client.query(
          "SELECT create_organization('Synthetic browser layer reports') AS id",
        )
      ).rows[0].id;
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
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
    async function post(path: string, data: unknown) {
      const r = await page.request.post("/api/" + path, { headers, data });
      expect(r.ok()).toBe(true);
      return r.json();
    }
    const farm = (
      await post("farms", {
        organizationId: org,
        name: "Synthetic report browser farm",
        kind: "layers",
        location: "Synthetic fixture",
      })
    ).id;
    const unit = (
      await post("units", {
        organizationId: org,
        farmId: farm,
        name: "Synthetic report flock",
        kind: "layers",
        stockedOn: "2024-02-01",
        openingCount: 100,
        initialWeightG: 1000,
      })
    ).id;
    async function record(
      date: string,
      mortality: number,
      eggs: number,
      cracked: number,
      feedKg: number,
    ) {
      return post("records", {
        organizationId: org,
        unitId: unit,
        recordedOn: date,
        mortality,
        eggs,
        cracked,
        feedKg,
        averageWeightG: null,
        sampleSize: null,
        waterQuality: null,
        notes: "Synthetic browser actual observation",
      });
    }
    await record("2024-02-01", 2, 80, 2, 1.125);
    await record("2024-02-02", 0, 0, 0, 0);
    await record("2024-02-03", 1, 90, 1, 1.4);
    const input = {
      organizationId: org,
      name: "Synthetic browser calendar baseline",
      kind: "layer-eggs",
      opening: 100,
      startMonth: "2024-02",
      traySize: 30,
      legacy28: false,
      periods: [{ lay: 0.8, mortality: 0.1, cracks: 0.05 }],
    };
    const forecast = (await post("forecasts/save", input)).id,
      legacy = (
        await post("forecasts/save", {
          ...input,
          name: "Synthetic browser 28-day baseline",
          legacy28: true,
        })
      ).id;
    await page.goto("/");
    await page.getByRole("button", { name: "Production", exact: true }).click();
    const panel = page.getByRole("region", {
      name: "Layer hen-day reporting",
      exact: true,
    });
    await panel
      .getByRole("combobox", {
        name: "Saved egg forecast baseline",
        exact: true,
      })
      .selectOption(forecast);
    await panel
      .getByRole("button", { name: "Generate layer report", exact: true })
      .click();
    const result = panel.getByRole("region", {
      name: "Layer report results",
      exact: true,
    });
    await expect(result).toContainText("Hen-days: 296");
    await expect(result).toContainText("Weighted hen-day: 57.432432%");
    await expect(result).toContainText("Gross egg variance: -70");
    await expect(
      result
        .getByRole("table", { name: "Daily layer hen-days" })
        .getByRole("row")
        .filter({ hasText: "2024-02-02" }),
    ).toContainText("0.000000");
    const json = page.waitForEvent("download");
    await result
      .getByRole("button", { name: "Download layer report JSON", exact: true })
      .click();
    const document = JSON.parse(
      readFileSync((await (await json).path())!, "utf8"),
    );
    expect(document.sourceSnapshot.records).toHaveLength(3);
    expect(document.sourceSnapshot.forecast.id).toBe(forecast);
    expect(document.henDays).toBe(296);
    const csv = page.waitForEvent("download");
    await result
      .getByRole("button", { name: "Download layer report CSV", exact: true })
      .click();
    expect(readFileSync((await (await csv).path())!, "utf8")).toContain(
      document.evidenceSha256,
    );
    await panel
      .getByRole("combobox", {
        name: "Saved egg forecast baseline",
        exact: true,
      })
      .selectOption(legacy);
    await expect(result).not.toBeVisible();
    await panel
      .getByRole("button", { name: "Generate layer report", exact: true })
      .click();
    await expect(result).toContainText("legacy 28-day model");
    await expect(result).toContainText("Gross egg variance: Unknown");
    await panel
      .getByRole("combobox", {
        name: "Saved egg forecast baseline",
        exact: true,
      })
      .selectOption(forecast);
    await panel
      .getByLabel("Layer report from", { exact: true })
      .fill("2024-02-02");
    await panel
      .getByLabel("Layer report through", { exact: true })
      .fill("2024-02-04");
    await panel
      .getByRole("button", { name: "Generate layer report", exact: true })
      .click();
    await expect(result).toContainText("Recorded days: 2 / 3");
    await expect(result).toContainText("Complete-window gross eggs: Unknown");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.reload();
    await page.getByRole("button", { name: "Production", exact: true }).click();
    await expect(
      page.getByRole("region", {
        name: "Layer hen-day reporting",
        exact: true,
      }),
    ).toBeVisible();
    expect(
      (
        await db.query("SELECT count(*) FROM daily_records WHERE unit_id=$1", [
          unit,
        ])
      ).rows[0].count,
    ).toBe("3");
    expect(
      (
        await db.query(
          "SELECT count(*) FROM forecasts WHERE organization_id=$1",
          [org],
        )
      ).rows[0].count,
    ).toBe("2");
  } finally {
    if (org) await db.query("DELETE FROM organizations WHERE id=$1", [org]);
    if (owner) await db.query("DELETE FROM users WHERE id=$1", [owner]);
    await db.end();
    // The runtime pool is shared by browser fixtures and permits exit on idle.
  }
});
