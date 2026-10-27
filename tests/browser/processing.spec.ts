import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
test.use({ actionTimeout: 10000 });
test("records processing evidence and enforces a combined reviewed cap through approval and export", async ({
  page,
}) => {
  test.setTimeout(90000);
  const email = `processing-browser-${randomUUID()}@test.invalid`,
    ownerEmail = `processing-fixture-owner-${randomUUID()}@test.invalid`;
  const source =
      "Synthetic processing browser fixture only; not agricultural guidance",
    headers = { Origin: "http://localhost:3000" };
  const secret = readFileSync(".local/postgres.env", "utf8").match(
    /POSTGRES_PASSWORD=(.+)/,
  )![1];
  const db = new pg.Pool({
    connectionString: `postgresql://postgres:${secret}@127.0.0.1:54329/farmstead`,
  });
  let org = "";
  try {
    // Register one real session; the separate, non-login fixture owner keeps the
    // protected owner membership intact without weakening authentication limits.
    const registered = await page.request.post("/api/auth/register", {
      headers,
      data: { email, password: "Synthetic processing browser password 42" },
    });
    expect(registered.status()).toBe(200);
    const reviewer = (await registered.json()).user.id;
    const owner = (
      await db.query(
        "INSERT INTO users(email,password_hash) VALUES($1,'fixture-not-a-login') RETURNING id",
        [ownerEmail],
      )
    ).rows[0].id;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE farm_app");
      await client.query("SELECT set_config('app.user_id',$1,true)", [owner]);
      org = (
        await client.query(
          "SELECT create_organization('Synthetic processing browser farm') AS id",
        )
      ).rows[0].id;
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    await db.query("INSERT INTO memberships VALUES($1,$2,'nutritionist')", [
      org,
      reviewer,
    ]);
    async function ingredient(
      name: string,
      price: number,
      protein: number,
      method: string | null,
    ) {
      const response = await page.request.post("/api/ingredients", {
        headers,
        data: {
          organizationId: org,
          name,
          price,
          source,
          nutrients: {
            energy: 3000,
            protein,
            dryMatter: 90,
            calcium: 1,
            phosphorus: 0.5,
            methionine: 0.5,
            lysine: 1,
          },
          basis: "as-fed",
          energySystem: "ME",
          reviewStatus: "approved",
          species: "poultry",
          stages: ["starter"],
          phosphorusBasis: "total",
          quotedOn: new Date().toISOString().slice(0, 10),
          processingMethod: method,
          processingEvidence: method ? source : null,
        },
      });
      expect(response.status()).toBe(201);
      return (await response.json()).id as string;
    }
    const oldA = await ingredient("Synthetic treated A", 100, 10, null),
      b = await ingredient("Synthetic treated B", 110, 10, "heat-treated"),
      c = await ingredient("Synthetic rich C", 300, 50, null);
    await page.goto("/");
    await page
      .getByRole("button", { name: "Feed studio", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Ingredients", exact: true })
      .click();
    await page
      .getByRole("row")
      .filter({ has: page.getByText("Synthetic treated A", { exact: true }) })
      .getByRole("button", { name: "Revise reference", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("Recorded processing method", { exact: true })
      .fill("heat-treated");
    await dialog
      .getByRole("textbox", { name: "Processing method evidence", exact: true })
      .fill(source);
    await dialog
      .getByRole("combobox", { name: "Review status", exact: true })
      .selectOption("approved");
    await dialog
      .getByRole("button", { name: "Save reference revision", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    const feed = await (
      await page.request.get(`/api/feed?organizationId=${org}`)
    ).json();
    const a = feed.ingredients.find(
      (i: { parent_id: string }) => i.parent_id === oldA,
    ).id;
    await page
      .getByRole("button", { name: "Specifications", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Add specification", exact: true })
      .click();
    await dialog
      .getByLabel("Profile name", { exact: true })
      .fill("Synthetic processing starter");
    await dialog
      .getByLabel("Production stage", { exact: true })
      .fill("starter");
    await dialog
      .getByRole("textbox", { name: "Reviewed source reference", exact: true })
      .fill(source);
    for (const [key, value] of Object.entries({
      energy: 2000,
      protein: 20,
      calcium: 0,
      phosphorus: 0,
      methionine: 0,
      lysine: 0,
    }))
      await dialog
        .getByLabel(`${key} min`, { exact: true })
        .fill(String(value));
    for (const [index, id] of [a, b, c].entries()) {
      await dialog
        .getByRole("button", { name: "Add ingredient rule", exact: true })
        .click();
      await dialog
        .getByRole("combobox", {
          name: `Rule ${index + 1} ingredient`,
          exact: true,
        })
        .selectOption(id);
      await dialog
        .getByRole("textbox", {
          name: `Rule ${index + 1} review evidence`,
          exact: true,
        })
        .fill(source);
    }
    await dialog
      .getByRole("button", { name: "Add processing group", exact: true })
      .click();
    await dialog
      .getByLabel("Processing group 1 name", { exact: true })
      .fill("Combined treated cap");
    await dialog
      .getByRole("listbox", { name: "Processing group 1 members", exact: true })
      .selectOption([a, b]);
    await dialog
      .getByLabel("Processing group 1 maximum %", { exact: true })
      .fill("60");
    await dialog
      .getByLabel("Processing group 1 required method", { exact: true })
      .fill("heat-treated");
    await dialog
      .getByRole("textbox", {
        name: "Processing group 1 review evidence",
        exact: true,
      })
      .fill(source);
    await dialog.getByRole("checkbox").check();
    await dialog
      .getByRole("button", { name: "Register reviewed profile", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    const current = await (
      await page.request.get(`/api/feed?organizationId=${org}`)
    ).json();
    const profile = current.profiles[0].id;
    expect(current.profiles[0].processing_rules[0].ingredientIds).toEqual([
      a,
      b,
    ]);
    await page.getByRole("button", { name: "Formulator", exact: true }).click();
    await expect(page.getByLabel("Recipe name", { exact: true })).toBeEnabled();
    await page
      .getByLabel("Recipe name", { exact: true })
      .fill("Synthetic processing constrained recipe");
    await page
      .getByRole("combobox", { name: "Nutritional specification", exact: true })
      .selectOption(profile);
    for (const [index, id] of [a, b, c].entries()) {
      await page
        .getByRole("button", { name: "Add ingredient", exact: true })
        .click();
      await page
        .getByRole("combobox", { name: `Ingredient ${index + 1}`, exact: true })
        .selectOption(id);
      await page
        .getByLabel(`percent ingredient ${index + 1}`, { exact: true })
        .fill(index === 0 ? "50" : "25");
    }
    await page.getByRole("button", { name: "Calculate", exact: true }).click();
    await expect(
      page
        .getByRole("region", {
          name: "Processing group constraints",
          exact: true,
        })
        .getByRole("row")
        .filter({ hasText: "Combined treated cap" }),
    ).toContainText("75 · fail");
    await page
      .getByRole("combobox", { name: "Save status", exact: true })
      .selectOption("approved");
    await page
      .getByRole("button", { name: "Save version", exact: true })
      .click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Approval needs a nutritionist" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Find least-cost formula", exact: true })
      .click();
    await expect(
      page.getByLabel("percent ingredient 3", { exact: true }),
    ).toHaveValue("40");
    const evidence = page.getByRole("region", {
      name: "Optimization evidence",
      exact: true,
    });
    await expect(
      evidence.getByRole("row").filter({ hasText: "Combined treated cap" }),
    ).toContainText("60 · pass");
    await page
      .getByRole("button", { name: "Save version", exact: true })
      .click();
    await expect(
      page.getByText("Immutable recipe version saved.", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Recipe library", exact: true })
      .click();
    const row = page
      .getByRole("row")
      .filter({ hasText: "Synthetic processing constrained recipe" });
    await expect(row).toContainText("approved");
    const csv = page.waitForEvent("download");
    await row.getByRole("button", { name: /Download CSV/ }).click();
    const bytes = readFileSync((await (await csv).path())!, "utf8");
    expect(bytes).toContain("Combined treated cap");
    expect(bytes).toContain("Processing method evidence");
    expect(bytes).toContain("heat-treated");
    await page.reload();
    await page
      .getByRole("button", { name: "Feed studio", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Specifications", exact: true })
      .click();
    await page
      .getByText("Synthetic processing starter · v1 · starter", { exact: true })
      .click();
    await expect(
      page.getByRole("region", {
        name: "Processing group constraints",
        exact: true,
      }),
    ).toContainText("Combined treated cap");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    expect(
      (
        await db.query(
          "SELECT processing_method FROM ingredients WHERE id=$1",
          [oldA],
        )
      ).rows[0].processing_method,
    ).toBeNull();
  } finally {
    if (org) await db.query("DELETE FROM organizations WHERE id=$1", [org]);
    await db.query("DELETE FROM users WHERE email=ANY($1::text[])", [
      [email, ownerEmail],
    ]);
    await db.end();
  }
});
