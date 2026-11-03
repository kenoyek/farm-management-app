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
test("posts reviewed feed cost differences with exact retry, stale recovery, latest-first reversals and frozen evidence", async ({
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
    const review = await costReview("330");
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

    async function choose(reviewId: string) {
      await activity.selectOption("recognize_feed_cost");
      await select("Reviewed feed cost authority", reviewId);
      await select("Cost difference settlement", "payables");
      await select("Previously unbooked consumption treatment", "expense");
      await evidence();
    }
    await choose(review);
    await region
      .getByRole("button", { name: "Preview journal entry", exact: true })
      .click();
    const basis = region.getByRole("region", {
      name: "Unsaved reviewed-cost basis",
      exact: true,
    });
    await expect(basis).toContainText("29.9999");
    await expect(basis).toContainText("consume · 1300");
    expect((await fin()).report.entries).toHaveLength(3);
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
    expect(w.report.entries).toHaveLength(4);
    const first = w.report.entries.find(
      (e: { kind: string }) => e.kind === "recognize_feed_cost",
    ).id;
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM audit_logs WHERE object_id=$1",
          [first],
        )
      ).rows[0].n,
    ).toBe(1);
    const secondReview = await costReview("360");
    await region
      .getByRole("button", { name: "Reload current journal", exact: true })
      .click();
    await choose(secondReview);
    await region
      .getByRole("button", { name: "Preview journal entry", exact: true })
      .click();
    await expect(basis).toContainText("purchase difference 30.0000");
    await ack();
    await accounting({
      kind: "manual",
      date: "2024-02-01",
      currency: "NGN",
      unitId: null,
      purpose: "opening_balance",
      reference: "SYNTHETIC-OTHER-TAB",
      description: "Synthetic evidenced other-tab opening balance",
      lines: [
        { account: "1000", side: "debit", amount: "7" },
        { account: "3000", side: "credit", amount: "7" },
      ],
      scope: "evidenced-manual-book-entry",
      reason: "Synthetic competing book entry",
      evidence: "Synthetic complete bank and equity authority",
    });
    await region
      .getByRole("button", { name: "Post balanced journal entry", exact: true })
      .click();
    await expect(region.getByRole("alert")).toContainText("journal changed");
    await expect(
      region.getByRole("combobox", {
        name: "Reviewed feed cost authority",
        exact: true,
      }),
    ).toHaveValue(secondReview);
    const dl = page.waitForEvent("download");
    await region
      .getByRole("button", {
        name: "Download journal working copy",
        exact: true,
      })
      .click();
    await (await dl).saveAs(".local/browser-feed-cost-post-working.json");
    expect(
      JSON.parse(
        readFileSync(".local/browser-feed-cost-post-working.json", "utf8"),
      ).costReview,
    ).toBe(secondReview);
    await region
      .getByRole("button", { name: "Reload current journal", exact: true })
      .click();
    await expect(
      region.getByLabel("I confirm the accounting evidence", { exact: false }),
    ).not.toBeChecked();
    await expect(basis).toHaveCount(0);
    await ack();
    await save();
    w = await fin();
    const second = w.report.entries
      .filter((e: { kind: string }) => e.kind === "recognize_feed_cost")
      .at(-1).id;
    expect(
      w.report.entries.find((e: { id: string }) => e.id === second)
        .source_snapshot,
    ).toMatchObject({ purchaseDelta: "30.0000", parentPostingId: first });
    await activity.selectOption("reverse");
    await select("Original accounting entry", first);
    await region
      .getByLabel("Reversal accounting date", { exact: true })
      .fill("2024-02-04");
    await evidence();
    await ack();
    await region
      .getByRole("button", { name: "Post balanced journal entry", exact: true })
      .click();
    await expect(region.getByRole("alert")).toContainText(
      "Reverse newer reviewed-cost postings first",
    );
    await select("Original accounting entry", second);
    await region
      .getByLabel("Reversal accounting date", { exact: true })
      .fill("2024-02-05");
    await evidence();
    await ack();
    await save();
    await select("Original accounting entry", first);
    await region
      .getByLabel("Reversal accounting date", { exact: true })
      .fill("2024-02-04");
    await evidence();
    await ack();
    await region
      .getByRole("button", { name: "Post balanced journal entry", exact: true })
      .click();
    await expect(region.getByRole("alert")).toContainText(
      "dependent reversal dates",
    );
    await region
      .getByLabel("Reversal accounting date", { exact: true })
      .fill("2024-02-05");
    await ack();
    await save();
    expect(await (await page.request.get(stockUrl)).text()).toBe(stockBytes);
    expect(await snapshot()).toEqual(original);
    expect(await (await page.request.get(frozen + "&format=json")).text()).toBe(
      oldJson,
    );
    expect(await (await page.request.get(frozen + "&format=csv")).text()).toBe(
      oldCsv,
    );
    await choose(secondReview);
    await region
      .getByRole("button", { name: "Preview journal entry", exact: true })
      .click();
    await expect(region.getByRole("alert")).toContainText("must not precede");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: ".local/browser-feed-cost-post-mobile.png",
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
