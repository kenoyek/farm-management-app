import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import pg from "pg";
config({ path: ".env.local", quiet: true });
test("reviews layer corrections and missing dates, recovers a census and safely retries a lost response", async ({
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
    await record("2024-02-01", 2, 80, 2, 1);
    await record("2024-02-03", 1, 80, 1, 1);
    await record("2024-02-04", 1, 80, 1, 1);
    await page.goto("/");
    await page.getByRole("button", { name: "Production", exact: true }).click();
    const recovery = page.getByRole("region", {
      name: "Layer record recovery",
      exact: true,
    });
    await expect(
      recovery.getByLabel("Recovery observation date", { exact: true }),
    ).toHaveValue("2024-02-04");
    async function daily(
      date: string,
      mortality: string,
      eggs: string,
      cracked: string,
      feed: string,
    ) {
      await recovery
        .getByRole("combobox", { name: "Recovery type", exact: true })
        .selectOption("daily");
      await recovery
        .getByLabel("Recovery observation date", { exact: true })
        .fill(date);
      await recovery
        .getByLabel("Reviewed mortality", { exact: true })
        .fill(mortality);
      await recovery
        .getByLabel("Reviewed gross eggs", { exact: true })
        .fill(eggs);
      await recovery
        .getByLabel("Reviewed cracked eggs", { exact: true })
        .fill(cracked);
      await recovery
        .getByLabel("Reviewed feed consumed (kg)", { exact: true })
        .fill(feed);
    }
    async function evidence() {
      await recovery
        .getByLabel("Review reason", { exact: true })
        .fill("Synthetic dated source checked by reviewer");
      await recovery
        .getByLabel("Observation evidence or reference", { exact: true })
        .fill("Synthetic dated collection and count sheets");
      await recovery.getByRole("checkbox").check();
      await recovery
        .getByRole("button", { name: "Save reviewed entry", exact: true })
        .click();
    }
    await daily("2024-02-01", "5", "70", "2", "1.123456");
    await evidence();
    await expect(recovery.getByRole("status")).toContainText(
      "Reviewed entry saved",
    );
    await recovery
      .getByText("Original daily observations (3)", { exact: true })
      .click();
    await expect(
      recovery
        .getByRole("table", { name: "Original layer observations" })
        .getByRole("row")
        .filter({ hasText: "2024-02-01" }),
    ).toContainText("80 / 2");
    await recovery
      .getByLabel("Recovery observation date", { exact: true })
      .fill("2024-02-02");
    await expect(
      recovery.getByLabel("Reviewed mortality", { exact: true }),
    ).toHaveValue("");
    await daily("2024-02-02", "0", "0", "0", "0");
    await evidence();
    await expect(recovery.getByRole("status")).toContainText(
      "Reviewed entry saved",
    );
    await recovery
      .getByRole("combobox", { name: "Recovery type", exact: true })
      .selectOption("census");
    await recovery
      .getByLabel("Recovery observation date", { exact: true })
      .fill("2024-02-03");
    await recovery
      .getByLabel("Counted opening hens", { exact: true })
      .fill("90");
    await evidence();
    await expect(recovery.getByRole("status")).toContainText(
      "Reviewed entry saved",
    );
    const panel = page.getByRole("region", {
      name: "Layer hen-day reporting",
      exact: true,
    });
    await panel
      .getByRole("button", { name: "Generate layer report", exact: true })
      .click();
    const result = panel.getByRole("region", {
      name: "Layer report results",
      exact: true,
    });
    await expect(result).toContainText("Hen-days: 374");
    await expect(result).toContainText("Complete-window gross eggs: 230");
    const download = page.waitForEvent("download");
    await result
      .getByRole("button", { name: "Download layer report JSON", exact: true })
      .click();
    const snapshot = JSON.parse(
      readFileSync((await (await download).path())!, "utf8"),
    );
    expect(snapshot.sourceSnapshot.records[0].eggs).toBe(80);
    expect(snapshot.sourceSnapshot.adjustments).toHaveLength(3);
    expect(snapshot.recordedTotals.feedKg).toBe("3.123456");
    // Commit the review, then lose the response: retry must reuse its receipt.
    let lose = true;
    await page.route("**/api/layers/recovery", async (route) => {
      if (lose && route.request().method() === "POST") {
        lose = false;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await recovery
      .getByLabel("Recovery observation date", { exact: true })
      .fill("2024-02-04");
    await recovery
      .getByLabel("Counted opening hens", { exact: true })
      .fill("80");
    await evidence();
    await expect(
      recovery.getByRole("button", {
        name: "Retry reviewed entry",
        exact: true,
      }),
    ).toBeVisible();
    await recovery
      .getByRole("button", { name: "Retry reviewed entry", exact: true })
      .click();
    await expect(recovery.getByRole("status")).toContainText(
      "Reviewed entry saved",
    );
    await page.unroute("**/api/layers/recovery");
    const censusHead = (
      await db.query(
        "SELECT id FROM current_layer_adjustments WHERE unit_id=$1 AND kind='census' AND observed_on='2024-02-04'",
        [unit],
      )
    ).rows[0].id;
    await post("layers/recovery", {
      organizationId: org,
      unitId: unit,
      eventId: randomUUID(),
      kind: "census",
      date: "2024-02-04",
      previousId: censusHead,
      openingHens: 75,
      reason: "Synthetic competing manager review",
      evidence: "Synthetic other count sheet",
    });
    await recovery
      .getByLabel("Counted opening hens", { exact: true })
      .fill("79");
    await evidence();
    await expect(recovery.getByRole("alert")).toContainText(
      "changed after you loaded",
    );
    await recovery
      .getByRole("button", { name: "Reload recovery history", exact: true })
      .click();
    await expect(
      recovery.getByLabel("Counted opening hens", { exact: true }),
    ).toHaveValue("75");
    await expect(
      recovery.getByRole("button", {
        name: "Retry reviewed entry",
        exact: true,
      }),
    ).not.toBeVisible();
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
      page.getByRole("region", { name: "Layer record recovery", exact: true }),
    ).toContainText("Recorded population balance: 74");
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
          "SELECT count(*) FROM layer_adjustments WHERE unit_id=$1",
          [unit],
        )
      ).rows[0].count,
    ).toBe("5");
    expect(
      (
        await db.query(
          "SELECT count(*) FROM audit_logs WHERE organization_id=$1 AND action LIKE 'layer.%'",
          [org],
        )
      ).rows[0].count,
    ).toBe("5");
  } finally {
    if (org) await db.query("DELETE FROM organizations WHERE id=$1", [org]);
    if (owner) await db.query("DELETE FROM users WHERE id=$1", [owner]);
    await db.end();
    // The runtime pool is shared by browser fixtures and permits exit on idle.
  }
});
