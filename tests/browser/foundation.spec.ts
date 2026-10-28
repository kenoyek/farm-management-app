import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import pg from "pg";
config({ path: ".env.local", quiet: true });
test("register, create organization and farm, reload persistence, mobile navigation and logout", async ({
  page,
}) => {
  test.setTimeout(60000);
  const email = `browser-${randomUUID()}@test.invalid`;
  const password = readFileSync(".local/postgres.env", "utf8").match(
    /POSTGRES_PASSWORD=(.+)/,
  )![1];
  const db = new pg.Pool({
    connectionString: `postgresql://postgres:${password}@127.0.0.1:54329/farmstead`,
  });
  try {
    await page.goto("/");
    await page
      .getByRole("button", { name: "Create an account", exact: true })
      .click();
    await page.getByLabel("Email address").fill(email);
    await page
      .getByLabel("Password", { exact: true })
      .fill("Correct horse battery staple 42");
    await page
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await page.getByRole("button", { name: "Set up organization" }).click();
    await page.getByLabel("Organization name").fill("Browser Test Agriculture");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Create organization", exact: true })
      .click();
    await expect(
      page.getByText("Organization created. You are its owner."),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Add farm", exact: true })
      .first()
      .click();
    await page.getByLabel("Farm name").fill("Ibadan Test Farm");
    await page
      .getByLabel("Location", { exact: true })
      .fill("Ibadan, Oyo State");
    await page.getByLabel("Operation type").selectOption("layers");
    await page.getByRole("button", { name: "Save farm" }).click();
    await expect(page.getByText("Ibadan Test Farm")).toBeVisible();
    await page.reload();
    await expect(page.getByText("Ibadan Test Farm")).toBeVisible();
    await page
      .getByRole("button", { name: "Feed studio", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Workbook import", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Inspect supplied workbooks" })
      .click();
    await expect(
      page.getByText("Feed Formula Calculator.xlsx", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Confirm import as unverified data" })
      .click();
    await expect(
      page.getByText(
        "32 unverified ingredient references imported with raw workbook audit.",
      ),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Add ingredient", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByLabel("Name", { exact: true })
      .fill("User reference fixture");
    await page
      .getByRole("dialog")
      .getByLabel("Source and verification reference")
      .fill("User-supplied test source; not scientific guidance");
    await page
      .getByRole("button", { name: "Save new reference", exact: true })
      .click();
    await expect(
      page.getByText("Ingredient reference saved as a new record."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Formulator", exact: true }).click();
    await page
      .getByRole("button", { name: "Add ingredient", exact: true })
      .click();
    await page
      .getByLabel("Ingredient 1", { exact: true })
      .selectOption({ label: "Maize" });
    await page.getByLabel("percent ingredient 1", { exact: true }).fill("100");
    await page.getByRole("button", { name: "Calculate", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Nutrient results" }),
    ).toBeVisible();
    await expect(page.getByText("3400.0000", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Save version" }).click();
    await expect(
      page.getByText("Immutable recipe version saved."),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Source catalog", exact: true })
      .click();
    await expect(
      page.getByText("32 ROWS · UNVERIFIED", { exact: true }),
    ).toBeVisible();
    await page.getByLabel("Reference category").selectOption("restriction");
    await expect(
      page.getByText("120 ROWS · UNVERIFIED", { exact: true }),
    ).toBeVisible();
    await page.getByLabel("Search source labels").fill("Salt");
    await page.locator(".catalog-entry summary").first().click();
    await expect(
      page
        .locator(".catalog-entry")
        .first()
        .getByText("0–0.5 % (source range)", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Stage confirmed workbook references" })
      .click();
    await expect(
      page.getByText("The source catalog is already up to date."),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Ingredients", exact: true })
      .click();
    await page
      .getByRole("row")
      .filter({ has: page.getByText("Maize", { exact: true }) })
      .getByRole("button", { name: "Revise reference" })
      .click();
    await expect(
      page.getByRole("dialog").getByLabel("Price per kg (₦)", { exact: true }),
    ).toHaveValue("230.0000");
    await page
      .getByRole("dialog")
      .getByLabel("Price per kg (₦)", { exact: true })
      .fill("500");
    await page.getByRole("button", { name: "Save reference revision" }).click();
    await expect(
      page.getByText(
        "Ingredient revision saved. Historical references and recipe snapshots are unchanged.",
      ),
    ).toBeVisible();
    await page.getByLabel("Show historical ingredient revisions").check();
    await expect(
      page
        .getByRole("row")
        .filter({ has: page.getByText("Maize", { exact: true }) }),
    ).toHaveCount(2);
    await page
      .getByRole("button", { name: "Recipe library", exact: true })
      .click();
    await expect(
      page
        .getByRole("row")
        .filter({ hasText: "My feed recipe" })
        .getByText("₦230.0000", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Projections", exact: true })
      .click();
    await page.getByRole("button", { name: "Save scenario" }).click();
    await expect(
      page.getByText(
        "New scenario version saved. Historical records were not changed.",
      ),
    ).toBeVisible();
    await expect(page.getByText("5369.92 kg", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Production", exact: true }).click();
    await page
      .getByRole("button", { name: "Stock a production unit", exact: true })
      .click();
    await page.getByLabel("Unit name", { exact: true }).fill("Layer House A");
    await page.getByLabel("Opening population", { exact: true }).fill("100");
    await page
      .getByLabel("Initial average weight (g)", { exact: true })
      .fill("1500");
    await page
      .getByRole("button", { name: "Save record", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Layer House A" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Add daily record" }).click();
    await page.getByLabel("Feed consumed (kg)", { exact: true }).fill("10");
    await page.getByLabel("Total eggs collected", { exact: true }).fill("80");
    await page
      .getByLabel("Cracked eggs included in total", { exact: true })
      .fill("2");
    await page
      .getByRole("button", { name: "Save record", exact: true })
      .click();
    await expect(
      page.getByText(
        "Daily record saved. Stock and production totals updated.",
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        "2 complete 30-egg trays + 18 eggs from recorded collections.",
        { exact: false },
      ),
    ).toBeVisible();

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByLabel("Organization display name", { exact: true })
      .fill("Browser Test Agriculture Ltd");
    await page
      .getByRole("button", { name: "Update settings", exact: true })
      .click();
    await expect(
      page.getByText("Organization settings updated."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await expect(
      page
        .locator(".stat")
        .filter({ hasText: "Recorded bird balance" })
        .getByText("100", { exact: true }),
    ).toBeVisible();
    await expect(
      page
        .locator(".stat")
        .filter({ hasText: "Saleable eggs recorded" })
        .getByText("78", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/desktop-dashboard.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: "My farms", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Farm directory" }),
    ).toBeVisible();
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: /Sign out/ }).click();
    await expect(
      page.getByRole("heading", { name: "Welcome back" }),
    ).toBeVisible();
  } finally {
    await db.query(
      "DELETE FROM organizations WHERE id IN (SELECT organization_id FROM memberships WHERE user_id=(SELECT id FROM users WHERE email=$1))",
      [email],
    );
    await db.query("DELETE FROM users WHERE email=$1", [email]);
    await db.end();
  }
});
