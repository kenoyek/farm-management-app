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
test("reviews corrected feed evidence and late costs with recovery, stale-head preservation and immutable exports", async ({
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
      ).id;
    await movement({
      kind: "loss",
      lotId: lot,
      weightKg: "2",
      reason: "Synthetic actual weighed spoiled feed",
      evidence: "Synthetic original feed loss scale register",
    });
    const stock = await workspace(),
      stockUrl = `/api/${endpoint}&asOf=2024-02-02&throughPosition=${stock.expectedPosition}&format=json`,
      stockBytes = await (await page.request.get(stockUrl)).text(),
      finPath = `finance/journal?organizationId=${org}`,
      fin = async () => (await page.request.get("/api/" + finPath)).json();
    await post("finance/journal", {
      organizationId: org,
      entryId: randomUUID(),
      expectedPosition: "0",
      data: {
        kind: "recognize_feed",
        sourceId: lot,
        purchaseSettlement: "payables",
        consumptionTreatment: null,
        paymentEvidence: null,
        policy: "recorded-feed-lot-value-v1",
        reason: "Synthetic original purchase recognition",
        evidence: "Synthetic original actual invoice and accounting policy",
      },
    });
    async function correct(previousId: string | null, notes: string) {
      const s = await snapshot();
      return post("broilers/recovery", {
        organizationId: org,
        unitId: unit,
        eventId: randomUUID(),
        date: "2024-02-01",
        expectedPosition: s.summary.expectedPosition,
        expectedDailyId: s.summary.expectedDailyId,
        kind: "daily",
        baseRecordId: s.records[0].base_record_id,
        previousId,
        mortality: 0,
        feedKg: "10",
        averageWeightG: "2000",
        sampleSize: 10,
        notes,
        reason: "Synthetic metadata-only complete daily review",
        evidence: "Synthetic corrected complete original daily source",
      });
    }
    expect(await snapshot()).toEqual(original);
    const correction = (
        await correct(null, "Synthetic metadata-only corrected daily evidence")
      ).id,
      reviewPath = `inventory/feed/reviews?organizationId=${org}`,
      reviews = async (extra = "") =>
        (await page.request.get("/api/" + reviewPath + extra)).json(),
      errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.name));
    await page.goto("/");
    await page
      .getByRole("button", { name: "Feed inventory", exact: true })
      .click();
    const region = page.getByRole("region", {
        name: "Feed source and late-cost reviews",
        exact: true,
      }),
      root = page.getByRole("region", {
        name: "Feed purchases and consumption",
        exact: true,
      }),
      text = async (name: string, value: string) =>
        region.getByRole("textbox", { name, exact: true }).fill(value),
      choose = async (kind: string, target: string) => {
        await region
          .getByRole("combobox", { name: "Feed review type", exact: true })
          .selectOption(kind);
        await region
          .getByRole("combobox", { name: "Feed review target", exact: true })
          .selectOption(target);
        await region
          .getByRole("button", {
            name: "Load selected feed evidence",
            exact: true,
          })
          .click();
        await expect(region.getByRole("status")).toContainText(
          "Working inputs retained",
        );
      },
      evidence = async () => {
        await text(
          "Feed review reason",
          "=Synthetic reviewed actual feed evidence",
        );
        await text(
          "Reconciliation review evidence",
          "Synthetic original physical quantity, current daily evidence and exact cost authority",
        );
      },
      ack = async () =>
        region
          .getByLabel("I confirm the actual source evidence", { exact: false })
          .check(),
      save = async () => {
        await region
          .getByRole("button", {
            name: "Save feed reconciliation review",
            exact: true,
          })
          .click();
        await expect(region.getByRole("status")).toContainText(
          "Feed review saved",
        );
      };
    await choose("source", issue);
    await region
      .getByLabel("Feed review date", { exact: true })
      .fill("2024-02-03");
    await evidence();
    await region
      .getByRole("button", { name: "Preview feed review", exact: true })
      .click();
    await expect(
      region.getByRole("region", {
        name: "Unsaved feed review preview",
        exact: true,
      }),
    ).toContainText("3.123456");
    expect((await reviews()).history).toHaveLength(0);
    await ack();
    let lostResponse = false;
    await page.route("**/api/inventory/feed/reviews", async (route) => {
      if (route.request().method() === "POST" && !lostResponse) {
        lostResponse = true;
        const r = await route.fetch();
        expect(r.status()).toBe(201);
        await route.abort("failed");
      } else await route.continue();
    });
    await region
      .getByRole("button", {
        name: "Save feed reconciliation review",
        exact: true,
      })
      .click();
    await expect(
      region.getByRole("button", {
        name: "Retry exact feed review receipt",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      root.getByRole("combobox", { name: "Feed stock activity", exact: true }),
    ).toBeDisabled();
    await page.reload();
    await page
      .getByRole("button", { name: "Feed inventory", exact: true })
      .click();
    await region
      .getByRole("button", {
        name: "Retry exact feed review receipt",
        exact: true,
      })
      .click();
    await expect(region.getByRole("status")).toContainText(
      "Original feed review confirmed",
    );
    await page.unroute("**/api/inventory/feed/reviews");
    let w = await reviews("&kind=source&targetId=" + issue);
    const sourceId = w.report.review.id;
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM audit_logs WHERE object_id=$1",
          [sourceId],
        )
      ).rows[0].n,
    ).toBe(1);
    expect((await workspace()).changedSources).toHaveLength(0);
    expect(await (await page.request.get(stockUrl)).text()).toBe(stockBytes);
    let f = await fin();
    await post("finance/journal", {
      organizationId: org,
      entryId: randomUUID(),
      expectedPosition: f.expectedPosition,
      data: {
        kind: "recognize_feed",
        sourceId: issue,
        purchaseSettlement: null,
        consumptionTreatment: "expense",
        paymentEvidence: null,
        policy: "recorded-feed-lot-value-v1",
        reason: "Synthetic reviewed current source recognition",
        evidence: "Synthetic approved same-quantity source review",
      },
    });
    f = await fin();
    expect(f.report.entries.at(-1).source_snapshot.sourceReview.id).toBe(
      sourceId,
    );
    const journalFrozen = `/api/${finPath}&format=json&asOf=${f.report.asOf}&throughPosition=${f.expectedPosition}`,
      journalBytes = await (await page.request.get(journalFrozen)).text();
    await choose("cost", lot);
    await region
      .getByLabel("Feed review date", { exact: true })
      .fill("2024-02-03");
    await text("Full revised actual lot cost", "330");
    await text(
      "Revised purchase cost evidence",
      "=Synthetic final actual invoice with explicit landed cost boundary",
    );
    await evidence();
    await region
      .getByRole("button", { name: "Preview feed review", exact: true })
      .click();
    await expect(
      region.getByRole("region", {
        name: "Unsaved feed review preview",
        exact: true,
      }),
    ).toContainText("313.0926");
    await ack();
    w = await reviews("&kind=cost&targetId=" + lot);
    await post("inventory/feed/reviews", {
      organizationId: org,
      reviewId: randomUUID(),
      date: "2024-02-03",
      expectedStockPosition: w.expectedStockPosition,
      expectedReviewPosition: w.expectedReviewPosition,
      expectedSourceSha256: w.selected.sourceSha256,
      data: {
        kind: "cost",
        targetId: lot,
        previousId: w.selected.latestId,
        totalCost: "340",
        costEvidence: "Synthetic competing final invoice authority",
        policy: "reviewed-specific-lot-cost-v1",
        scope: "actual-purchase-cost-revision",
        reason: "Synthetic other-tab full actual cost review",
        evidence: "Synthetic other-tab complete cost evidence",
      },
    });
    await region
      .getByRole("button", {
        name: "Save feed reconciliation review",
        exact: true,
      })
      .click();
    await expect(region.getByRole("alert")).toContainText(
      "head or source evidence changed",
    );
    await expect(
      region.getByRole("textbox", {
        name: "Full revised actual lot cost",
        exact: true,
      }),
    ).toHaveValue("330");
    let dl = page.waitForEvent("download");
    await region
      .getByRole("button", {
        name: "Download feed review working copy",
        exact: true,
      })
      .click();
    await (await dl).saveAs(".local/browser-feed-review-working.json");
    expect(
      JSON.parse(
        readFileSync(".local/browser-feed-review-working.json", "utf8"),
      ).totalCost,
    ).toBe("330");
    await region
      .getByRole("button", { name: "Reload feed review evidence", exact: true })
      .click();
    await expect(region.getByRole("status")).toContainText(
      "Working inputs retained",
    );
    await expect(
      region.getByLabel("I confirm the actual source evidence", {
        exact: false,
      }),
    ).not.toBeChecked();
    await ack();
    await save();
    w = await reviews("&kind=cost&targetId=" + lot);
    const costId = w.report.review.id;
    expect(w.report.review.revision).toBe(2);
    expect(w.report.results).toMatchObject({
      reviewedTotalCost: "330.0000",
      reviewedConsumedValue: "10.3074",
      reviewedLostValue: "6.6000",
      reviewedRemainingValue: "313.0926",
      totalDelta: "29.9999",
    });
    expect(await (await page.request.get(journalFrozen)).text()).toBe(
      journalBytes,
    );
    expect(await (await page.request.get(stockUrl)).text()).toBe(stockBytes);
    dl = page.waitForEvent("download");
    await region
      .getByRole("button", { name: "Download feed review JSON", exact: true })
      .click();
    await (await dl).saveAs(".local/browser-feed-review-cost.json");
    dl = page.waitForEvent("download");
    await region
      .getByRole("button", { name: "Download feed review CSV", exact: true })
      .click();
    await (await dl).saveAs(".local/browser-feed-review-cost.csv");
    const json = readFileSync(".local/browser-feed-review-cost.json", "utf8"),
      csv = readFileSync(".local/browser-feed-review-cost.csv", "utf8"),
      r = JSON.parse(json),
      { evidenceSha256, ...normalized } = r;
    expect(
      createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
    ).toBe(evidenceSha256);
    expect(csv).toContain("'=Synthetic reviewed actual feed evidence");
    await movement(
      {
        kind: "loss",
        lotId: lot,
        weightKg: "1",
        reason: "Synthetic later actual feed loss",
        evidence: "Synthetic original later loss scale record",
      },
      "2024-02-04",
    );
    await post("organizations/settings", {
      organizationId: org,
      name: "Synthetic feed browser",
      currency: "USD",
      timezone: "UTC",
    });
    await correct(
      correction,
      "Synthetic another complete metadata-only daily review",
    );
    await region
      .getByRole("button", { name: "Reload feed review evidence", exact: true })
      .click();
    await expect(
      region.getByRole("region", {
        name: "Saved feed reconciliation review",
        exact: true,
      }),
    ).toContainText("Historical review: source changed");
    expect(
      await (
        await page.request.get(
          `/api/${reviewPath}&reviewId=${costId}&format=json`,
        )
      ).text(),
    ).toBe(json);
    expect(
      await (
        await page.request.get(
          `/api/${reviewPath}&reviewId=${costId}&format=csv`,
        )
      ).text(),
    ).toBe(csv);
    expect(await (await page.request.get(journalFrozen)).text()).toBe(
      journalBytes,
    );
    expect(
      (await reviews("&kind=source&targetId=" + issue)).sourceCurrent,
    ).toBe(false);
    const sourceJson = await page.request.get(
        `/api/${reviewPath}&reviewId=${sourceId}&format=json`,
      ),
      sourceCsv = await page.request.get(
        `/api/${reviewPath}&reviewId=${sourceId}&format=csv`,
      );
    await sourceJson
      .body()
      .then((b) =>
        import("node:fs").then((fs) =>
          fs.writeFileSync(".local/browser-feed-review-source.json", b),
        ),
      );
    await sourceCsv
      .body()
      .then((b) =>
        import("node:fs").then((fs) =>
          fs.writeFileSync(".local/browser-feed-review-source.csv", b),
        ),
      );
    await page.setViewportSize({ width: 390, height: 844 });
    await region
      .getByRole("heading", {
        name: "Feed source and late-cost reviews",
        exact: true,
      })
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    const geometry = await page.evaluate(() => ({
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
      overflow: [...document.querySelectorAll("main *")]
        .filter(
          (e) =>
            e.getBoundingClientRect().right > innerWidth + 1 &&
            !e.closest(".table-scroll"),
        )
        .map((e) => ({
          tag: e.tagName,
          class: e.className,
          right: e.getBoundingClientRect().right,
          text: e.textContent?.slice(0, 100),
        })),
    }));
    await page.screenshot({
      path: ".local/feed-review-width.png",
      animations: "disabled",
    });
    expect(geometry.scroll, JSON.stringify(geometry)).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: ".local/browser-feed-review-mobile.png",
      animations: "disabled",
    });
    await region
      .getByRole("heading", {
        name: "Saved feed reconciliation review · version 2",
        exact: true,
      })
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.screenshot({
      path: ".local/browser-feed-review-results-mobile.png",
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
    await region
      .getByRole("combobox", { name: "Saved feed review", exact: true })
      .selectOption(costId);
    await region
      .getByRole("button", { name: "Load saved feed review", exact: true })
      .click();
    await expect(
      region.getByRole("heading", {
        name: "Saved feed reconciliation review · version 2",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      region.getByRole("button", {
        name: "Save feed reconciliation review",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      region.getByRole("button", {
        name: "Download feed review JSON",
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
    expect((await page.request.get("/api/" + reviewPath)).status()).toBe(403);
    expect(errors).toEqual([]);
  } finally {
    if (org) await db.query("DELETE FROM organizations WHERE id=$1", [org]);
    for (const id of [owner, auditor, worker])
      if (id) await db.query("DELETE FROM users WHERE id=$1", [id]);
    await db.end();
  }
});
