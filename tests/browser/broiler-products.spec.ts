import { test, expect } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import pg from "pg";
import { processingFixture } from "../broiler-processing-fixture";
config({ path: ".env.local", quiet: true });
test("receives source-linked product stock, recovers dispatch receipts, preserves stale inputs and exports immutable history", async ({
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
      mortality: 0,
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
        kind: "harvest",
        date: h.summary.asOf,
        quantity: 10,
        weightKg: "20",
        priceBasis: "unpriced",
        pricePerUnit: null,
        reference: null,
        customer: null,
        description: "Synthetic processing source harvest",
        reason: "Synthetic reviewed source measurement",
        evidence: "Synthetic live scale record",
        expectedPosition: h.summary.expectedPosition,
        expectedDailyId: h.summary.expectedDailyId,
        ...values,
      });
    };
    const harvest = (await event({})).id;
    await event({
      quantity: 5,
      weightKg: "10",
      priceBasis: "kg",
      pricePerUnit: "0",
      reference: "SYNTHETIC-PROCESSING-LIVE-SALE",
      customer: "Synthetic buyer",
    });
    await post("records", {
      organizationId: org,
      unitId: unit,
      recordedOn: "2024-02-02",
      mortality: 0,
      feedKg: 20,
      averageWeightG: 2500,
      sampleSize: 10,
      eggs: 0,
      cracked: 0,
      waterQuality: null,
      notes: "Synthetic later representative sample",
    });
    const h = await snapshot();
    const reviewId = randomUUID();
    await post("broilers/processing", {
      organizationId: org,
      unitId: unit,
      reviewId,
      harvestId: harvest,
      previousId: null,
      expectedPosition: h.summary.expectedPosition,
      expectedDailyId: h.summary.expectedDailyId,
      data: processingFixture(),
    });
    const original = await snapshot(),
      errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => void d.accept());
    const productPath = `broilers/products?organizationId=${org}&unitId=${unit}`,
      report = async () =>
        (await page.request.get("/api/" + productPath)).json();
    await page.goto("/");
    await page.getByRole("button", { name: "Production", exact: true }).click();
    const region = page.getByRole("region", {
        name: "Broiler product stock and sales",
        exact: true,
      }),
      processing = page.getByRole("region", {
        name: "Broiler processing and measured yields",
        exact: true,
      });
    const activity = region.getByRole("combobox", {
        name: "Product activity",
        exact: true,
      }),
      select = async (name: string, value: string) =>
        region.getByRole("combobox", { name, exact: true }).selectOption(value),
      text = async (name: string, value: string) =>
        region.getByRole("textbox", { name, exact: true }).fill(value);
    const evidence = async () => {
      await region
        .getByLabel("Product movement date", { exact: true })
        .fill("2024-02-03");
      await text(
        "Product review reason",
        "=Synthetic browser stock confirmation",
      );
      await text(
        "Physical stock and source evidence",
        "Synthetic owned available stock and original scale register",
      );
    };
    const ack = async () => region.getByRole("checkbox").check(),
      save = async () => {
        await region
          .getByRole("button", { name: "Save product movement", exact: true })
          .click();
        await expect(region.getByRole("status")).toContainText(
          "Product movement saved",
        );
      };
    await expect(
      region
        .getByRole("combobox", {
          name: "Measured output to receive",
          exact: true,
        })
        .locator("option"),
    ).toHaveCount(3);
    await select("Measured output to receive", `${reviewId}:0`);
    await evidence();
    await text("Product location label", "Synthetic cold room A");
    await ack();
    await save();
    let r = await report();
    const lot = r.events[0].id;
    expect(r.results.lots[0].balanceKg).toBe("14.000000");
    await activity.selectOption("sale");
    await select("Product lot", lot);
    await evidence();
    await text("Measured product kg", "3.123456");
    await text("Price per product kg", "1.2345");
    await text("Product sale reference", "SYNTHETIC-BROWSER-SALE");
    await text("Product customer", "Synthetic buyer");
    await ack();
    let lost = false;
    await page.route("**/api/broilers/products", async (route) => {
      if (route.request().method() === "POST" && !lost) {
        lost = true;
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        await route.abort("failed");
      } else await route.continue();
    });
    await region
      .getByRole("button", { name: "Save product movement", exact: true })
      .click();
    await expect(
      region.getByRole("button", {
        name: "Retry exact product receipt",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      processing.getByRole("combobox", {
        name: "Whole harvest to process",
        exact: true,
      }),
    ).toBeDisabled();
    await page.reload();
    await page.getByRole("button", { name: "Production", exact: true }).click();
    await expect(
      region.getByRole("button", {
        name: "Retry exact product receipt",
        exact: true,
      }),
    ).toBeVisible();
    await region
      .getByRole("button", { name: "Retry exact product receipt", exact: true })
      .click();
    await expect(region.getByRole("status")).toContainText(
      "Product movement saved",
    );
    await page.unroute("**/api/broilers/products");
    r = await report();
    expect(
      r.events.filter((e: { kind: string }) => e.kind === "sale"),
    ).toHaveLength(1);
    expect(r.results.lots[0]).toMatchObject({
      balanceKg: "10.876544",
      soldKg: "3.123456",
    });
    const sale = r.events.find((e: { kind: string }) => e.kind === "sale");
    expect(sale.amount).toBe("3.8559");
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM audit_logs WHERE object_id=$1",
          [sale.id],
        )
      ).rows[0].n,
    ).toBe(1);
    await activity.selectOption("loss");
    await select("Product lot", lot);
    await evidence();
    await text("Measured product kg", "0.123456");
    const current = await report();
    await post("broilers/products", {
      organizationId: org,
      unitId: unit,
      eventId: randomUUID(),
      date: "2024-02-03",
      expectedPosition: current.results.expectedPosition,
      expectedSourcePosition: current.expectedSourcePosition,
      expectedDailyId: current.expectedDailyId,
      data: {
        kind: "loss",
        lotId: lot,
        weightKg: "1",
        reason: "Synthetic second manager measured loss",
        evidence: "Synthetic other manager scale register",
      },
    });
    await ack();
    await region
      .getByRole("button", { name: "Save product movement", exact: true })
      .click();
    await expect(region.getByRole("alert")).toContainText("changed");
    await expect(
      region.getByRole("textbox", { name: "Measured product kg", exact: true }),
    ).toHaveValue("0.123456");
    let dl = page.waitForEvent("download");
    await region
      .getByRole("button", {
        name: "Download product working copy",
        exact: true,
      })
      .click();
    await (await dl).saveAs(".local/browser-broiler-products-working.json");
    expect(
      JSON.parse(
        readFileSync(".local/browser-broiler-products-working.json", "utf8"),
      ).data.weightKg,
    ).toBe("0.123456");
    await region
      .getByRole("button", { name: "Reload product source", exact: true })
      .click();
    await expect(region.getByRole("status")).toContainText("Inputs retained");
    await expect(region.getByRole("checkbox")).not.toBeChecked();
    await expect(
      region.getByRole("textbox", { name: "Measured product kg", exact: true }),
    ).toHaveValue("0.123456");
    await ack();
    await save();
    r = await report();
    expect(r.results.lots[0].balanceKg).toBe("9.753088");
    await activity.selectOption("void");
    await select("Erroneous product entry", sale.id);
    await evidence();
    await ack();
    await save();
    r = await report();
    expect(r.results.lots[0]).toMatchObject({
      balanceKg: "12.876544",
      soldKg: "0.000000",
      lostKg: "1.123456",
    });
    expect(r.results.salesByCurrency).toEqual({});
    await processing
      .getByRole("combobox", { name: "Whole harvest to process", exact: true })
      .selectOption(harvest);
    await processing
      .getByRole("textbox", { name: "Processing review reason", exact: true })
      .fill("Synthetic forbidden change to stocked source");
    await processing
      .getByRole("textbox", {
        name: "Scale records, ownership and product evidence",
        exact: true,
      })
      .fill("Synthetic attempted source revision");
    await processing
      .getByLabel("I reviewed this exact whole harvest", { exact: false })
      .check();
    await processing
      .getByRole("button", { name: "Save processing version", exact: true })
      .click();
    await expect(processing.getByRole("alert")).toContainText(
      "receipts depend",
    );
    expect(await snapshot()).toEqual(original);
    for (const format of ["json", "csv"]) {
      dl = page.waitForEvent("download");
      await region
        .getByRole("button", {
          name: `Download product ${format.toUpperCase()}`,
          exact: true,
        })
        .click();
      await (await dl).saveAs(`.local/browser-broiler-products.${format}`);
    }
    r = JSON.parse(
      readFileSync(".local/browser-broiler-products.json", "utf8"),
    );
    expect(
      createHash("sha256")
        .update(
          JSON.stringify({
            modelVersion: r.modelVersion,
            source: r.source,
            events: r.events,
            results: r.results,
          }),
        )
        .digest("hex"),
    ).toBe(r.evidenceSha256);
    expect(
      readFileSync(".local/browser-broiler-products.csv", "utf8"),
    ).toContain("'=Synthetic browser stock confirmation");
    await page.setViewportSize({ width: 390, height: 844 });
    await region
      .getByRole("heading", { name: "Measured product lots", exact: true })
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    const geometry = await page.evaluate(() => ({
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      overflow: [...document.querySelectorAll("main *")]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.right > innerWidth + 1 && !el.closest(".table-scroll");
        })
        .map((el) => ({
          tag: el.tagName,
          class: el.className,
          right: el.getBoundingClientRect().right,
          text: el.textContent?.slice(0, 80),
        })),
    }));
    await page.screenshot({
      path: ".local/browser-broiler-products-width-diagnostic.png",
      animations: "disabled",
    });
    expect(geometry.scrollWidth, JSON.stringify(geometry)).toBeLessThanOrEqual(
      geometry.width,
    );
    await page.screenshot({
      path: ".local/browser-broiler-products-mobile.png",
      animations: "disabled",
    });
    await region
      .getByRole("heading", {
        name: "Broiler product stock and sales",
        exact: true,
      })
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.screenshot({
      path: ".local/browser-broiler-products-form-mobile.png",
      animations: "disabled",
    });
    auditor = (
      await db.query(
        "INSERT INTO users(email,password_hash) VALUES($1,'fixture') RETURNING id",
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
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: "Production", exact: true }).click();
    await expect(
      region.getByRole("heading", {
        name: "Immutable product movement history",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      region.getByRole("button", {
        name: "Save product movement",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      region.getByRole("button", {
        name: "Download product JSON",
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
