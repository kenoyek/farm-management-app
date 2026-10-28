import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import pg from "pg";
config({ path: ".env.local", quiet: true });
test("transfers eggs across farms, retries one receipt, and reviews original-price partial returns with inspected stock", async ({
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
    const otherFarm = (
      await post("farms", {
        organizationId: org,
        name: "Synthetic transfer destination farm",
        kind: "layers",
        location: "Synthetic fixture",
      })
    ).id;
    const originStore = randomUUID(),
      destStore = randomUUID(),
      rootBatch = randomUUID();
    await post("eggs/stores", {
      organizationId: org,
      storeId: originStore,
      farmId: farm,
      name: "A Synthetic source store",
    });
    await post("eggs/stores", {
      organizationId: org,
      storeId: destStore,
      farmId: otherFarm,
      name: "B Synthetic destination store",
    });
    async function snapshot() {
      return (await page.request.get("/api/eggs?organizationId=" + org)).json();
    }
    let state = await snapshot();
    const actual = state.collections.find(
      (c: { recorded_on: string }) => c.recorded_on === "2024-02-01",
    );
    await post("eggs/events", {
      organizationId: org,
      eventId: randomUUID(),
      batchId: rootBatch,
      date: "2024-02-02",
      kind: "receipt",
      storeId: originStore,
      batchName: "Synthetic source batch",
      unitId: unit,
      collectionDate: "2024-02-01",
      expectedRecordId: actual.id,
      expectedAdjustmentId: null,
      previousId: null,
      reason: "Synthetic original receipt review",
      evidence: "Original synthetic sheet",
    });
    await page.goto("/");
    await page
      .getByRole("button", { name: "Egg inventory", exact: true })
      .click();
    const region = page.getByRole("region", {
        name: "Egg inventory and sales",
        exact: true,
      }),
      dialog = page.getByRole("dialog");
    async function confirm() {
      await dialog
        .getByLabel("Egg posting reason", { exact: true })
        .fill("Synthetic completed stock movement review");
      await dialog
        .getByLabel("Egg posting evidence", { exact: true })
        .fill("Synthetic delivery, inspection or return register");
      await dialog
        .getByRole("checkbox", {
          name: "I checked the counts, date, grade, prices where applicable, and source evidence.",
          exact: true,
        })
        .check();
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
    let lose = true;
    await page.route("**/api/eggs/events", async (route) => {
      if (
        lose &&
        JSON.parse(route.request().postData() ?? "{}").kind === "transfer"
      ) {
        lose = false;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await region
      .getByRole("button", { name: "Transfer eggs", exact: true })
      .click();
    await dialog.getByLabel("Whole egg quantity", { exact: true }).fill("9");
    await dialog
      .getByRole("combobox", { name: "Destination egg store", exact: true })
      .selectOption(destStore);
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
    await region
      .getByRole("button", { name: "Retry egg posting", exact: true })
      .click();
    await saved();
    await page.unroute("**/api/eggs/events");
    state = await snapshot();
    expect(state.events).toHaveLength(2);
    const transfer = state.events.find(
        (e: { kind: string }) => e.kind === "transfer",
      ),
      child = transfer.destination_batch_id;
    expect(
      state.batches.find((b: { id: string }) => b.id === child).parent_batch_id,
    ).toBe(rootBatch);
    expect(state.summary.totalEggs).toBe(98);
    await region
      .getByRole("combobox", { name: "Egg store", exact: true })
      .selectOption(destStore);
    await region
      .getByRole("button", { name: "Record egg sale", exact: true })
      .click();
    await dialog
      .getByLabel("Egg sale customer", { exact: true })
      .fill("Synthetic partial return customer");
    await dialog
      .getByLabel("Egg sale reference", { exact: true })
      .fill("ADVANCED-BROWSER-SALE");
    await dialog
      .getByRole("combobox", { name: "Egg sale pricing", exact: true })
      .selectOption("tray-and-loose");
    await dialog.getByLabel("Whole trays sold", { exact: true }).fill("1");
    await dialog.getByLabel("Loose eggs sold", { exact: true }).fill("2");
    await dialog.getByLabel("Eggs per sale tray", { exact: true }).fill("3");
    await dialog.getByLabel("Price per tray (NGN)", { exact: true }).fill("1");
    await dialog
      .getByLabel("Price per egg (NGN)", { exact: true })
      .fill("0.1234");
    await confirm();
    await saved();
    state = await snapshot();
    const sale = state.events.find((e: { kind: string }) => e.kind === "sale"),
      today = state.organization.today;
    async function returnFields(
      t: string,
      l: string,
      restock: string,
      ref: string,
    ) {
      await dialog
        .getByLabel("Returned tray-priced eggs", { exact: true })
        .fill(t);
      await dialog
        .getByLabel("Returned individually priced eggs", { exact: true })
        .fill(l);
      await dialog
        .getByLabel("Saleable eggs to restock", { exact: true })
        .fill(restock);
      await dialog
        .getByLabel("Egg return reference", { exact: true })
        .fill(ref);
      await dialog
        .getByRole("checkbox", {
          name: "I confirmed the goods returned and inspected their saleable condition.",
          exact: true,
        })
        .check();
    }
    await region
      .getByRole("button", { name: "Review egg return", exact: true })
      .click();
    await returnFields("1", "1", "1", "STALE-BROWSER-RETURN");
    const rs = state.summary.saleReturns.find(
      (r: { saleId: string }) => r.saleId === sale.id,
    );
    const otherReturn = (
      await post("eggs/events", {
        organizationId: org,
        eventId: randomUUID(),
        batchId: child,
        date: today,
        kind: "return",
        saleId: sale.id,
        trayEggs: 1,
        looseEggs: 0,
        restockEggs: 1,
        expectedReturnPosition: rs.expectedPosition,
        reference: "OTHER-BROWSER-RETURN",
        reason: "Synthetic competing return review",
        evidence: "Synthetic original inspection",
      })
    ).id;
    await confirm();
    await expect(dialog.getByRole("alert")).toContainText(
      "sale return state changed",
    );
    await dialog
      .getByRole("button", { name: "Reload before posting", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await region
      .getByRole("button", { name: "Review egg return", exact: true })
      .click();
    await returnFields("1", "1", "1", "CURRENT-BROWSER-RETURN");
    await expect(dialog.getByRole("status")).toContainText("NGN 0.4568");
    await confirm();
    await saved();
    state = await snapshot();
    const current = state.events
      .filter((e: { kind: string }) => e.kind === "return")
      .at(-1);
    expect(state.summary.saleReturns[0]).toMatchObject({
      returnedTrayEggs: 2,
      returnedLooseEggs: 1,
      restockedEggs: 2,
      nonSaleableEggs: 1,
      creditedValue: "0.7901",
    });
    await region
      .getByRole("button", { name: "Reverse egg movement", exact: true })
      .click();
    const options = dialog.getByRole("combobox", {
      name: "Egg movement to reverse",
      exact: true,
    });
    expect(await options.locator(`option[value="${sale.id}"]`).count()).toBe(0);
    expect(
      await options.locator(`option[value="${otherReturn}"]`).count(),
    ).toBe(0);
    await options.selectOption(current.id);
    await confirm();
    await saved();
    await region
      .getByRole("button", { name: "Review egg return", exact: true })
      .click();
    await returnFields("2", "2", "2", "FINAL-BROWSER-RETURN");
    await expect(dialog.getByRole("status")).toContainText("NGN 0.9135");
    await confirm();
    await saved();
    state = await snapshot();
    expect(state.summary.totalEggs).toBe(96);
    expect(state.summary.sales[0]).toMatchObject({
      netEggs: 0,
      netValue: "0.0000",
    });
    expect(state.summary.saleReturns[0]).toMatchObject({
      restockedEggs: 3,
      nonSaleableEggs: 2,
      creditedValue: "1.2468",
      remainingTrayEggs: 0,
      remainingLooseEggs: 0,
    });
    expect(state.events).toHaveLength(7);
    const denied = await page.request.post("/api/eggs/events", {
      headers,
      data: {
        organizationId: org,
        eventId: randomUUID(),
        batchId: rootBatch,
        date: today,
        kind: "reversal",
        reversesId: transfer.id,
        reason: "Synthetic transfer reversal check",
        evidence: "Synthetic insufficient returned stock",
      },
    });
    expect(denied.status()).toBe(400);
    expect((await snapshot()).summary.totalEggs).toBe(96);
    const dl = page.waitForEvent("download");
    await region
      .getByRole("button", { name: "Download egg inventory JSON", exact: true })
      .click();
    const document = JSON.parse(
      readFileSync((await (await dl).path())!, "utf8"),
    );
    expect(document.events[0].source_snapshot.eggs).toBe(100);
    expect(
      document.batches.find((b: { id: string }) => b.id === child)
        .parent_batch_id,
    ).toBe(rootBatch);
    const csv = page.waitForEvent("download");
    await region
      .getByRole("button", { name: "Download egg inventory CSV", exact: true })
      .click();
    const text = readFileSync((await (await csv).path())!, "utf8");
    expect(text).toContain("Transfers and returns");
    expect(text).toContain("Customer return reconciliation");
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
    await page.screenshot({
      path: ".local/egg-next-mobile.png",
      fullPage: true,
      animations: "disabled",
    });
    expect(errors).toEqual([]);
  } finally {
    if (org) await db.query("DELETE FROM organizations WHERE id=$1", [org]);
    if (owner) await db.query("DELETE FROM users WHERE id=$1", [owner]);
    await db.end();
    // The runtime pool is shared by browser fixtures and permits exit on idle.
  }
});
