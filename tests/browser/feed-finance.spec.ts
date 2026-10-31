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
test("recognizes feed purchases, WIP consumption and losses with safe retry, dependencies and frozen financial evidence", async ({
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
    const source = (await workspace()).sources.find(
        (s) => s.unitId === unit && s.date === "2024-02-01",
      )!,
      lot = (await movement(feedReceipt(), "2024-01-31")).id,
      issue = (
        await movement(
          {
            kind: "consume",
            lotId: lot,
            unitId: unit,
            weightKg: "3.123456",
            expectedSourceSha256: source.sourceSha256,
            scope: "actual-recorded-feed-consumption",
            reason: "Synthetic actual selected lot consumption",
            evidence: "Synthetic exact actual daily source and selected lot",
          },
          "2024-02-01",
        )
      ).id,
      lost = (
        await movement(
          {
            kind: "loss",
            lotId: lot,
            weightKg: "2",
            reason: "Synthetic actual weighed spoiled feed",
            evidence: "Synthetic original feed loss scale record",
          },
          "2024-02-02",
        )
      ).id;
    const stock = await workspace(),
      stockUrl = `/api/${endpoint}&asOf=2024-02-02&throughPosition=${stock.expectedPosition}&format=json`,
      stockBytes = await (await page.request.get(stockUrl)).text(),
      journalPath = `finance/journal?organizationId=${org}`,
      fin = async () => (await page.request.get("/api/" + journalPath)).json();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.name));
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
      select = async (name: string, value: string) =>
        region.getByRole("combobox", { name, exact: true }).selectOption(value),
      text = async (name: string, value: string) =>
        region.getByRole("textbox", { name, exact: true }).fill(value),
      evidence = async () => {
        await text(
          "Accounting review reason",
          "Synthetic original feed financial recognition",
        );
        await text(
          "Accounting source and recognition evidence",
          "Synthetic original purchase cost and explicit accounting treatment; no duplicated manual book entry",
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
        await expect(
          region
            .getByRole("status")
            .filter({ hasText: "Journal entry posted" }),
        ).toBeVisible();
      };
    await activity.selectOption("recognize_feed");
    const picker = region.getByRole("combobox", {
      name: "Recorded feed movement",
      exact: true,
    });
    await expect(picker.locator(`option[value="${issue}"]`)).toHaveJSProperty(
      "disabled",
      true,
    );
    await select("Recorded feed movement", lot);
    await select("Feed purchase settlement", "payables");
    await evidence();
    await region
      .getByRole("button", { name: "Preview journal entry", exact: true })
      .click();
    await expect(
      region.getByRole("region", {
        name: "Unsaved journal preview",
        exact: true,
      }),
    ).toContainText("300.0001");
    expect((await fin()).report.entries).toHaveLength(0);
    await ack();
    let responseLost = false;
    await page.route("**/api/finance/journal", async (route) => {
      if (route.request().method() === "POST" && !responseLost) {
        responseLost = true;
        const r = await route.fetch();
        expect(r.status()).toBe(201);
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
    let w = await fin();
    const parent = w.report.entries[0].id;
    expect(w.report.entries).toHaveLength(1);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM audit_logs WHERE object_id=$1",
          [parent],
        )
      ).rows[0].n,
    ).toBe(1);
    const blocked = await page.request.post("/api/inventory/feed", {
      headers,
      data: {
        organizationId: org,
        eventId: randomUUID(),
        date: "2024-02-02",
        expectedPosition: (await workspace()).expectedPosition,
        data: {
          kind: "void",
          voidOfId: lot,
          reason: "Synthetic erroneous receipt did not occur",
          evidence: "Synthetic original correction evidence",
        },
      },
    });
    expect(blocked.status()).toBe(409);
    await activity.selectOption("recognize_feed");
    await select("Recorded feed movement", issue);
    await select("Consumed-feed accounting treatment", "work_in_progress");
    await evidence();
    await ack();
    await save();
    w = await fin();
    const child = w.report.entries.find(
      (e: { source_id: string }) => e.source_id === issue,
    ).id;
    expect(
      w.report.entries.find((e: { id: string }) => e.id === child).lines[0],
    ).toEqual({ account: "1300", side: "debit", amount: "9.3704" });
    await select("Recorded feed movement", lost);
    await evidence();
    await ack();
    w = await fin();
    await post("finance/journal", {
      organizationId: org,
      entryId: randomUUID(),
      expectedPosition: w.expectedPosition,
      data: {
        kind: "manual",
        date: "2024-02-01",
        currency: "NGN",
        unitId: null,
        purpose: "opening_balance",
        reference: "SYNTHETIC-COMPETING-HEAD",
        description: "Synthetic other-tab evidenced opening balance",
        lines: [
          { account: "1000", side: "debit", amount: "7" },
          { account: "3000", side: "credit", amount: "7" },
        ],
        scope: "evidenced-manual-book-entry",
        reason: "Synthetic other-tab opening book entry",
        evidence: "Synthetic original bank/equity source",
      },
    });
    await region
      .getByRole("button", { name: "Post balanced journal entry", exact: true })
      .click();
    await expect(region.getByRole("alert")).toContainText("journal changed");
    await expect(picker).toHaveValue(lost);
    let dl = page.waitForEvent("download");
    await region
      .getByRole("button", {
        name: "Download journal working copy",
        exact: true,
      })
      .click();
    await (await dl).saveAs(".local/browser-feed-finance-working.json");
    expect(
      JSON.parse(
        readFileSync(".local/browser-feed-finance-working.json", "utf8"),
      ).feedSource.source_id,
    ).toBe(lost);
    await region
      .getByRole("button", { name: "Reload current journal", exact: true })
      .click();
    await expect(region.getByRole("status")).toContainText(
      "Working inputs retained",
    );
    await expect(
      region.getByLabel("I confirm the accounting evidence", { exact: false }),
    ).not.toBeChecked();
    await ack();
    await save();
    w = await fin();
    const lossBook = w.report.entries.find(
      (e: { source_id: string }) => e.source_id === lost,
    ).id;
    expect(w.report.trialBalance[0]).toMatchObject({
      debits: "322.3705",
      credits: "322.3705",
    });
    expect(await (await page.request.get(stockUrl)).text()).toBe(stockBytes);
    expect(await snapshot()).toEqual(original);
    const frozen = `/api/${journalPath}&asOf=2024-02-02&throughPosition=${w.expectedPosition}`,
      json = await (await page.request.get(frozen + "&format=json")).text(),
      csv = await (await page.request.get(frozen + "&format=csv")).text();
    await activity.selectOption("reverse");
    await select("Original accounting entry", parent);
    await region
      .getByLabel("Reversal accounting date", { exact: true })
      .fill("2024-02-03");
    await evidence();
    await ack();
    await region
      .getByRole("button", { name: "Post balanced journal entry", exact: true })
      .click();
    await expect(region.getByRole("alert")).toContainText(
      "Reverse dependent feed",
    );
    await select("Original accounting entry", child);
    await region
      .getByLabel("Reversal accounting date", { exact: true })
      .fill("2024-02-03");
    await evidence();
    await ack();
    const beforeReversal = await workspace();
    await save();
    expect((await workspace()).report).toEqual(beforeReversal.report);
    await movement(
      {
        kind: "void",
        voidOfId: issue,
        reason: "Synthetic erroneous consumption did not occur",
        evidence: "Synthetic original physical correction evidence",
      },
      "2024-02-03",
    );
    await select("Original accounting entry", lossBook);
    await region
      .getByLabel("Reversal accounting date", { exact: true })
      .fill("2024-02-04");
    await evidence();
    await ack();
    await save();
    await movement(
      {
        kind: "void",
        voidOfId: lost,
        reason: "Synthetic erroneous loss did not occur",
        evidence: "Synthetic original loss correction evidence",
      },
      "2024-02-04",
    );
    await select("Original accounting entry", parent);
    await region
      .getByLabel("Reversal accounting date", { exact: true })
      .fill("2024-02-03");
    await evidence();
    await ack();
    await region
      .getByRole("button", { name: "Post balanced journal entry", exact: true })
      .click();
    await expect(region.getByRole("alert")).toContainText(
      "purchase reversal date",
    );
    await region
      .getByLabel("Reversal accounting date", { exact: true })
      .fill("2024-02-04");
    await ack();
    await save();
    await movement(
      {
        kind: "void",
        voidOfId: lot,
        reason: "Synthetic erroneous owned receipt did not occur",
        evidence: "Synthetic original physical receipt correction evidence",
      },
      "2024-02-04",
    );
    expect((await workspace()).report.results.lots[0].active).toBe(false);
    expect(await snapshot()).toEqual(original);
    await post("organizations/settings", {
      organizationId: org,
      name: "Synthetic feed browser",
      currency: "USD",
      timezone: "UTC",
    });
    w = await fin();
    await post("finance/journal", {
      organizationId: org,
      entryId: randomUUID(),
      expectedPosition: w.expectedPosition,
      data: {
        kind: "manual",
        date: "2024-01-31",
        currency: "USD",
        unitId: null,
        purpose: "opening_balance",
        reference: "SYNTHETIC-BACKDATED-FEED-FINANCE",
        description: "Synthetic separate USD original opening balance",
        lines: [
          { account: "1000", side: "debit", amount: "2.5" },
          { account: "3000", side: "credit", amount: "2.5" },
        ],
        scope: "evidenced-manual-book-entry",
        reason: "Synthetic original backdated USD opening balance",
        evidence: "Synthetic original foreign-currency bank/equity source",
      },
    });
    expect(await (await page.request.get(frozen + "&format=json")).text()).toBe(
      json,
    );
    expect(await (await page.request.get(frozen + "&format=csv")).text()).toBe(
      csv,
    );
    expect(await (await page.request.get(stockUrl)).text()).toBe(stockBytes);
    await region
      .getByLabel("Journal as-of date", { exact: true })
      .fill("2024-02-02");
    await region
      .getByRole("textbox", {
        name: "Append-position cutoff · blank uses latest",
        exact: true,
      })
      .fill(JSON.parse(json).throughPosition);
    await region
      .getByRole("button", { name: "Load journal view", exact: true })
      .click();
    await expect(
      region.getByRole("region", { name: "Posted trial balance", exact: true }),
    ).toContainText("4 included entries");
    dl = page.waitForEvent("download");
    await region
      .getByRole("button", { name: "Download journal JSON", exact: true })
      .click();
    await (await dl).saveAs(".local/browser-feed-finance.json");
    dl = page.waitForEvent("download");
    await region
      .getByRole("button", { name: "Download journal CSV", exact: true })
      .click();
    await (await dl).saveAs(".local/browser-feed-finance.csv");
    expect(readFileSync(".local/browser-feed-finance.json", "utf8")).toBe(json);
    expect(readFileSync(".local/browser-feed-finance.csv", "utf8")).toBe(csv);
    const r = JSON.parse(json),
      { evidenceSha256, ...normalized } = r;
    expect(
      createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
    ).toBe(evidenceSha256);
    await page.setViewportSize({ width: 390, height: 844 });
    await region
      .getByRole("heading", {
        name: "Financial journal and trial balance",
        exact: true,
      })
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: ".local/browser-feed-finance-mobile.png",
      animations: "disabled",
    });
    await region
      .getByRole("heading", { name: "Posted trial balance", exact: true })
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.screenshot({
      path: ".local/browser-feed-finance-results-mobile.png",
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
      page.getByRole("button", { name: "Production", exact: true }),
    ).toBeVisible();
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
