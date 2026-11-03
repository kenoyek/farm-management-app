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
test("records weighed stocktakes with recovery, manager shortage approval and preserved financial count proof", async ({
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
    const cw = async () =>
      (
        await page.request.get(
          `/api/inventory/feed/counts?organizationId=${org}&lotId=${lot}`,
        )
      ).json();
    async function peer(kg: string) {
      const w = await cw(),
        id = randomUUID();
      await post("inventory/feed/counts", {
        organizationId: org,
        eventId: id,
        expectedStockPosition: w.expectedStockPosition,
        expectedCountPosition: w.expectedCountPosition,
        expectedSourceSha256: w.selected.sourceSha256,
        data: {
          kind: "count",
          lotId: lot,
          date: "2024-02-03",
          previousId: w.selected.latestId,
          reference: "SYNTHETIC-PEER-" + randomUUID(),
          countedKg: kg,
          scope: "actual-weighed-unused-feed-lot-count",
          reason: "Synthetic other-tab original weighing",
          evidence: "Synthetic other-tab identified-lot scale register",
        },
      });
      return id;
    }
    await page.goto("/");
    await page
      .getByRole("button", { name: "Feed inventory", exact: true })
      .click();
    const region = page.getByRole("region", {
        name: "Weighed feed stocktakes",
        exact: true,
      }),
      stockRegion = page.getByRole("region", {
        name: "Feed purchases and consumption",
        exact: true,
      }),
      select = (name: string, value: string) =>
        region.getByRole("combobox", { name, exact: true }).selectOption(value),
      text = (name: string, value: string) =>
        region.getByRole("textbox", { name, exact: true }).fill(value),
      ack = () =>
        region
          .getByLabel("I confirm this weighed-stocktake decision", {
            exact: false,
          })
          .check(),
      ref = "SYNTHETIC-COUNT-" + randomUUID();
    await select("Counted purchased feed lot", lot);
    await region
      .getByLabel("Physical count date", { exact: true })
      .fill("2024-02-03");
    await text("Count reference", ref);
    await text("Actually weighed unused feed kg", "90");
    await text(
      "Stocktake review reason",
      "Synthetic actual current unused-feed lot weighing",
    );
    await text(
      "Weighing and investigation evidence",
      "Synthetic calibrated scale and complete original count sheet",
    );
    await region
      .getByRole("button", { name: "Preview stocktake decision", exact: true })
      .click();
    await expect(
      region.getByRole("region", {
        name: "Unsaved stocktake preview",
        exact: true,
      }),
    ).toContainText("-4.876544");
    expect((await workspace()).report.events).toHaveLength(3);
    expect((await cw()).history).toHaveLength(0);
    await ack();
    let responseLost = false;
    await page.route("**/api/inventory/feed/counts", async (route) => {
      if (route.request().method() === "POST" && !responseLost) {
        responseLost = true;
        const r = await route.fetch();
        expect(r.status()).toBe(201);
        await route.abort("failed");
      } else await route.continue();
    });
    await region
      .getByRole("button", { name: "Record weighed count", exact: true })
      .click();
    await expect(
      region.getByRole("button", {
        name: "Retry exact stocktake receipt",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      region.getByRole("button", {
        name: "Retry exact stocktake receipt",
        exact: true,
      }),
    ).toBeEnabled();
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
    await region
      .getByRole("button", {
        name: "Retry exact stocktake receipt",
        exact: true,
      })
      .click();
    await expect(
      region
        .getByRole("status")
        .filter({ hasText: "Original stocktake receipt confirmed" }),
    ).toBeVisible();
    await page.unroute("**/api/inventory/feed/counts");
    const first = (await cw()).counts[0].id,
      firstUrl = `/api/inventory/feed/counts?organizationId=${org}&eventId=${first}&format=json`,
      firstBytes = await (await page.request.get(firstUrl)).text();
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM audit_logs WHERE object_id=$1",
          [first],
        )
      ).rows[0].n,
    ).toBe(1);
    expect((await workspace()).report.events).toHaveLength(3);
    await select("Counted purchased feed lot", lot);
    await region
      .getByLabel("Physical count date", { exact: true })
      .fill("2024-02-03");
    await text("Count reference", ref + "-RECOUNT");
    await text("Actually weighed unused feed kg", "91");
    await text(
      "Stocktake review reason",
      "Synthetic fresh complete unused-feed weighing",
    );
    await text(
      "Weighing and investigation evidence",
      "Synthetic fresh count and current original scale evidence",
    );
    await ack();
    await peer("93");
    await region
      .getByRole("button", { name: "Record weighed count", exact: true })
      .click();
    await expect(region.getByRole("alert")).toContainText(
      "Stock or counts changed",
    );
    await expect(
      region.getByRole("textbox", {
        name: "Actually weighed unused feed kg",
        exact: true,
      }),
    ).toHaveValue("91");
    const draft = page.waitForEvent("download");
    await region
      .getByRole("button", {
        name: "Download stocktake working copy",
        exact: true,
      })
      .click();
    await (await draft).saveAs(".local/browser-feed-count-working.json");
    expect(
      JSON.parse(readFileSync(".local/browser-feed-count-working.json", "utf8"))
        .countedKg,
    ).toBe("91");
    await region
      .getByRole("button", { name: "Reload current stocktakes", exact: true })
      .click();
    await expect(region.getByRole("status")).toContainText(
      "Working inputs retained",
    );
    await expect(
      region.getByLabel("I confirm this weighed-stocktake decision", {
        exact: false,
      }),
    ).not.toBeChecked();
    await ack();
    await region
      .getByRole("button", { name: "Record weighed count", exact: true })
      .click();
    await expect(region.getByRole("status")).toContainText(
      "Weighed count saved",
    );
    const current = (await cw()).counts[0].id;
    await select("Stocktake activity", "resolve_shortage");
    await select("Current shortage count", current);
    await text(
      "Stocktake review reason",
      "Synthetic manager approved investigated unused-feed shortage",
    );
    await text(
      "Weighing and investigation evidence",
      "Synthetic manager investigation confirms original count shortage as one feed loss",
    );
    await region
      .getByRole("button", { name: "Preview stocktake decision", exact: true })
      .click();
    await expect(
      region.getByRole("region", {
        name: "Unsaved stocktake preview",
        exact: true,
      }),
    ).toContainText("11.6296");
    await ack();
    await region
      .getByRole("button", { name: "Approve shortage as loss", exact: true })
      .click();
    await expect(region.getByRole("status")).toContainText("Shortage approved");
    const approved = (await cw()).counts[0].resolutionId;
    expect((await workspace()).report.results.lots[0].balanceKg).toBe(
      "91.000000",
    );
    expect((await fin()).report.entries).toHaveLength(3);
    expect(await snapshot()).toEqual(original);
    expect(await (await page.request.get(firstUrl)).text()).toBe(firstBytes);
    await page.getByRole("button", { name: "Finance", exact: true }).click();
    const fr = page.getByRole("region", {
        name: "Financial journal and trial balance",
        exact: true,
      }),
      fs = (name: string, value: string) =>
        fr.getByRole("combobox", { name, exact: true }).selectOption(value),
      ft = (name: string, value: string) =>
        fr.getByRole("textbox", { name, exact: true }).fill(value),
      fa = () =>
        fr
          .getByLabel("I confirm the accounting evidence", { exact: false })
          .check();
    async function fe() {
      await ft(
        "Accounting review reason",
        "Synthetic manager evidence for actual count loss accounting",
      );
      await ft(
        "Accounting source and recognition evidence",
        "Synthetic original physical stocktake approval and explicit financial treatment",
      );
    }
    async function book() {
      await fr
        .getByRole("button", {
          name: "Post balanced journal entry",
          exact: true,
        })
        .click();
      await expect(fr.getByRole("status")).toContainText(
        "Journal entry posted",
      );
    }
    await fs("Journal activity", "recognize_feed");
    await fs("Recorded feed movement", approved);
    await fe();
    await fa();
    await book();
    let f = await fin();
    expect(
      f.report.entries.find(
        (e: { source_id: string }) => e.source_id === approved,
      ).source_snapshot,
    ).toMatchObject({
      countEvidence: {
        id: approved,
        source_snapshot: { count: { id: current } },
      },
    });
    const review = await costReview("330");
    await fr
      .getByRole("button", { name: "Reload current journal", exact: true })
      .click();
    await fs("Journal activity", "recognize_feed_cost");
    await fs("Reviewed feed cost authority", review);
    await fs("Cost difference settlement", "payables");
    await fs("Previously unbooked consumption treatment", "expense");
    await fe();
    await fa();
    await book();
    f = await fin();
    const priced = f.report.entries
      .filter((e: { kind: string }) => e.kind === "recognize_feed_cost")
      .at(-1);
    expect(
      priced.source_snapshot.components.find(
        (c: { eventId: string }) => c.eventId === approved,
      ).countEvidence.id,
    ).toBe(approved);
    expect(await (await page.request.get(frozen + "&format=json")).text()).toBe(
      oldJson,
    );
    expect(await (await page.request.get(frozen + "&format=csv")).text()).toBe(
      oldCsv,
    );
    expect(await (await page.request.get(stockUrl)).text()).toBe(stockBytes);
    await page
      .getByRole("button", { name: "Feed inventory", exact: true })
      .click();
    await select("Counted purchased feed lot", lot);
    await region
      .getByLabel("Physical count date", { exact: true })
      .fill("2024-02-04");
    await text("Count reference", ref + "-SURPLUS");
    await text("Actually weighed unused feed kg", "95");
    await text(
      "Stocktake review reason",
      "Synthetic actual surplus requires source investigation",
    );
    await text(
      "Weighing and investigation evidence",
      "Synthetic surplus observation without invented origin or cost",
    );
    await ack();
    await region
      .getByRole("button", { name: "Record weighed count", exact: true })
      .click();
    await expect(region.getByRole("status")).toContainText(
      "Weighed count saved",
    );
    await expect(
      region.getByRole("region", {
        name: "Current stocktake differences",
        exact: true,
      }),
    ).toContainText("Surplus · investigation required");
    expect((await workspace()).report.results.lots[0].balanceKg).toBe(
      "91.000000",
    );
    expect(await (await page.request.get(firstUrl)).text()).toBe(firstBytes);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await region
      .getByRole("heading", { name: "Weighed feed stocktakes", exact: true })
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.screenshot({
      path: ".local/browser-feed-count-mobile.png",
      animations: "disabled",
    });
    [auditor, worker] = (
      await db.query(
        "INSERT INTO users(email,password_hash) SELECT x,'fixture' FROM unnest($1::text[])x RETURNING id",
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
    await select("Saved stocktake version", first);
    await expect(
      region.getByRole("button", {
        name: "Download stocktake JSON",
        exact: true,
      }),
    ).toBeEnabled();
    await expect(
      region.getByRole("button", { name: "Record weighed count", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Finance", exact: true }).click();
    await expect(fr).toContainText("latest stocktake difference");
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
      page.getByRole("button", { name: "Feed inventory", exact: true }),
    ).toHaveCount(0);
    expect((await page.request.get(firstUrl)).status()).toBe(403);
    expect(errors).toEqual([]);
  } finally {
    if (org) await db.query("DELETE FROM organizations WHERE id=$1", [org]);
    for (const id of [owner, auditor, worker])
      if (id) await db.query("DELETE FROM users WHERE id=$1", [id]);
    await db.end();
  }
});
