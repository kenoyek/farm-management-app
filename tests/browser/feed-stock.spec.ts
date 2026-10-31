import { test, expect } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import pg from "pg";
import { feedReceipt } from "../feed-stock-fixture";
import type {
  FeedStockWorkspace,
  FeedStockData,
} from "../../src/lib/feed-stock";
config({ path: ".env.local", quiet: true });
test("receives and values specific feed lots, recovers a receipt, preserves stale inputs and freezes source evidence", async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  const secret = readFileSync(".local/postgres.env", "utf8").match(
      /POSTGRES_PASSWORD=(.+)/,
    )![1],
    db = new pg.Pool({
      connectionString: `postgresql://postgres:${secret}@127.0.0.1:54329/farmstead`,
    }),
    { createSession, cookieName } = await import("../../src/lib/auth");
  let owner = "",
    org = "",
    auditor = "",
    worker = "";
  try {
    owner = (
      await db.query(
        "INSERT INTO users(email,password_hash) VALUES($1,'fixture') RETURNING id",
        ["synthetic-feed-browser-" + randomUUID() + "@test.invalid"],
      )
    ).rows[0].id;
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE farm_app");
      await c.query("SELECT set_config('app.user_id',$1,true)", [owner]);
      org = (
        await c.query(
          "SELECT create_organization('Synthetic feed browser') AS id",
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
    async function post(path: string, data: unknown) {
      const r = await page.request.post("/api/" + path, { headers, data });
      expect(r.ok(), await r.text()).toBe(true);
      return r.json();
    }
    const farm = (
        await post("farms", {
          organizationId: org,
          name: "Synthetic feed browser farm",
          kind: "broilers",
          location: "Synthetic fixture",
        })
      ).id,
      unit = (
        await post("units", {
          organizationId: org,
          farmId: farm,
          name: "Synthetic actual feed batch",
          kind: "broilers",
          stockedOn: "2024-02-01",
          openingCount: 100,
          initialWeightG: 1000,
        })
      ).id;
    for (const [date, feedKg, weight] of [
      ["2024-02-01", 10, 2000],
      ["2024-02-02", 20, 2500],
    ] as const)
      await post("records", {
        organizationId: org,
        unitId: unit,
        recordedOn: date,
        mortality: 0,
        eggs: 0,
        cracked: 0,
        feedKg,
        averageWeightG: weight,
        sampleSize: 10,
        waterQuality: null,
        notes: "Synthetic original actual feed observation",
      });
    const endpoint = `inventory/feed?organizationId=${org}`,
      workspace = async (): Promise<FeedStockWorkspace> =>
        (await page.request.get("/api/" + endpoint)).json(),
      sourcePath = `broilers/lifecycle?organizationId=${org}&unitId=${unit}`,
      snapshot = async () =>
        (await page.request.get("/api/" + sourcePath)).json(),
      original = await snapshot();
    async function movement(data: FeedStockData, date = "2024-02-02") {
      const w = await workspace();
      return post("inventory/feed", {
        organizationId: org,
        eventId: randomUUID(),
        date,
        expectedPosition: w.expectedPosition,
        data,
      });
    }
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.name));
    await page.goto("/");
    await page
      .getByRole("button", { name: "Feed inventory", exact: true })
      .click();
    const region = page.getByRole("region", {
        name: "Feed purchases and consumption",
        exact: true,
      }),
      text = async (name: string, value: string) =>
        region.getByRole("textbox", { name, exact: true }).fill(value),
      select = async (name: string, value: string) =>
        region.getByRole("combobox", { name, exact: true }).selectOption(value),
      activity = region.getByRole("combobox", {
        name: "Feed stock activity",
        exact: true,
      });
    await expect(
      region.getByText("No feed purchase or stock movements recorded.", {
        exact: false,
      }),
    ).toBeVisible();
    const evidence = async () => {
        await text(
          "Feed movement review reason",
          "Synthetic reviewed actual feed stock observation",
        );
        await text(
          "Physical feed and source evidence",
          "Synthetic original physical register and exact actual feed evidence",
        );
      },
      ack = async () =>
        region
          .getByLabel("I confirm the actual owned feed movement", {
            exact: false,
          })
          .check(),
      save = async () => {
        await region
          .getByRole("button", { name: "Save feed movement", exact: true })
          .click();
        await expect(
          region.getByRole("status").filter({ hasText: "Feed movement saved" }),
        ).toBeVisible();
      };
    await region
      .getByLabel("Feed movement date", { exact: true })
      .fill("2024-01-31");
    for (const [name, value] of Object.entries({
      "Purchased feed identity": "=Synthetic purchased feed",
      "Feed supplier": "Synthetic original supplier",
      "Unique feed purchase reference": "SYNTHETIC-BROWSER-FEED",
      "Feed stock location": "Synthetic feed room",
      "Received feed kg": "100",
      "Original purchase currency": "NGN",
    }))
      await text(name, value);
    await region
      .getByLabel("The actual total purchase cost is known", { exact: false })
      .check();
    await text("Actual total lot cost", "300.0001");
    await text(
      "Purchase cost evidence",
      "Synthetic original total invoice and landed-cost treatment, no tax inference",
    );
    await evidence();
    await region
      .getByRole("button", { name: "Preview feed movement", exact: true })
      .click();
    await expect(
      region.getByRole("region", {
        name: "Unsaved feed movement preview",
        exact: true,
      }),
    ).toContainText("300.0001");
    expect((await workspace()).report.events).toHaveLength(0);
    await ack();
    await save();
    const lot = (await workspace()).report.events[0].id;
    await activity.selectOption("consume");
    await select("Purchased feed lot", lot);
    await select("Actual daily feed source", unit + ":2024-02-01");
    await text("Withdrawn feed kg", "3.123456");
    await evidence();
    await ack();
    let lost = false;
    await page.route("**/api/inventory/feed", async (route) => {
      if (route.request().method() === "POST" && !lost) {
        lost = true;
        const r = await route.fetch();
        expect(r.status()).toBe(201);
        await route.abort("failed");
      } else await route.continue();
    });
    await region
      .getByRole("button", { name: "Save feed movement", exact: true })
      .click();
    await expect(
      region.getByRole("button", {
        name: "Retry exact feed receipt",
        exact: true,
      }),
    ).toBeVisible();
    await expect(activity).toBeDisabled();
    await page.reload();
    await page
      .getByRole("button", { name: "Feed inventory", exact: true })
      .click();
    await region
      .getByRole("button", { name: "Retry exact feed receipt", exact: true })
      .click();
    await expect(region.getByRole("status")).toContainText(
      "Original feed receipt confirmed",
    );
    await page.unroute("**/api/inventory/feed");
    let w = await workspace();
    expect(w.report.events).toHaveLength(2);
    const consumed = w.report.events[1];
    expect(consumed).toMatchObject({
      amount: "9.3704",
      weight_kg: "3.123456",
      unit_id: unit,
    });
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM audit_logs WHERE object_id=$1",
          [consumed.id],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(await snapshot()).toEqual(original);
    expect(
      (
        await db.query(
          "SELECT id FROM financial_journal_entries WHERE organization_id=$1",
          [org],
        )
      ).rows,
    ).toEqual([]);
    await activity.selectOption("loss");
    await select("Purchased feed lot", lot);
    await region
      .getByLabel("Feed movement date", { exact: true })
      .fill("2024-02-02");
    await text("Withdrawn feed kg", "2");
    await evidence();
    await ack();
    await movement({
      kind: "loss",
      lotId: lot,
      weightKg: "1",
      reason: "Synthetic competing measured feed loss",
      evidence: "Synthetic original competing stock weight register",
    });
    await region
      .getByRole("button", { name: "Save feed movement", exact: true })
      .click();
    await expect(region.getByRole("alert")).toContainText("Feed stock changed");
    await expect(
      region.getByRole("textbox", { name: "Withdrawn feed kg", exact: true }),
    ).toHaveValue("2");
    let dl = page.waitForEvent("download");
    await region
      .getByRole("button", { name: "Download feed working copy", exact: true })
      .click();
    await (await dl).saveAs(".local/browser-feed-working-copy.json");
    expect(
      JSON.parse(readFileSync(".local/browser-feed-working-copy.json", "utf8"))
        .fields.weightKg,
    ).toBe("2");
    await region
      .getByRole("button", { name: "Reload current feed stock", exact: true })
      .click();
    await expect(region.getByRole("status")).toContainText(
      "Working inputs retained",
    );
    await expect(
      region.getByLabel("I confirm the actual owned feed movement", {
        exact: false,
      }),
    ).not.toBeChecked();
    await ack();
    await save();
    w = await workspace();
    expect(w.report.results.lots[0]).toMatchObject({
      balanceKg: "93.876544",
      consumedValue: "9.3704",
      lostValue: "9.0000",
      remainingValue: "281.6297",
    });
    expect(w.report.results.batches[0]).toMatchObject({
      unitId: unit,
      consumedKg: "3.123456",
      knownConsumedValue: "9.3704",
    });
    const frozen = `/api/${endpoint}&asOf=2024-02-02&throughPosition=${w.expectedPosition}`,
      exactJson = await (
        await page.request.get(frozen + "&format=json")
      ).text(),
      exactCsv = await (await page.request.get(frozen + "&format=csv")).text();
    await post("organizations/settings", {
      organizationId: org,
      name: "Synthetic feed browser",
      currency: "USD",
      timezone: "UTC",
    });
    await movement(
      {
        ...feedReceipt(),
        currency: "USD",
        totalCost: null,
        costEvidence: null,
      },
      "2024-01-31",
    );
    const beforeCorrection = await snapshot();
    await post("broilers/recovery", {
      organizationId: org,
      unitId: unit,
      eventId: randomUUID(),
      date: "2024-02-01",
      expectedPosition: beforeCorrection.summary.expectedPosition,
      expectedDailyId: beforeCorrection.summary.expectedDailyId,
      kind: "daily",
      baseRecordId: beforeCorrection.records[0].base_record_id,
      previousId: null,
      mortality: 0,
      feedKg: "2",
      averageWeightG: "2000",
      sampleSize: 10,
      notes: "Synthetic reviewed lower actual feed observation",
      reason: "Synthetic complete actual daily feed correction",
      evidence: "Synthetic original corrected complete daily feed register",
    });
    expect(await (await page.request.get(frozen + "&format=json")).text()).toBe(
      exactJson,
    );
    expect(await (await page.request.get(frozen + "&format=csv")).text()).toBe(
      exactCsv,
    );
    w = await workspace();
    expect(w.changedSources[0]).toMatchObject({
      feedKg: "2.000000",
      issuedKg: "3.123456",
      overlinkedKg: "1.123456",
      sourceChanged: true,
    });
    expect(w.report.results.currencies).toHaveLength(2);
    await region
      .getByRole("button", { name: "Reload current feed stock", exact: true })
      .click();
    await expect(
      region.getByRole("status").filter({ hasText: "linked daily source(s)" }),
    ).toBeVisible();
    await region
      .getByLabel("Feed stock as-of date", { exact: true })
      .fill("2024-02-02");
    await region
      .getByRole("textbox", {
        name: "Append-position cutoff · blank uses latest",
        exact: true,
      })
      .fill(JSON.parse(exactJson).throughPosition);
    await region
      .getByRole("button", {
        name: "Load feed report and sources",
        exact: true,
      })
      .click();
    await expect(
      region.getByRole("region", {
        name: "Frozen feed stock report",
        exact: true,
      }),
    ).toContainText("4 events.");
    dl = page.waitForEvent("download");
    await region
      .getByRole("button", { name: "Download feed stock JSON", exact: true })
      .click();
    await (await dl).saveAs(".local/browser-feed-stock.json");
    dl = page.waitForEvent("download");
    await region
      .getByRole("button", { name: "Download feed stock CSV", exact: true })
      .click();
    await (await dl).saveAs(".local/browser-feed-stock.csv");
    expect(readFileSync(".local/browser-feed-stock.json", "utf8")).toBe(
      exactJson,
    );
    expect(readFileSync(".local/browser-feed-stock.csv", "utf8")).toBe(
      exactCsv,
    );
    const r = JSON.parse(exactJson),
      { evidenceSha256, ...normalized } = r;
    expect(
      createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
    ).toBe(evidenceSha256);
    expect(exactCsv).toContain("'=Synthetic purchased feed");
    await page.setViewportSize({ width: 390, height: 844 });
    await region
      .getByRole("heading", {
        name: "Feed purchases and consumption",
        exact: true,
      })
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: ".local/browser-feed-stock-mobile.png",
      animations: "disabled",
    });
    await region
      .getByRole("heading", {
        name: "Feed stock and cost reconciliation",
        exact: true,
      })
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.screenshot({
      path: ".local/browser-feed-costs-mobile.png",
      animations: "disabled",
    });
    [auditor, worker] = (
      await db.query(
        "INSERT INTO users(email,password_hash) SELECT x,'fixture' FROM unnest($1::text[]) x RETURNING id",
        [[randomUUID() + "@test.invalid", randomUUID() + "@test.invalid"]],
      )
    ).rows.map((r) => r.id);
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
    await page
      .getByRole("button", { name: "Feed inventory", exact: true })
      .click();
    await expect(
      region.getByRole("heading", {
        name: "Feed stock and cost reconciliation",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      region.getByRole("button", { name: "Save feed movement", exact: true }),
    ).toHaveCount(0);
    await expect(
      region.getByRole("button", {
        name: "Download feed stock JSON",
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
      page.getByRole("button", { name: "Production", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Feed inventory", exact: true }),
    ).toHaveCount(0);
    expect((await page.request.get("/api/" + endpoint)).status()).toBe(403);
    expect(errors).toEqual([]);
  } finally {
    if (org) await db.query("DELETE FROM organizations WHERE id=$1", [org]);
    for (const id of [owner, auditor, worker])
      if (id) await db.query("DELETE FROM users WHERE id=$1", [id]);
    await db.end();
  }
});
