import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import pg from "pg";
config({ path: ".env.local", quiet: true });
test("receives, grades and sells eggs, safely recovers a lost response, and reconciles corrected collections", async ({
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
    await record("2024-02-01", 0, 100, 2, 1);
    await record("2024-02-02", 0, 0, 0, 0);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    await page
      .getByRole("button", { name: "Egg inventory", exact: true })
      .click();
    const region = page.getByRole("region", {
      name: "Egg inventory and sales",
      exact: true,
    });
    const dialog = page.getByRole("dialog");
    async function confirm() {
      await dialog
        .getByLabel("Egg posting reason", { exact: true })
        .fill("Synthetic dated register checked");
      await dialog
        .getByLabel("Egg posting evidence", { exact: true })
        .fill("Synthetic collection, count or dispatch sheet");
      await dialog.getByRole("checkbox").check();
      await dialog
        .getByRole("button", { name: "Confirm egg posting", exact: true })
        .click();
    }
    async function saved() {
      await expect(
        region.getByText(
          "Egg posting confirmed. Stock and recorded sale values refreshed.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(dialog).not.toBeVisible();
    }
    await region
      .getByRole("button", { name: "Add egg store", exact: true })
      .click();
    await dialog
      .getByLabel("Egg store name", { exact: true })
      .fill("Synthetic browser egg store");
    await dialog
      .getByRole("button", { name: "Confirm egg posting", exact: true })
      .click();
    await saved();
    const collections = region.getByRole("table", {
      name: "Egg collection reconciliation",
    });
    await collections
      .getByRole("row")
      .filter({ hasText: "2024-02-01" })
      .getByRole("button", { name: "Receive collection", exact: true })
      .click();
    await confirm();
    await saved();
    await collections
      .getByRole("row")
      .filter({ hasText: "2024-02-02" })
      .getByRole("button", { name: "Receive collection", exact: true })
      .click();
    await confirm();
    await saved();
    async function snapshot() {
      return (await page.request.get("/api/eggs?organizationId=" + org)).json();
    }
    let state = await snapshot();
    const batch = state.batches.find(
      (b: { collected_on: string }) => b.collected_on === "2024-02-01",
    ).id;
    await region
      .getByRole("combobox", { name: "Egg batch for movement", exact: true })
      .selectOption(batch);
    await region
      .getByRole("button", { name: "Grade eggs", exact: true })
      .click();
    await dialog
      .getByRole("combobox", { name: "Egg grade", exact: true })
      .selectOption("ungraded");
    await dialog
      .getByRole("combobox", { name: "Target egg grade", exact: true })
      .selectOption("large");
    await dialog.getByLabel("Whole egg quantity", { exact: true }).fill("80");
    await confirm();
    await saved();
    await region
      .getByRole("button", { name: "Record egg sale", exact: true })
      .click();
    await dialog
      .getByRole("combobox", { name: "Egg grade", exact: true })
      .selectOption("large");
    await dialog
      .getByLabel("Egg sale customer", { exact: true })
      .fill("=Synthetic browser buyer");
    await dialog
      .getByLabel("Egg sale reference", { exact: true })
      .fill("SYNTHETIC-BROWSER-SALE");
    await dialog
      .getByRole("combobox", { name: "Egg sale pricing", exact: true })
      .selectOption("tray-and-loose");
    await dialog.getByLabel("Whole trays sold", { exact: true }).fill("2");
    await dialog.getByLabel("Loose eggs sold", { exact: true }).fill("2");
    await dialog
      .getByLabel("Price per tray (NGN)", { exact: true })
      .fill("4500.1250");
    await dialog
      .getByLabel("Price per egg (NGN)", { exact: true })
      .fill("155.25");
    await expect(dialog.getByRole("status")).toContainText(
      "62 whole eggs · NGN 9310.7500",
    );
    await confirm();
    await saved();
    const json = page.waitForEvent("download");
    await region
      .getByRole("button", { name: "Download egg inventory JSON", exact: true })
      .click();
    const document = JSON.parse(
      readFileSync((await (await json).path())!, "utf8"),
    );
    expect(document.summary.sales).toEqual([
      { currency: "NGN", netEggs: 62, netValue: "9310.7500" },
    ]);
    expect(document.summary.totalEggs).toBe(36);
    expect(document.events[0].source_snapshot.eggs).toBe(100);
    const csv = page.waitForEvent("download");
    await region
      .getByRole("button", { name: "Download egg inventory CSV", exact: true })
      .click();
    expect(readFileSync((await (await csv).path())!, "utf8")).toContain(
      "'=Synthetic browser buyer",
    );
    let lose = true;
    await page.route("**/api/eggs/events", async (route) => {
      if (lose && route.request().method() === "POST") {
        lose = false;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await region
      .getByRole("button", { name: "Record egg loss", exact: true })
      .click();
    await dialog
      .getByRole("combobox", { name: "Egg grade", exact: true })
      .selectOption("large");
    await dialog.getByLabel("Whole egg quantity", { exact: true }).fill("2");
    await confirm();
    await expect(
      region.getByRole("heading", {
        name: "Unconfirmed egg posting",
        exact: true,
      }),
    ).toBeVisible();
    page.on("dialog", (d) => void d.accept());
    await page.reload();
    await page
      .getByRole("button", { name: "Egg inventory", exact: true })
      .click();
    await expect(
      region.getByRole("heading", {
        name: "Unconfirmed egg posting",
        exact: true,
      }),
    ).toBeVisible();
    await region
      .getByRole("button", { name: "Retry egg posting", exact: true })
      .click();
    await saved();
    await page.unroute("**/api/eggs/events");
    state = await snapshot();
    expect(state.events).toHaveLength(5);
    const lost = state.events.find(
      (e: { kind: string }) => e.kind === "loss",
    ).id;
    await region
      .getByRole("combobox", { name: "Egg batch for movement", exact: true })
      .selectOption(batch);
    await region
      .getByRole("button", { name: "Review physical egg count", exact: true })
      .click();
    await dialog
      .getByRole("combobox", { name: "Egg grade", exact: true })
      .selectOption("large");
    await dialog
      .getByLabel("Physically counted eggs", { exact: true })
      .fill("20");
    const today = state.organization.today;
    await post("eggs/events", {
      organizationId: org,
      eventId: randomUUID(),
      batchId: batch,
      date: today,
      kind: "loss",
      grade: "large",
      quantity: 1,
      reason: "Synthetic competing stock movement",
      evidence: "Synthetic other dispatch sheet",
    });
    await confirm();
    await expect(dialog.getByRole("alert")).toContainText(
      "batch changed after you loaded",
    );
    await dialog
      .getByRole("button", { name: "Reload before posting", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await region
      .getByRole("button", { name: "Review physical egg count", exact: true })
      .click();
    await dialog
      .getByRole("combobox", { name: "Egg grade", exact: true })
      .selectOption("large");
    await dialog
      .getByLabel("Physically counted eggs", { exact: true })
      .fill("16");
    await confirm();
    await saved();
    await region
      .getByRole("button", { name: "Reverse egg movement", exact: true })
      .click();
    await dialog
      .getByRole("combobox", { name: "Egg movement to reverse", exact: true })
      .selectOption(lost);
    await confirm();
    await saved();
    state = await snapshot();
    const sale = state.events.find(
      (e: { kind: string }) => e.kind === "sale",
    ).id;
    await region
      .getByRole("button", { name: "Reverse egg movement", exact: true })
      .click();
    await dialog
      .getByRole("combobox", { name: "Egg movement to reverse", exact: true })
      .selectOption(sale);
    await confirm();
    await saved();
    expect((await snapshot()).summary.sales[0].netValue).toBe("0.0000");
    state = await snapshot();
    const source = state.collections.find(
      (c: { recorded_on: string }) => c.recorded_on === "2024-02-01",
    );
    await post("layers/recovery", {
      organizationId: org,
      unitId: unit,
      eventId: randomUUID(),
      kind: "daily",
      date: "2024-02-01",
      previousId: null,
      baseRecordId: source.id,
      mortality: 0,
      eggs: 90,
      cracked: 2,
      feedKg: "1",
      notes: "Synthetic corrected collection",
      reason: "Synthetic revised source checked",
      evidence: "Synthetic corrected collection sheet",
    });
    await region
      .getByRole("button", { name: "Reload egg inventory", exact: true })
      .click();
    const changed = collections
      .getByRole("row")
      .filter({ hasText: "2024-02-01" });
    await expect(changed).toContainText("source-changed");
    await expect(changed).toContainText("-10");
    await changed
      .getByRole("button", { name: "Reconcile receipt", exact: true })
      .click();
    await confirm();
    await saved();
    state = await snapshot();
    expect(state.summary.totalEggs).toBe(88);
    expect(state.events).toHaveLength(10);
    expect(
      state.summary.reconciliation.find(
        (r: { date: string }) => r.date === "2024-02-02",
      ),
    ).toMatchObject({ received: 0, status: "reconciled" });
    await expect(
      region.getByRole("button", {
        name: "Record opening egg stock",
        exact: true,
      }),
    ).toBeDisabled();
    await region
      .getByRole("button", { name: "Add egg store", exact: true })
      .click();
    await dialog
      .getByLabel("Egg store name", { exact: true })
      .fill("Synthetic browser opening store");
    await dialog
      .getByRole("button", { name: "Confirm egg posting", exact: true })
      .click();
    await saved();
    for (const [name, g, n] of [
      ["Synthetic opening first", "ungraded", "5"],
      ["Synthetic opening second", "small", "2"],
    ]) {
      await region
        .getByRole("button", { name: "Record opening egg stock", exact: true })
        .click();
      await dialog
        .getByLabel("Opening egg batch name", { exact: true })
        .fill(name);
      await dialog
        .getByRole("combobox", { name: "Egg grade", exact: true })
        .selectOption(g);
      await dialog.getByLabel("Whole egg quantity", { exact: true }).fill(n);
      await confirm();
      await saved();
    }
    state = await snapshot();
    expect(state.summary.totalEggs).toBe(95);
    expect(
      state.batches.filter(
        (b: { source_kind: string }) => b.source_kind === "opening",
      ),
    ).toHaveLength(2);
    await expect(region).toContainText(
      "Earlier collections are outside this store",
    );
    const firstOpening = state.batches.find(
      (b: { name: string }) => b.name === "Synthetic opening first",
    ).id;
    await region
      .getByRole("combobox", { name: "Egg batch for movement", exact: true })
      .selectOption(firstOpening);
    await region
      .getByRole("button", { name: "Grade eggs", exact: true })
      .click();
    await dialog
      .getByRole("combobox", { name: "Egg grade", exact: true })
      .selectOption("ungraded");
    await dialog
      .getByRole("combobox", { name: "Target egg grade", exact: true })
      .selectOption("large");
    await dialog.getByLabel("Whole egg quantity", { exact: true }).fill("1");
    await confirm();
    await saved();
    await expect(
      region.getByRole("button", {
        name: "Record opening egg stock",
        exact: true,
      }),
    ).toBeDisabled();
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Egg inventory", exact: true })
      .click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
    expect(
      (
        await db.query("SELECT count(*) FROM daily_records WHERE unit_id=$1", [
          unit,
        ])
      ).rows[0].count,
    ).toBe("2");
  } finally {
    if (org) await db.query("DELETE FROM organizations WHERE id=$1", [org]);
    if (owner) await db.query("DELETE FROM users WHERE id=$1", [owner]);
    await db.end();
    // The runtime pool is shared by browser fixtures and permits exit on idle.
  }
});
