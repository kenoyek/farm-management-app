import { test, expect } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import pg from "pg";
config({ path: ".env.local", quiet: true });
test("records measured broiler processing, recovers a receipt and preserves source mass through corrections, withdrawal and stale editors", async ({
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
    const original = await snapshot(),
      errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => void d.accept());
    await page.goto("/");
    await page.getByRole("button", { name: "Production", exact: true }).click();
    const region = page.getByRole("region", {
        name: "Broiler processing and measured yields",
        exact: true,
      }),
      lifecycle = page.getByRole("region", {
        name: "Broiler lifecycle",
        exact: true,
      });
    await expect(
      region
        .getByRole("combobox", {
          name: "Whole harvest to process",
          exact: true,
        })
        .locator("option"),
    ).toHaveCount(2);
    const fill = async () => {
      await region
        .getByRole("combobox", {
          name: "Whole harvest to process",
          exact: true,
        })
        .selectOption(harvest);
      await region
        .getByLabel("Observed processing date", { exact: true })
        .fill("2024-02-03");
      await region
        .getByRole("combobox", { name: "Primary product form", exact: true })
        .selectOption("dressed_whole");
      await region
        .getByLabel("Measured residual / waste kg · blank is unknown", {
          exact: true,
        })
        .fill("3");
      for (const [i, p] of [
        {
          name: "=Synthetic whole dressed birds",
          role: "primary",
          use: "intended",
          kg: "14",
        },
        {
          name: "Synthetic giblets",
          role: "by_product",
          use: "intended",
          kg: "2",
        },
        {
          name: "Synthetic feathers",
          role: "other",
          use: "not_intended",
          kg: "1",
        },
      ].entries()) {
        if (i > 0)
          await region
            .getByRole("button", { name: "Add measured output", exact: true })
            .click();
        await region
          .getByLabel(`Output ${i + 1} name`, { exact: true })
          .fill(p.name);
        await region
          .getByRole("combobox", { name: `Output ${i + 1} role`, exact: true })
          .selectOption(p.role);
        await region
          .getByRole("combobox", {
            name: `Output ${i + 1} intended use`,
            exact: true,
          })
          .selectOption(p.use);
        await region
          .getByLabel(`Output ${i + 1} measured kg`, { exact: true })
          .fill(p.kg);
      }
      await region
        .getByRole("textbox", { name: "Processing review reason", exact: true })
        .fill("Synthetic original whole-harvest processing measurements");
      await region
        .getByRole("textbox", {
          name: "Scale records, ownership and product evidence",
          exact: true,
        })
        .fill(
          "Synthetic owned unsold whole group; dated output/residual scale register; no added mass",
        );
    };
    const acknowledge = () =>
      region
        .getByLabel("I reviewed this exact whole harvest", { exact: false })
        .check();
    const save = async () => {
      const response = page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/broilers/processing") &&
          r.request().method() === "POST",
      );
      await region
        .getByRole("button", { name: "Save processing version", exact: true })
        .click();
      expect((await response).ok()).toBe(true);
      await expect(
        region.getByRole("combobox", {
          name: "Whole harvest to process",
          exact: true,
        }),
      ).toHaveValue("");
    };
    await fill();
    await region
      .getByRole("button", { name: "Preview measured yields", exact: true })
      .click();
    await expect(
      region.getByRole("heading", {
        name: "Unsaved measured-yield preview",
        exact: true,
      }),
    ).toBeVisible();
    await expect(region.getByText("balanced", { exact: true })).toBeVisible();
    expect((await snapshot()).processingReviews).toHaveLength(0);
    await acknowledge();
    let lose = true;
    await page.route("**/api/broilers/processing", async (route) => {
      if (lose && route.request().method() === "POST") {
        lose = false;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await region
      .getByRole("button", { name: "Save processing version", exact: true })
      .click();
    await expect(
      region.getByRole("button", {
        name: "Retry processing receipt",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      lifecycle.getByRole("button", {
        name: "Save broiler lifecycle record",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      lifecycle.getByRole("button", {
        name: "Save broiler recovery review",
        exact: true,
      }),
    ).toBeDisabled();
    await page.reload();
    await page.getByRole("button", { name: "Production", exact: true }).click();
    await region
      .getByRole("button", { name: "Retry processing receipt", exact: true })
      .click();
    await expect(region.getByRole("status")).toContainText(
      "Processing review saved",
    );
    await page.unroute("**/api/broilers/processing");
    let h = await snapshot();
    expect(h.processingReviews).toHaveLength(1);
    expect(
      (
        await db.query(
          "SELECT count(*) FROM audit_logs WHERE organization_id=$1 AND action='broiler.processing_record'",
          [org],
        )
      ).rows[0].count,
    ).toBe("1");
    const first = h.processingReviews[0];
    await region
      .getByText(`Harvest ${harvest} · revision 1 · recorded`, { exact: true })
      .click();
    await expect(
      region.getByText("0.70000000", { exact: true }).first(),
    ).toBeVisible();
    expect(h.summary).toMatchObject({
      balance: 85,
      asOf: "2024-02-02",
      fcr: "0.210526",
      feedKg: "30.000000",
    });
    await region
      .getByRole("combobox", { name: "Whole harvest to process", exact: true })
      .selectOption(harvest);
    await region
      .getByLabel("Output 1 measured kg", { exact: true })
      .fill("13.5");
    await region
      .getByRole("textbox", { name: "Processing review reason", exact: true })
      .fill("Synthetic corrected primary weighing");
    await region
      .getByRole("textbox", {
        name: "Scale records, ownership and product evidence",
        exact: true,
      })
      .fill("Synthetic corrected original scale register");
    await acknowledge();
    await save();
    h = await snapshot();
    expect(h.processingReviews[0]).toEqual(first);
    expect(h.processingReviews.at(-1).previous_id).toBe(first.id);
    await region
      .getByRole("combobox", { name: "Whole harvest to process", exact: true })
      .selectOption(harvest);
    await region.getByLabel("Output 1 measured kg", { exact: true }).fill("14");
    await region
      .getByRole("textbox", { name: "Processing review reason", exact: true })
      .fill("Synthetic retained local measured correction");
    await region
      .getByRole("textbox", {
        name: "Scale records, ownership and product evidence",
        exact: true,
      })
      .fill("Synthetic local measurement source");
    const other = structuredClone(first.input);
    other.products[0].weightKg = "13.75";
    other.reason = "Synthetic second manager correction";
    await post("broilers/processing", {
      organizationId: org,
      unitId: unit,
      reviewId: randomUUID(),
      harvestId: harvest,
      previousId: h.processingReviews.at(-1).id,
      expectedPosition: h.summary.expectedPosition,
      expectedDailyId: h.summary.expectedDailyId,
      data: other,
    });
    await acknowledge();
    await region
      .getByRole("button", { name: "Save processing version", exact: true })
      .click();
    await expect(region.getByRole("alert")).toContainText("batch changed");
    await expect(
      region.getByLabel("Output 1 measured kg", { exact: true }),
    ).toHaveValue("14");
    let dl = page.waitForEvent("download");
    await region
      .getByRole("button", {
        name: "Download processing working copy",
        exact: true,
      })
      .click();
    await (await dl).saveAs(".local/browser-broiler-processing-working.json");
    expect(
      JSON.parse(
        readFileSync(".local/browser-broiler-processing-working.json", "utf8"),
      ).data.reason,
    ).toBe("Synthetic retained local measured correction");
    await region
      .getByRole("button", {
        name: "Reload selected harvest evidence",
        exact: true,
      })
      .click();
    await expect(region.getByRole("status")).toContainText(
      "Harvest evidence reloaded",
    );
    await expect(
      region.getByLabel("I reviewed this exact whole harvest", {
        exact: false,
      }),
    ).not.toBeChecked();
    await expect(
      region.getByLabel("Output 1 measured kg", { exact: true }),
    ).toHaveValue("14");
    await acknowledge();
    await save();
    await region
      .getByRole("combobox", { name: "Whole harvest to process", exact: true })
      .selectOption(harvest);
    await region
      .getByRole("combobox", { name: "Processing review action", exact: true })
      .selectOption("withdraw");
    await region
      .getByRole("textbox", { name: "Processing review reason", exact: true })
      .fill("Synthetic erroneous measurement record withdrawn");
    await region
      .getByRole("textbox", {
        name: "Scale records, ownership and product evidence",
        exact: true,
      })
      .fill("Synthetic reviewed record correction");
    await acknowledge();
    await save();
    h = await snapshot();
    expect(h.summary.balance).toBe(85);
    expect(h.processingReviews.at(-1).input.kind).toBe("withdraw");
    await fill();
    await acknowledge();
    await save();
    h = await snapshot();
    expect(h.processingReviews.at(-1).revision).toBe(6);
    expect(h.events).toEqual(original.events);
    expect(h.originalRecords).toEqual(original.originalRecords);
    expect(h.records).toEqual(original.records);
    expect(h.summary.fcr).toBe("0.210526");
    dl = page.waitForEvent("download");
    await region
      .getByRole("button", { name: "Download processing JSON", exact: true })
      .click();
    await (await dl).saveAs(".local/browser-broiler-processing.json");
    const report = JSON.parse(
      readFileSync(".local/browser-broiler-processing.json", "utf8"),
    );
    expect(
      createHash("sha256")
        .update(
          JSON.stringify({
            modelVersion: report.modelVersion,
            source: report.source,
            results: report.results,
          }),
        )
        .digest("hex"),
    ).toBe(report.evidenceSha256);
    expect(report.results.lots[0].metrics).toMatchObject({
      primaryYieldFraction: "0.70000000",
      intendedSaleKg: "16.000000",
      unreconciledKg: "0.000000",
      massState: "balanced",
    });
    dl = page.waitForEvent("download");
    await region
      .getByRole("button", { name: "Download processing CSV", exact: true })
      .click();
    await (await dl).saveAs(".local/browser-broiler-processing.csv");
    expect(
      readFileSync(".local/browser-broiler-processing.csv", "utf8"),
    ).toContain("'=Synthetic whole dressed birds");
    await page.setViewportSize({ width: 390, height: 844 });
    await region
      .getByRole("heading", {
        name: "Broiler processing and measured yields",
        exact: true,
      })
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: ".local/broiler-processing-mobile.png",
      animations: "disabled",
      fullPage: false,
    });
    await region
      .getByRole("combobox", { name: "Whole harvest to process", exact: true })
      .selectOption(harvest);
    await region
      .getByRole("textbox", { name: "Processing review reason", exact: true })
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.screenshot({
      path: ".local/broiler-processing-form-mobile.png",
      animations: "disabled",
      fullPage: false,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
    auditor = (
      await db.query(
        "INSERT INTO users(email,password_hash) VALUES($1,'fixture-not-a-login') RETURNING id",
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
    await page.goto("/");
    await page.getByRole("button", { name: "Production", exact: true }).click();
    await expect(
      region.getByRole("heading", {
        name: "Immutable processing history",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      region.getByRole("button", {
        name: "Save processing version",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      region.getByRole("button", {
        name: "Download processing JSON",
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
