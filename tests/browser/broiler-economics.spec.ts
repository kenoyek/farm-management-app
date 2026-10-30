import { test, expect } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import pg from "pg";
import { planFixture } from "../broiler-planning-fixture";
import { budgetLabels } from "../../src/lib/broiler-economics";
config({ path: ".env.local", quiet: true });
test("budgets a saved broiler plan, recovers a receipt, compares versions and protects stale inputs and auditor access", async ({
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
      feedKg: 1,
      averageWeightG: 1100,
      sampleSize: 10,
      waterQuality: null,
      notes: "Synthetic actual observation",
    });
    const plan = await post("broilers/plans", {
      organizationId: org,
      unitId: unit,
      planId: randomUUID(),
      previousId: null,
      data: planFixture(),
    });
    const path = `broilers/economics?organizationId=${org}&unitId=${unit}`;
    const workspace = async () =>
      (await page.request.get("/api/" + path)).json();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    await page.getByRole("button", { name: "Production", exact: true }).click();
    const region = page.getByRole("region", {
      name: "Broiler cost and yield planning",
      exact: true,
    });
    await region
      .getByLabel("Scenario name", { exact: true })
      .fill("=Synthetic processed budget");
    await region
      .getByRole("combobox", { name: "Budget sale basis", exact: true })
      .selectOption("processedKg");
    await region
      .getByLabel("Budget sale price · blank is unknown", { exact: true })
      .fill("20");
    await region
      .getByLabel("Sale price source", { exact: true })
      .fill("Synthetic customer quotation");
    await region
      .getByLabel("Saleable processed yield fraction · 0 to 1", { exact: true })
      .fill("0.75");
    await region
      .getByLabel("Processed yield source and product definition", {
        exact: true,
      })
      .fill("Synthetic saleable dressed kg per live kg specification");
    await region
      .getByLabel("Cost allocation boundary and evidence", { exact: true })
      .fill(
        "Synthetic full batch costs allocated through planned sale; all remaining costs explicitly zero",
      );
    for (const [i, label] of Object.values(budgetLabels).entries()) {
      await region
        .getByLabel(label + " amount", { exact: true })
        .fill(i === 0 ? "10" : "0");
      await region
        .getByLabel(label + " evidence", { exact: true })
        .fill("Synthetic full batch allocation or documented zero");
    }
    await region
      .getByLabel("I have included all attributable costs", { exact: false })
      .check();
    await region
      .getByLabel("These are supplied planning assumptions", { exact: false })
      .check();
    await region
      .getByRole("button", { name: "Preview budget", exact: true })
      .click();
    await expect(
      region.getByRole("heading", {
        name: "Unsaved budget preview",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      region.getByText("229.5500", { exact: true }).first(),
    ).toBeVisible();
    expect((await workspace()).history).toHaveLength(0);
    let lose = true;
    await page.route("**/api/broilers/economics", async (route) => {
      if (lose && route.request().method() === "POST") {
        lose = false;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await region
      .getByRole("button", { name: "Save budget scenario", exact: true })
      .click();
    await expect(
      region.getByRole("button", { name: "Retry budget receipt", exact: true }),
    ).toBeVisible();
    page.on("dialog", (d) => void d.accept());
    await page.reload();
    await page.getByRole("button", { name: "Production", exact: true }).click();
    await region
      .getByRole("button", { name: "Retry budget receipt", exact: true })
      .click();
    await expect(region.getByRole("status")).toContainText(
      "Budget scenario saved",
    );
    await page.unroute("**/api/broilers/economics");
    let w = await workspace();
    expect(w.history).toHaveLength(1);
    const first = w.selected;
    expect(first.economics).toMatchObject({
      totalPlannedCost: "229.5500",
      projectedMargin: "2443.4500",
      expectedProcessedKg: "133.650000",
    });
    expect(
      (
        await db.query(
          "SELECT count(*) FROM audit_logs WHERE organization_id=$1 AND action='broiler.budget_saved'",
          [org],
        )
      ).rows[0].count,
    ).toBe("1");
    let dl = page.waitForEvent("download");
    await region
      .getByRole("button", { name: "Download budget JSON", exact: true })
      .click();
    await (await dl).saveAs(".local/browser-broiler-budget.json");
    const downloaded = JSON.parse(
      readFileSync(".local/browser-broiler-budget.json", "utf8"),
    );
    expect(
      createHash("sha256")
        .update(
          JSON.stringify({
            source: downloaded.source,
            plan: downloaded.plan,
            economics: downloaded.economics,
          }),
        )
        .digest("hex"),
    ).toBe(first.evidenceSha256);
    await region
      .getByRole("button", {
        name: "Prepare a new budget scenario",
        exact: true,
      })
      .click();
    await region
      .getByLabel("Scenario name", { exact: true })
      .fill("Synthetic higher-cost budget");
    await region
      .getByLabel("Medication and vaccination amount", { exact: true })
      .fill("20");
    await region
      .getByLabel("These are supplied planning assumptions", { exact: false })
      .check();
    await region
      .getByRole("button", { name: "Save budget scenario", exact: true })
      .click();
    await expect(
      region.getByRole("heading", {
        name: "Saved budget forecast · revision 2",
        exact: true,
      }),
    ).toBeVisible();
    w = await workspace();
    expect(w.selected.source.previous_id).toBe(first.source.id);
    await region
      .getByLabel("Compare budget revision 1", { exact: true })
      .check();
    await region
      .getByLabel("Compare budget revision 2", { exact: true })
      .check();
    await region
      .getByRole("combobox", {
        name: "Budget comparison baseline",
        exact: true,
      })
      .selectOption(first.source.id);
    await region
      .getByRole("button", { name: "Compare budget scenarios", exact: true })
      .click();
    await expect(
      region.getByRole("cell", { name: "-10.0000", exact: true }),
    ).toBeVisible();
    dl = page.waitForEvent("download");
    await region
      .getByRole("button", {
        name: "Download budget comparison CSV",
        exact: true,
      })
      .click();
    await (await dl).saveAs(".local/browser-broiler-budget-comparison.csv");
    expect(
      readFileSync(".local/browser-broiler-budget-comparison.csv", "utf8"),
    ).toContain('"Comparison source"');
    await region
      .getByRole("combobox", {
        name: "Budget comparison baseline",
        exact: true,
      })
      .selectOption(w.selected.source.id);
    await expect(
      region.getByRole("button", {
        name: "Download budget comparison CSV",
        exact: true,
      }),
    ).toHaveCount(0);
    await region
      .getByRole("button", { name: "Compare budget scenarios", exact: true })
      .click();
    await expect(
      region.getByRole("cell", { name: "10.0000", exact: true }),
    ).toBeVisible();
    await region
      .getByRole("combobox", { name: "Saved budget scenario", exact: true })
      .selectOption(first.source.id);
    await expect(
      region.getByRole("heading", {
        name: "Saved budget forecast · revision 1",
        exact: true,
      }),
    ).toBeVisible();
    await region
      .getByRole("button", {
        name: "Prepare a new budget scenario",
        exact: true,
      })
      .click();
    await region
      .getByLabel("Scenario name", { exact: true })
      .fill("Synthetic unsaved local budget");
    w = await workspace();
    await post("broilers/economics", {
      organizationId: org,
      unitId: unit,
      scenarioId: randomUUID(),
      previousId: w.history[0].id,
      planId: plan.source.id,
      data: { ...first.source.input, name: "Synthetic other manager" },
    });
    await region
      .getByLabel("These are supplied planning assumptions", { exact: false })
      .check();
    await region
      .getByRole("button", { name: "Save budget scenario", exact: true })
      .click();
    await expect(region.getByRole("alert")).toContainText(
      "newer budget scenario",
    );
    await expect(
      region.getByLabel("Scenario name", { exact: true }),
    ).toHaveValue("Synthetic unsaved local budget");
    dl = page.waitForEvent("download");
    await region
      .getByRole("button", {
        name: "Download budget working copy",
        exact: true,
      })
      .click();
    await (await dl).saveAs(".local/browser-broiler-budget-working.json");
    expect(
      JSON.parse(
        readFileSync(".local/browser-broiler-budget-working.json", "utf8"),
      ).data.name,
    ).toBe("Synthetic unsaved local budget");
    await region
      .getByRole("button", {
        name: "Reload budget history and plans",
        exact: true,
      })
      .click();
    await expect(
      region.getByRole("heading", {
        name: "Saved budget forecast · revision 3",
        exact: true,
      }),
    ).toBeVisible();
    expect(
      (
        await (
          await page.request.get(
            "/api/" + path + "&scenarioId=" + first.source.id + "&format=json",
          )
        ).json()
      ).evidenceSha256,
    ).toBe(first.evidenceSha256);
    expect(
      (
        await db.query(
          "SELECT recorded_balance FROM production_population_balances WHERE id=$1",
          [unit],
        )
      ).rows[0].recorded_balance,
    ).toBe("100");
    expect(
      (
        await db.query("SELECT count(*) FROM daily_records WHERE unit_id=$1", [
          unit,
        ])
      ).rows[0].count,
    ).toBe("1");
    expect(
      (
        await db.query("SELECT count(*) FROM broiler_events WHERE unit_id=$1", [
          unit,
        ])
      ).rows[0].count,
    ).toBe("0");
    await region
      .getByRole("button", {
        name: "Prepare a new budget scenario",
        exact: true,
      })
      .click();
    await page.setViewportSize({ width: 390, height: 844 });
    await region
      .getByRole("heading", {
        name: "Broiler cost and yield planning",
        exact: true,
      })
      .scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: ".local/broiler-economics-mobile.png",
      animations: "disabled",
      fullPage: false,
    });
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
      region.getByLabel("Medication and vaccination amount", { exact: true }),
    ).toBeDisabled();
    await expect(
      region.getByRole("button", {
        name: "Prepare a new budget scenario",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      region.getByRole("button", { name: "Download budget JSON", exact: true }),
    ).toBeEnabled();
    expect(errors).toEqual([]);
  } finally {
    if (org) await db.query("DELETE FROM organizations WHERE id=$1", [org]);
    for (const id of [owner, auditor])
      if (id) await db.query("DELETE FROM users WHERE id=$1", [id]);
    await db.end();
  }
});
