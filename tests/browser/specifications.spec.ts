import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";

test("reviews stage rules, enforces them in recipes and preserves profile history", async ({
  page,
}) => {
  test.setTimeout(60000);
  const ownerEmail = `profile-owner-${randomUUID()}@test.invalid`;
  const reviewerEmail = `profile-reviewer-${randomUUID()}@test.invalid`;
  const evidence =
    "Synthetic browser fixture evidence only, not agricultural guidance";
  const headers = { Origin: "http://localhost:3000" };
  const secret = readFileSync(".local/postgres.env", "utf8").match(
    /POSTGRES_PASSWORD=(.+)/,
  )![1];
  const db = new pg.Pool({
    connectionString: `postgresql://postgres:${secret}@127.0.0.1:54329/farmstead`,
  });
  let org = "";
  try {
    expect(
      (
        await page.request.post("/api/auth/register", {
          headers,
          data: {
            email: ownerEmail,
            password: "Test-only profile password 42",
          },
        })
      ).ok(),
    ).toBe(true);
    const created = await page.request.post("/api/organizations", {
      headers,
      data: { name: "Specification review farm" },
    });
    org = (await created.json()).id;
    const registered = await page.request.post("/api/auth/register", {
      headers,
      data: { email: reviewerEmail, password: "Test-only profile password 42" },
    });
    const reviewer = (await registered.json()).user.id;
    await db.query("INSERT INTO memberships VALUES($1,$2,'nutritionist')", [
      org,
      reviewer,
    ]);
    const ingredient = async (name: string, price: number) => {
      const response = await page.request.post("/api/ingredients", {
        headers,
        data: {
          organizationId: org,
          name,
          price,
          source: evidence,
          reviewStatus: "approved",
          basis: "as-fed",
          energySystem: "ME",
          species: "poultry",
          stages: ["starter"],
          phosphorusBasis: "total",
          quotedOn: new Date().toISOString().slice(0, 10),
          nutrients: {
            energy: 3000,
            protein: 20,
            dryMatter: 90,
            calcium: 1,
            phosphorus: 0.5,
            methionine: 0.5,
            lysine: 1,
          },
        },
      });
      expect(response.status()).toBe(201);
      return (await response.json()).id as string;
    };
    const a = await ingredient("Fixture cheap", 100),
      b = await ingredient("Fixture required", 300);
    await page.goto("/");
    await page
      .getByRole("button", { name: "Feed studio", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Specifications", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Add specification", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("Profile name", { exact: true })
      .fill("Fixture starter rules");
    await dialog
      .getByLabel("Production stage", { exact: true })
      .fill("starter");
    await dialog
      .getByLabel("Reviewed source reference", { exact: true })
      .fill(evidence);
    for (const [nutrient, value] of Object.entries({
      energy: 2000,
      protein: 20,
      calcium: 0,
      phosphorus: 0,
      methionine: 0,
      lysine: 0,
    }))
      await dialog
        .getByLabel(`${nutrient} min`, { exact: true })
        .fill(String(value));
    await dialog
      .getByRole("button", { name: "Add ingredient rule", exact: true })
      .click();
    await dialog
      .getByRole("combobox", { name: "Rule 1 ingredient", exact: true })
      .selectOption(a);
    await dialog.getByLabel("Rule 1 maximum %", { exact: true }).fill("60");
    await dialog
      .getByLabel("Rule 1 review evidence", { exact: true })
      .fill(evidence);
    await dialog
      .getByRole("button", { name: "Add ingredient rule", exact: true })
      .click();
    await dialog
      .getByRole("combobox", { name: "Rule 2 ingredient", exact: true })
      .selectOption(b);
    await dialog.getByLabel("Rule 2 minimum %", { exact: true }).fill("40");
    await dialog
      .getByLabel("Rule 2 review evidence", { exact: true })
      .fill(evidence);
    await dialog.getByRole("checkbox").check();
    await dialog
      .getByRole("button", { name: "Register reviewed profile", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Reviewed specification registered." }),
    ).toBeVisible();
    await page
      .getByText("Fixture starter rules · v1 · starter", { exact: true })
      .click();
    await expect(
      page.getByText(/Only these exact ingredient revisions/),
    ).toBeVisible();
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download specification JSON", exact: true })
      .click();
    const snapshot = JSON.parse(
      readFileSync((await (await downloaded).path())!, "utf8"),
    );
    expect(snapshot.ingredient_rules).toHaveLength(2);
    expect(snapshot.revision).toBe(1);

    await page.getByRole("button", { name: "Formulator", exact: true }).click();
    await page
      .getByRole("combobox", { name: "Nutritional specification", exact: true })
      .selectOption(snapshot.id);
    await page
      .getByRole("button", { name: "Add ingredient", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Ingredient 1", exact: true })
      .selectOption(a);
    await page.getByLabel("percent ingredient 1", { exact: true }).fill("100");
    await page.getByRole("button", { name: "Calculate", exact: true }).click();
    await expect(
      page.getByText(/Fixture required: profile requires 40–100%/),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Find least-cost formula", exact: true })
      .click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: /Add every required ingredient/ }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Add ingredient", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Ingredient 2", exact: true })
      .selectOption(b);
    await page
      .getByRole("button", { name: "Find least-cost formula", exact: true })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: /HiGHS found an optimum/ }),
    ).toBeVisible();
    await expect(
      page.getByLabel("percent ingredient 1", { exact: true }),
    ).toHaveValue("60");
    await expect(
      page.getByLabel("percent ingredient 2", { exact: true }),
    ).toHaveValue("40");
    await page
      .getByRole("combobox", { name: "Save status", exact: true })
      .selectOption("approved");
    await page
      .getByRole("button", { name: "Save version", exact: true })
      .click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Immutable recipe version saved." }),
    ).toBeVisible();

    await page
      .getByRole("button", { name: "Specifications", exact: true })
      .click();
    await page
      .getByText("Fixture starter rules · v1 · starter", { exact: true })
      .click();
    await page
      .getByRole("button", { name: "Revise specification", exact: true })
      .click();
    await expect(
      dialog.getByLabel("Rule 1 maximum %", { exact: true }),
    ).toHaveValue("60");
    await dialog.getByLabel("Rule 1 maximum %", { exact: true }).fill("40");
    await dialog.getByLabel("Rule 2 minimum %", { exact: true }).fill("60");
    await dialog.getByRole("checkbox").check();
    await dialog
      .getByRole("button", { name: "Register reviewed revision", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByText("Fixture starter rules · v2 · starter", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Fixture starter rules · v1 · starter", { exact: true }),
    ).not.toBeVisible();
    await page
      .getByLabel("Show historical specification revisions", { exact: true })
      .check();
    await expect(
      page.getByText("Fixture starter rules · v1 · starter · historical", {
        exact: true,
      }),
    ).toBeVisible();
    await page.reload();
    await page
      .getByRole("button", { name: "Feed studio", exact: true })
      .click();
    await expect(
      page.getByRole("combobox", {
        name: "Nutritional specification",
        exact: true,
      }),
    ).toHaveValue(snapshot.id);
    await expect(
      page
        .locator("select")
        .filter({ has: page.locator(`option[value="${snapshot.id}"]`) }),
    ).toContainText("historical");
    await page
      .getByRole("button", { name: "Recipe library", exact: true })
      .click();
    await expect(
      page.getByRole("row").filter({ hasText: "My feed recipe" }),
    ).toContainText("approved");
    const stored = (
      await db.query(
        "SELECT result FROM formula_versions WHERE organization_id=$1",
        [org],
      )
    ).rows[0].result;
    expect(stored.profileSnapshot.revision).toBe(1);
    expect(stored.profileSnapshot.ingredient_rules[0].max).toBe(60);
  } finally {
    if (org) await db.query("DELETE FROM organizations WHERE id=$1", [org]);
    await db.query("DELETE FROM users WHERE email=ANY($1::text[])", [
      [ownerEmail, reviewerEmail],
    ]);
    await db.end();
  }
});
