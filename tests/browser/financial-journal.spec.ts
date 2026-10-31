import { test, expect } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import pg from "pg";
import { processingFixture } from "../broiler-processing-fixture";
config({ path: ".env.local", quiet: true });
test("posts balanced financial entries, recovers one receipt, protects sale sources and preserves frozen trial balances", async ({
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
    auditor = "",
    worker = "";
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
      pricePerUnit: "2.5555",
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
    const productsPath = `broilers/products?organizationId=${org}&unitId=${unit}`,
      products = async () =>
        (await page.request.get("/api/" + productsPath)).json();
    async function product(data: unknown) {
      const p = await products();
      return post("broilers/products", {
        organizationId: org,
        unitId: unit,
        eventId: randomUUID(),
        date: "2024-02-03",
        expectedPosition: p.results.expectedPosition,
        expectedSourcePosition: p.expectedSourcePosition,
        expectedDailyId: p.expectedDailyId,
        data,
      });
    }
    const lot = (
      await product({
        kind: "receipt",
        sourceReviewId: reviewId,
        outputIndex: 0,
        location: "Synthetic journal cold room",
        scope: "whole-output-owned-available",
        reason: "Synthetic actual whole output received",
        evidence:
          "Synthetic owned available output without earlier external disposition",
      })
    ).id;
    const sold = (
      await product({
        kind: "sale",
        lotId: lot,
        weightKg: "3.123456",
        pricePerKg: "1.2345",
        reference: "SYNTHETIC-JOURNAL-PRODUCT",
        customer: "Synthetic buyer",
        reason: "Synthetic actual measured dispatch",
        evidence: "Synthetic original dispatch register",
      })
    ).id;
    const original = await snapshot(),
      originalProducts = await products(),
      live = original.events.find(
        (e: { price_basis: string }) => e.price_basis === "kg",
      ).id,
      errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => void d.accept());
    const journalPath = `finance/journal?organizationId=${org}`,
      workspace = async () =>
        (await page.request.get("/api/" + journalPath)).json();
    await page.goto("/");
    await page.getByRole("button", { name: "Finance", exact: true }).click();
    const region = page.getByRole("region", {
        name: "Financial journal and trial balance",
        exact: true,
      }),
      activity = region.getByRole("combobox", {
        name: "Journal activity",
        exact: true,
      }),
      text = async (name: string, value: string) =>
        region.getByRole("textbox", { name, exact: true }).fill(value),
      select = async (name: string, value: string) =>
        region.getByRole("combobox", { name, exact: true }).selectOption(value);
    await expect(region).toContainText("No posted entries");
    const evidence = async () => {
        await text(
          "Accounting review reason",
          "=Synthetic reviewed accounting source",
        );
        await text(
          "Accounting source and recognition evidence",
          "Synthetic explicit accounting evidence, no duplicate purchase/expense or sales recognition",
        );
      },
      ack = async () =>
        region
          .getByLabel("I confirm the accounting evidence", { exact: false })
          .check(),
      save = async () => {
        await region
          .getByRole("button", {
            name: "Post balanced journal entry",
            exact: true,
          })
          .click();
        await expect(region.getByRole("status")).toContainText(
          "Journal entry posted",
        );
      };
    await region
      .getByLabel("Accounting date", { exact: true })
      .fill("2024-02-01");
    await text("Original journal currency", "NGN");
    await select("Journal purpose", "opening_balance");
    await text("Unique manual book reference", "=SYNTHETIC-BROWSER-OPENING");
    await text(
      "Journal description",
      "Synthetic evidenced opening bank/equity balance",
    );
    await select("Journal line 1 account", "1000");
    await text("Journal line 1 amount", "100");
    await select("Journal line 2 account", "3000");
    await text("Journal line 2 amount", "100");
    await evidence();
    await region
      .getByRole("button", { name: "Preview journal entry", exact: true })
      .click();
    await expect(
      region.getByRole("region", {
        name: "Unsaved journal preview",
        exact: true,
      }),
    ).toContainText("100.0000");
    expect((await workspace()).report.entries).toHaveLength(0);
    await ack();
    await save();
    await activity.selectOption("recognize_sale");
    await select("Recorded broiler sale", "product:" + sold);
    await select("Sale settlement evidence", "receivables");
    await evidence();
    await ack();
    let lost = false;
    await page.route("**/api/finance/journal", async (route) => {
      if (route.request().method() === "POST" && !lost) {
        lost = true;
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        await route.abort("failed");
      } else await route.continue();
    });
    await region
      .getByRole("button", { name: "Post balanced journal entry", exact: true })
      .click();
    await expect(
      region.getByRole("button", {
        name: "Retry exact journal receipt",
        exact: true,
      }),
    ).toBeVisible();
    await expect(activity).toBeDisabled();
    await page.reload();
    await page.getByRole("button", { name: "Finance", exact: true }).click();
    await region
      .getByRole("button", { name: "Retry exact journal receipt", exact: true })
      .click();
    await expect(region.getByRole("status")).toContainText(
      "Journal entry posted",
    );
    await page.unroute("**/api/finance/journal");
    let w = await workspace();
    const recognized = w.report.entries.find(
      (e: { source_id: string }) => e.source_id === sold,
    );
    expect(w.report.entries).toHaveLength(2);
    expect(recognized.lines[0]).toEqual({
      account: "1100",
      side: "debit",
      amount: "3.8559",
    });
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM audit_logs WHERE object_id=$1",
          [recognized.id],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(await snapshot()).toEqual(original);
    expect(await products()).toEqual(originalProducts);
    const originalVoid = {
        kind: "void",
        voidOfId: sold,
        reason: "Synthetic erroneous source sale did not occur",
        evidence: "Synthetic original error correction record",
      },
      state = await products();
    const blocked = await page.request.post("/api/broilers/products", {
      headers,
      data: {
        organizationId: org,
        unitId: unit,
        eventId: randomUUID(),
        date: "2024-02-03",
        expectedPosition: state.results.expectedPosition,
        expectedSourcePosition: state.expectedSourcePosition,
        expectedDailyId: state.expectedDailyId,
        data: originalVoid,
      },
    });
    expect(blocked.status()).toBe(409);
    await activity.selectOption("recognize_sale");
    await select("Recorded broiler sale", "live:" + live);
    await select("Sale settlement evidence", "cash_bank");
    await text(
      "Cash or bank receipt evidence",
      "Synthetic actual live-sale cash receipt",
    );
    await evidence();
    await ack();
    await save();
    await activity.selectOption("manual");
    await region
      .getByLabel("Accounting date", { exact: true })
      .fill("2024-02-02");
    await text("Original journal currency", "NGN");
    await select("Journal purpose", "expense");
    await text("Unique manual book reference", "SYNTHETIC-BROWSER-EXPENSE");
    await text(
      "Journal description",
      "Synthetic documented production expense",
    );
    await select("Journal line 1 account", "5000");
    await text("Journal line 1 amount", "10");
    await select("Journal line 2 account", "1000");
    await text("Journal line 2 amount", "10");
    await evidence();
    w = await workspace();
    await post("finance/journal", {
      organizationId: org,
      entryId: randomUUID(),
      expectedPosition: w.expectedPosition,
      data: {
        kind: "manual",
        date: "2024-02-02",
        currency: "NGN",
        unitId: unit,
        purpose: "expense",
        reference: "SYNTHETIC-OTHER-MANAGER",
        description: "Synthetic separately evidenced expense",
        lines: [
          { account: "5000", side: "debit", amount: "7" },
          { account: "1000", side: "credit", amount: "7" },
        ],
        scope: "evidenced-manual-book-entry",
        reason: "Synthetic another manager accounting record",
        evidence: "Synthetic external actual expense receipt",
      },
    });
    await ack();
    await region
      .getByRole("button", { name: "Post balanced journal entry", exact: true })
      .click();
    await expect(region.getByRole("alert")).toContainText("journal changed");
    await expect(
      region.getByRole("textbox", {
        name: "Journal line 1 amount",
        exact: true,
      }),
    ).toHaveValue("10");
    let dl = page.waitForEvent("download");
    await region
      .getByRole("button", {
        name: "Download journal working copy",
        exact: true,
      })
      .click();
    await (await dl).saveAs(".local/browser-financial-journal-working.json");
    expect(
      JSON.parse(
        readFileSync(".local/browser-financial-journal-working.json", "utf8"),
      ).data.reference,
    ).toBe("SYNTHETIC-BROWSER-EXPENSE");
    await region
      .getByRole("button", { name: "Reload current journal", exact: true })
      .click();
    await expect(region.getByRole("status")).toContainText(
      "Working inputs retained",
    );
    await expect(
      region.getByLabel("I confirm the accounting evidence", { exact: false }),
    ).not.toBeChecked();
    await expect(
      region.getByRole("textbox", {
        name: "Journal line 1 amount",
        exact: true,
      }),
    ).toHaveValue("10");
    await ack();
    await save();
    w = await workspace();
    const frozenHead = w.expectedPosition,
      frozenUrl = `/api/${journalPath}&asOf=2024-02-03&throughPosition=${frozenHead}`,
      oldJson = await (
        await page.request.get(frozenUrl + "&format=json")
      ).text(),
      oldCsv = await (await page.request.get(frozenUrl + "&format=csv")).text();
    await activity.selectOption("reverse");
    await select("Original accounting entry", recognized.id);
    await region
      .getByLabel("Reversal accounting date", { exact: true })
      .fill("2024-02-04");
    await evidence();
    await ack();
    await save();
    expect((await products()).results.lots[0].balanceKg).toBe("10.876544");
    await product(originalVoid);
    expect((await products()).results.lots[0].balanceKg).toBe("14.000000");
    w = await workspace();
    await post("organizations/settings", {
      organizationId: org,
      name: "Synthetic journal browser",
      currency: "USD",
      timezone: "UTC",
    });
    await post("finance/journal", {
      organizationId: org,
      entryId: randomUUID(),
      expectedPosition: w.expectedPosition,
      data: {
        kind: "manual",
        date: "2024-02-01",
        currency: "USD",
        unitId: null,
        purpose: "opening_balance",
        reference: "SYNTHETIC-BACKDATED-USD",
        description: "Synthetic evidenced original USD opening balance",
        lines: [
          { account: "1000", side: "debit", amount: "2.5" },
          { account: "3000", side: "credit", amount: "2.5" },
        ],
        scope: "evidenced-manual-book-entry",
        reason: "Synthetic reviewed historical book entry",
        evidence: "Synthetic original USD bank/equity statement",
      },
    });
    expect(
      await (await page.request.get(frozenUrl + "&format=json")).text(),
    ).toBe(oldJson);
    expect(
      await (await page.request.get(frozenUrl + "&format=csv")).text(),
    ).toBe(oldCsv);
    await region
      .getByLabel("Journal as-of date", { exact: true })
      .fill("2024-02-03");
    await text("Append-position cutoff · blank uses latest", frozenHead);
    await region
      .getByRole("button", { name: "Load journal view", exact: true })
      .click();
    await expect(region).toContainText("5 included entries");
    for (const format of ["json", "csv"]) {
      dl = page.waitForEvent("download");
      await region
        .getByRole("button", {
          name: `Download journal ${format.toUpperCase()}`,
          exact: true,
        })
        .click();
      await (await dl).saveAs(`.local/browser-financial-journal.${format}`);
    }
    const exported = JSON.parse(
        readFileSync(".local/browser-financial-journal.json", "utf8"),
      ),
      { evidenceSha256, ...normalized } = exported;
    expect(
      createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
    ).toBe(evidenceSha256);
    expect(exported.throughPosition).toBe(frozenHead);
    expect(exported.trialBalance[0]).toMatchObject({
      debits: "146.4109",
      credits: "146.4109",
    });
    expect(
      readFileSync(".local/browser-financial-journal.csv", "utf8"),
    ).toContain("'=SYNTHETIC-BROWSER-OPENING");
    await page.setViewportSize({ width: 390, height: 844 });
    await region
      .getByRole("heading", {
        name: "Financial journal and trial balance",
        exact: true,
      })
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    const geometry = await page.evaluate(() => ({
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      overflow: [...document.querySelectorAll("main *")]
        .filter(
          (el) =>
            el.getBoundingClientRect().right > innerWidth + 1 &&
            !el.closest(".table-scroll"),
        )
        .map((el) => ({
          tag: el.tagName,
          class: el.className,
          right: el.getBoundingClientRect().right,
          text: el.textContent?.slice(0, 80),
        })),
    }));
    await page.screenshot({
      path: ".local/finance-width-diagnostic.png",
      animations: "disabled",
    });
    expect(geometry.scrollWidth, JSON.stringify(geometry)).toBeLessThanOrEqual(
      geometry.width,
    );
    await page.screenshot({
      path: ".local/browser-financial-journal-mobile.png",
      animations: "disabled",
    });
    await region
      .getByRole("heading", { name: "Posted trial balance", exact: true })
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.screenshot({
      path: ".local/browser-financial-trial-mobile.png",
      animations: "disabled",
    });
    auditor = (
      await db.query(
        "INSERT INTO users(email,password_hash) VALUES($1,'fixture') RETURNING id",
        [randomUUID() + "@test.invalid"],
      )
    ).rows[0].id;
    worker = (
      await db.query(
        "INSERT INTO users(email,password_hash) VALUES($1,'fixture') RETURNING id",
        [randomUUID() + "@test.invalid"],
      )
    ).rows[0].id;
    await db.query(
      "INSERT INTO memberships VALUES($1,$2,'auditor'),($1,$3,'worker')",
      [org, auditor, worker],
    );
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
    await page.getByRole("button", { name: "Finance", exact: true }).click();
    await expect(
      region.getByRole("heading", {
        name: "Posted trial balance",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      region.getByRole("button", {
        name: "Post balanced journal entry",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      region.getByRole("button", {
        name: "Download journal JSON",
        exact: true,
      }),
    ).toBeEnabled();
    await context.addCookies([
      {
        name: cookieName,
        value: await createSession(worker),
        url: "http://localhost:3000",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: "Finance", exact: true }),
    ).toHaveCount(0);
    expect((await page.request.get("/api/" + journalPath)).status()).toBe(403);
    expect(errors).toEqual([]);
  } finally {
    if (org) await db.query("DELETE FROM organizations WHERE id=$1", [org]);
    for (const id of [owner, auditor, worker])
      if (id) await db.query("DELETE FROM users WHERE id=$1", [id]);
    await db.end();
  }
});
