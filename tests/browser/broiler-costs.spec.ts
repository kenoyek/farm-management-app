import { test, expect } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import pg from "pg";
import { actualCostCategories } from "../../src/lib/broiler-costs";
import { processingFixture } from "../broiler-processing-fixture";
config({ path: ".env.local", quiet: true });
test("reviews incurred costs, recovers one receipt, preserves historical allocation bytes and stale working inputs", async ({
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
    const receipt = (index: number) => ({
      kind: "receipt",
      sourceReviewId: reviewId,
      outputIndex: index,
      location: "Synthetic cost browser cold room",
      scope: "whole-output-owned-available",
      reason: "Synthetic whole-output receipt",
      evidence:
        "Synthetic owned available full output, no prior outside disposition",
    });
    const lot = (await product(receipt(0))).id,
      byproduct = (await product(receipt(1))).id;
    await product({
      kind: "sale",
      lotId: lot,
      weightKg: "3.123456",
      pricePerKg: "1.2345",
      reference: "SYNTHETIC-COST-SALE",
      customer: "Synthetic buyer",
      reason: "Synthetic measured dispatch",
      evidence: "Synthetic actual dispatch source",
    });
    await product({
      kind: "loss",
      lotId: lot,
      weightKg: "0.123456",
      reason: "Synthetic measured product loss",
      evidence: "Synthetic actual product loss source",
    });
    const original = await snapshot(),
      beforeProducts = await products(),
      errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => void d.accept());
    const costPath = `broilers/costs?organizationId=${org}&unitId=${unit}`,
      workspace = async () =>
        (await page.request.get("/api/" + costPath)).json();
    await page.goto("/");
    await page.getByRole("button", { name: "Production", exact: true }).click();
    const region = page.getByRole("region", {
        name: "Broiler actual costs and allocations",
        exact: true,
      }),
      productRegion = page.getByRole("region", {
        name: "Broiler product stock and sales",
        exact: true,
      }),
      text = async (name: string, value: string) =>
        region.getByRole("textbox", { name, exact: true }).fill(value);
    await text("Original actual cost currency", "NGN");
    for (const [i, c] of actualCostCategories.entries()) {
      await text(
        `${c} actual incurred amount`,
        i === 0 ? "100" : i === 1 ? "200" : "0",
      );
      await text(
        `${c} actual cost evidence`,
        c === "chicks"
          ? "=Synthetic actual placed chick voucher"
          : "Synthetic actual batch-attributed total, no overlap; zero if not incurred",
      );
    }
    for (const [i, id, amount] of [
      [0, lot, "150.0001"],
      [1, byproduct, "20"],
    ] as const) {
      await region
        .getByRole("button", {
          name: "Add product cost allocation",
          exact: true,
        })
        .click();
      await region
        .getByRole("combobox", {
          name: `Allocation ${i + 1} receipt lot`,
          exact: true,
        })
        .selectOption(id);
      await text(`Allocation ${i + 1} amount`, amount);
      await text(
        `Allocation ${i + 1} evidence`,
        "=Synthetic explicit whole-lot joint cost authority",
      );
    }
    const evidence = async () => {
      await text(
        "Actual cost review reason",
        "=Synthetic evidenced incurred category review",
      );
      await text(
        "Incurred-cost boundary and allocation evidence",
        "Synthetic actual costs through loaded operational source, consumed-feed valuation and no duplicated inputs",
      );
    };
    await evidence();
    const ack = async () =>
      region
        .getByLabel(
          "I confirm these are evidenced incurred batch category totals",
          { exact: false },
        )
        .check();
    await region
      .getByLabel("I reviewed all incurred batch costs", { exact: false })
      .check();
    await region
      .getByRole("button", {
        name: "Preview actual cost allocation",
        exact: true,
      })
      .click();
    await expect(
      region.getByRole("region", {
        name: "Unsaved actual cost preview",
        exact: true,
      }),
    ).toContainText("300.0000");
    expect((await workspace()).history).toHaveLength(0);
    await ack();
    let lost = false;
    await page.route("**/api/broilers/costs", async (route) => {
      if (route.request().method() === "POST" && !lost) {
        lost = true;
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        await route.abort("failed");
      } else await route.continue();
    });
    await region
      .getByRole("button", { name: "Save actual cost review", exact: true })
      .click();
    await expect(
      region.getByRole("button", {
        name: "Retry exact actual cost receipt",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      productRegion.getByRole("combobox", {
        name: "Product activity",
        exact: true,
      }),
    ).toBeDisabled();
    await page.reload();
    await page.getByRole("button", { name: "Production", exact: true }).click();
    await region
      .getByRole("button", {
        name: "Retry exact actual cost receipt",
        exact: true,
      })
      .click();
    await expect(region.getByRole("status")).toContainText(
      "Actual cost review saved",
    );
    await page.unroute("**/api/broilers/costs");
    let w = await workspace();
    const first = w.report,
      firstId = first.source.id;
    expect(w.history).toHaveLength(1);
    expect(first.results).toMatchObject({
      knownCostSubtotal: "300.0000",
      allocatedCost: "170.0001",
      unallocatedKnownCost: "129.9999",
    });
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM audit_logs WHERE object_id=$1",
          [firstId],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(await snapshot()).toEqual(original);
    expect(await products()).toEqual(beforeProducts);
    const exactCsv = await (
      await page.request.get(`/api/${costPath}&reviewId=${firstId}&format=csv`)
    ).text();
    await region
      .getByRole("button", {
        name: "Use saved cost inputs for a new review",
        exact: true,
      })
      .click();
    await text("feed actual incurred amount", "210");
    await evidence();
    const other = structuredClone(first.source.input);
    other.costs.find(
      (c: { category: string }) => c.category === "feed",
    ).amount = "205";
    await post("broilers/costs", {
      organizationId: org,
      unitId: unit,
      reviewId: randomUUID(),
      previousId: w.latestId,
      expectedPosition: w.current.results.expectedPosition,
      expectedSourcePosition: w.current.expectedSourcePosition,
      expectedDailyId: w.current.expectedDailyId,
      expectedSourceSha256: w.sourceToken,
      data: other,
    });
    await ack();
    await region
      .getByRole("button", { name: "Save actual cost review", exact: true })
      .click();
    await expect(region.getByRole("alert")).toContainText("changed");
    await expect(
      region.getByRole("textbox", {
        name: "feed actual incurred amount",
        exact: true,
      }),
    ).toHaveValue("210");
    let dl = page.waitForEvent("download");
    await region
      .getByRole("button", {
        name: "Download actual cost working copy",
        exact: true,
      })
      .click();
    await (await dl).saveAs(".local/browser-broiler-costs-working.json");
    expect(
      JSON.parse(
        readFileSync(".local/browser-broiler-costs-working.json", "utf8"),
      ).data.costs.find((c: { category: string }) => c.category === "feed")
        .amount,
    ).toBe("210");
    await region
      .getByRole("button", { name: "Reload actual cost source", exact: true })
      .click();
    await expect(region.getByRole("status")).toContainText(
      "Working inputs retained",
    );
    await expect(
      region.getByLabel(
        "I confirm these are evidenced incurred batch category totals",
        { exact: false },
      ),
    ).not.toBeChecked();
    await expect(
      region.getByRole("textbox", {
        name: "feed actual incurred amount",
        exact: true,
      }),
    ).toHaveValue("210");
    await ack();
    await region
      .getByRole("button", { name: "Save actual cost review", exact: true })
      .click();
    await expect(region.getByRole("status")).toContainText(
      "Actual cost review saved",
    );
    w = await workspace();
    expect(w.history).toHaveLength(3);
    expect(w.report.results.knownCostSubtotal).toBe("310.0000");
    await product({
      kind: "loss",
      lotId: lot,
      weightKg: "1",
      reason: "Synthetic later actual product loss",
      evidence: "Synthetic actual later source",
    });
    await region
      .getByRole("button", { name: "Reload actual cost source", exact: true })
      .click();
    await expect(region).toContainText(
      "Historical source: actual records or settings have changed",
    );
    await region
      .getByRole("combobox", { name: "Saved actual cost review", exact: true })
      .selectOption(firstId);
    await expect(region).toContainText("Saved version 1");
    expect(
      await (
        await page.request.get(
          `/api/${costPath}&reviewId=${firstId}&format=csv`,
        )
      ).text(),
    ).toBe(exactCsv);
    for (const format of ["json", "csv"]) {
      dl = page.waitForEvent("download");
      await region
        .getByRole("button", {
          name: `Download actual cost ${format.toUpperCase()}`,
          exact: true,
        })
        .click();
      await (await dl).saveAs(`.local/browser-broiler-costs.${format}`);
    }
    const saved = JSON.parse(
      readFileSync(".local/browser-broiler-costs.json", "utf8"),
    );
    expect(saved.source.id).toBe(firstId);
    expect(
      createHash("sha256")
        .update(
          JSON.stringify({
            modelVersion: saved.modelVersion,
            source: saved.source,
            results: saved.results,
          }),
        )
        .digest("hex"),
    ).toBe(saved.evidenceSha256);
    expect(readFileSync(".local/browser-broiler-costs.csv", "utf8")).toContain(
      "'=Synthetic actual placed chick voucher",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await region
      .getByRole("heading", {
        name: "Broiler actual costs and allocations",
        exact: true,
      })
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: ".local/browser-broiler-costs-mobile.png",
      animations: "disabled",
    });
    await region
      .getByRole("heading", {
        name: "Immutable actual cost review history",
        exact: true,
      })
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.screenshot({
      path: ".local/browser-broiler-costs-results-mobile.png",
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
        name: "Immutable actual cost review history",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      region.getByRole("button", {
        name: "Save actual cost review",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      region.getByRole("button", {
        name: "Download actual cost JSON",
        exact: true,
      }),
    ).toBeEnabled();
    await db.query(
      "UPDATE broiler_processing_reviews SET harvest_snapshot=harvest_snapshot||jsonb_build_object('large_local_fixture',$2::text) WHERE id=$1",
      [reviewId, "x".repeat(550000)],
    );
    await region
      .getByRole("button", { name: "Reload actual cost source", exact: true })
      .click();
    await expect(region).toContainText(
      "Saved version history and exact exports remain available",
    );
    await region
      .getByRole("combobox", { name: "Saved actual cost review", exact: true })
      .selectOption(firstId);
    await expect(
      region.getByRole("button", {
        name: "Download actual cost JSON",
        exact: true,
      }),
    ).toBeEnabled();
    expect(
      await (
        await page.request.get(
          `/api/${costPath}&reviewId=${firstId}&format=csv`,
        )
      ).text(),
    ).toBe(exactCsv);
    expect(errors).toEqual([]);
  } finally {
    if (org) await db.query("DELETE FROM organizations WHERE id=$1", [org]);
    for (const id of [owner, auditor])
      if (id) await db.query("DELETE FROM users WHERE id=$1", [id]);
    await db.end();
  }
});
