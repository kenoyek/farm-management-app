import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import pg from "pg";
import { feedReceipt } from "../feed-stock-fixture";
import type {
  FeedStockWorkspace,
  FeedStockData,
} from "../../src/lib/feed-stock";
config({ path: ".env.local", quiet: true });
test("returns actual unused feed to suppliers with recovery, stale stock protection and explicit return-aware finance", async ({
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

    async function accounting(data: unknown) {
      return post("finance/journal", {
        organizationId: org,
        entryId: randomUUID(),
        expectedPosition: (await fin()).expectedPosition,
        data,
      });
    }
    for (const [sourceId, purchaseSettlement, consumptionTreatment] of [
      [lot, "payables", null],
      [issue, null, "work_in_progress"],
      [lost, null, null],
    ])
      await accounting({
        kind: "recognize_feed",
        sourceId,
        purchaseSettlement,
        consumptionTreatment,
        paymentEvidence: null,
        policy: "recorded-feed-lot-value-v1",
        reason: "Synthetic original linked feed recognition",
        evidence:
          "Synthetic complete original actual invoice and selected source",
      });
    const frozen = `/api/${journalPath}&asOf=2024-02-02&throughPosition=${(await fin()).expectedPosition}`,
      oldJson = await (await page.request.get(frozen + "&format=json")).text(),
      oldCsv = await (await page.request.get(frozen + "&format=csv")).text();
    async function costReview(totalCost: string) {
      const w = await (
          await page.request.get(
            `/api/inventory/feed/reviews?organizationId=${org}&kind=cost&targetId=${lot}`,
          )
        ).json(),
        reviewId = randomUUID();
      await post("inventory/feed/reviews", {
        organizationId: org,
        reviewId,
        date: "2024-02-03",
        expectedStockPosition: w.expectedStockPosition,
        expectedReviewPosition: w.expectedReviewPosition,
        expectedSourceSha256: w.selected.sourceSha256,
        data: {
          kind: "cost",
          targetId: lot,
          previousId: w.selected.latestId,
          totalCost,
          costEvidence:
            "Synthetic final complete invoice and landed-cost authority",
          policy: "reviewed-specific-lot-cost-v1",
          scope: "actual-purchase-cost-revision",
          reason: "Synthetic reviewed complete feed cost",
          evidence: "Synthetic actual cost revision evidence",
        },
      });
      return reviewId;
    }

    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.name));
    await page.goto("/");
    await page
      .getByRole("button", { name: "Feed inventory", exact: true })
      .click();
    const stockRegion = page.getByRole("region", {
        name: "Feed purchases and consumption",
        exact: true,
      }),
      stockSelect = (name: string, value: string) =>
        stockRegion
          .getByRole("combobox", { name, exact: true })
          .selectOption(value),
      stockText = (name: string, value: string) =>
        stockRegion.getByRole("textbox", { name, exact: true }).fill(value),
      stockAck = () =>
        stockRegion
          .getByLabel("I confirm the actual owned feed movement", {
            exact: false,
          })
          .check();
    const reference = "SYNTHETIC-BROWSER-RETURN-" + randomUUID();
    async function returnInputs(ref: string, kg: string) {
      await stockSelect("Feed stock activity", "supplier_return");
      await stockRegion
        .getByLabel("Feed movement date", { exact: true })
        .fill("2024-02-03");
      await stockSelect("Purchased feed lot", lot);
      await stockText("Withdrawn feed kg", kg);
      await stockText("Supplier return reference", ref);
      await stockText(
        "Supplier handover and acceptance evidence",
        "Synthetic original supplier signed unused-feed handover and exact scale weight",
      );
      await stockText(
        "Feed movement review reason",
        "Synthetic actual unused stock returned to original supplier",
      );
      await stockText(
        "Physical feed and source evidence",
        "Synthetic dispatch and unused-feed weights; original daily consumption unchanged",
      );
    }
    await returnInputs(reference, "10");
    await stockRegion
      .getByRole("button", { name: "Preview feed movement", exact: true })
      .click();
    await expect(
      stockRegion.getByRole("region", {
        name: "Unsaved feed movement preview",
        exact: true,
      }),
    ).toContainText("Actual supplier return");
    expect((await workspace()).report.events).toHaveLength(3);
    expect((await fin()).report.entries).toHaveLength(3);
    await stockAck();
    let lostResponse = false;
    await page.route("**/api/inventory/feed", async (route) => {
      if (route.request().method() === "POST" && !lostResponse) {
        lostResponse = true;
        const r = await route.fetch();
        expect(r.status()).toBe(201);
        await route.abort("failed");
      } else await route.continue();
    });
    await stockRegion
      .getByRole("button", { name: "Save feed movement", exact: true })
      .click();
    await expect(
      stockRegion.getByRole("button", {
        name: "Retry exact feed receipt",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      stockRegion.getByRole("combobox", {
        name: "Feed stock activity",
        exact: true,
      }),
    ).toBeDisabled();
    await page.reload();
    await page
      .getByRole("button", { name: "Feed inventory", exact: true })
      .click();
    await stockRegion
      .getByRole("button", { name: "Retry exact feed receipt", exact: true })
      .click();
    await expect(
      stockRegion
        .getByRole("status")
        .filter({ hasText: "Original feed receipt confirmed" }),
    ).toBeVisible();
    await page.unroute("**/api/inventory/feed");
    const returned = (await workspace()).report.events.find(
      (e) => e.kind === "supplier_return",
    )!.id;
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM audit_logs WHERE object_id=$1",
          [returned],
        )
      ).rows[0].n,
    ).toBe(1);
    await returnInputs(reference + "-SECOND", "2");
    await stockAck();
    await movement(
      {
        kind: "loss",
        lotId: lot,
        weightKg: "1",
        reason: "Synthetic separately weighed stock loss",
        evidence: "Synthetic competing-tab spoilage weight",
      },
      "2024-02-03",
    );
    await stockRegion
      .getByRole("button", { name: "Save feed movement", exact: true })
      .click();
    await expect(stockRegion.getByRole("alert")).toContainText(
      "Feed stock changed",
    );
    await expect(
      stockRegion.getByRole("textbox", {
        name: "Supplier return reference",
        exact: true,
      }),
    ).toHaveValue(reference + "-SECOND");
    const draft = page.waitForEvent("download");
    await stockRegion
      .getByRole("button", { name: "Download feed working copy", exact: true })
      .click();
    await (await draft).saveAs(".local/browser-feed-return-working.json");
    await stockRegion
      .getByRole("button", { name: "Reload current feed stock", exact: true })
      .click();
    await expect(
      stockRegion
        .getByRole("status")
        .filter({ hasText: "Working inputs retained" }),
    ).toBeVisible();
    await expect(
      stockRegion.getByLabel("I confirm the actual owned feed movement", {
        exact: false,
      }),
    ).not.toBeChecked();
    await stockAck();
    await stockRegion
      .getByRole("button", { name: "Save feed movement", exact: true })
      .click();
    await expect(
      stockRegion
        .getByRole("status")
        .filter({ hasText: "Feed movement saved" }),
    ).toBeVisible();
    expect((await workspace()).report.results.lots[0]).toMatchObject({
      returnedKg: "12.000000",
      consumedKg: "3.123456",
      lostKg: "3.000000",
      balanceKg: "81.876544",
    });
    expect(await snapshot()).toEqual(original);
    expect(await (await page.request.get(stockUrl)).text()).toBe(stockBytes);
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
    await select("Recorded feed movement", returned);
    await select("Supplier-return settlement", "cash_bank");
    await text(
      "Supplier-return refund evidence",
      "Synthetic received refund exactly at original carrying value; no bank execution",
    );
    await evidence();
    await region
      .getByRole("button", { name: "Preview journal entry", exact: true })
      .click();
    await expect(
      region.getByRole("region", {
        name: "Unsaved journal preview",
        exact: true,
      }),
    ).toContainText("30.0000");
    await ack();
    await save();
    const review = await costReview("330");
    await region
      .getByRole("button", { name: "Reload current journal", exact: true })
      .click();
    await activity.selectOption("recognize_feed_cost");
    await select("Reviewed feed cost authority", review);
    await select("Cost difference settlement", "payables");
    await select("Previously unbooked supplier-return settlement", "payables");
    await text(
      "Supplier-return accounting evidence",
      "Synthetic complete revised supplier credit/refund book authority for all return adjustments",
    );
    await select("Previously unbooked consumption treatment", "expense");
    await evidence();
    await region
      .getByRole("button", { name: "Preview journal entry", exact: true })
      .click();
    await expect(
      region.getByRole("region", {
        name: "Unsaved reviewed-cost basis",
        exact: true,
      }),
    ).toContainText("supplier return · 1000");
    await ack();
    await save();
    const adjusted = await fin(),
      entry = adjusted.report.entries
        .filter((e: { kind: string }) => e.kind === "recognize_feed_cost")
        .at(-1);
    expect(entry.source_snapshot).toMatchObject({
      policy: "reviewed-feed-cost-ledger-v2",
      purchaseDelta: "29.9999",
    });
    expect(
      entry.source_snapshot.components
        .filter((c: { kind: string }) => c.kind === "supplier_return")
        .map((c: { account: string }) => c.account),
    ).toEqual(["1000", "2000"]);
    expect(await (await page.request.get(frozen + "&format=json")).text()).toBe(
      oldJson,
    );
    expect(await (await page.request.get(frozen + "&format=csv")).text()).toBe(
      oldCsv,
    );
    expect(await snapshot()).toEqual(original);
    const next = await costReview("360");
    await region
      .getByRole("button", { name: "Reload current journal", exact: true })
      .click();
    await select("Reviewed feed cost authority", next);
    await select("Cost difference settlement", "payables");
    await select("Previously unbooked supplier-return settlement", "payables");
    await text(
      "Supplier-return accounting evidence",
      "Synthetic later full supplier credit/refund adjustment authority",
    );
    await select("Previously unbooked consumption treatment", "expense");
    await evidence();
    await region
      .getByRole("button", { name: "Preview journal entry", exact: true })
      .click();
    await expect(
      region.getByRole("region", {
        name: "Unsaved reviewed-cost basis",
        exact: true,
      }),
    ).toContainText("purchase difference 30.0000");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: ".local/browser-feed-return-finance-mobile.png",
      animations: "disabled",
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page
      .getByRole("button", { name: "Feed inventory", exact: true })
      .click();
    await returnInputs(reference + "-UNSAVED", "1");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: ".local/browser-feed-return-stock-mobile.png",
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
