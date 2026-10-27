import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
test.use({ actionTimeout: 10000 });

test("edits expanded measurements, reviews eleven nutrient limits and exports the genuine constrained result", async ({
  page,
}) => {
  test.setTimeout(90000);
  const ownerEmail = `expanded-owner-${randomUUID()}@test.invalid`,
    reviewerEmail = `expanded-reviewer-${randomUUID()}@test.invalid`;
  const password = "Synthetic nutrient browser password 42";
  const source =
    "Synthetic measurement fixture only; not agricultural guidance";
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
          data: { email: ownerEmail, password },
        })
      ).ok(),
    ).toBe(true);
    org = (
      await (
        await page.request.post("/api/organizations", {
          headers,
          data: { name: "Synthetic nutrient browser farm" },
        })
      ).json()
    ).id;
    const registered = await page.request.post("/api/auth/register", {
      headers,
      data: { email: reviewerEmail, password },
    });
    expect(registered.ok()).toBe(true);
    await db.query("INSERT INTO memberships VALUES($1,$2,'nutritionist')", [
      org,
      (await registered.json()).user.id,
    ]);
    const base = {
      organizationId: org,
      source,
      price: 100,
      basis: "as-fed",
      energySystem: "ME",
      species: "poultry",
      stages: ["starter"],
      phosphorusBasis: "total",
      quotedOn: new Date().toISOString().slice(0, 10),
      reviewStatus: "approved",
    };
    const core = {
      energy: 3000,
      protein: 20,
      dryMatter: 90,
      calcium: 1,
      phosphorus: 0.5,
      methionine: 0.5,
      lysine: 1,
    };
    const low = await page.request.post("/api/ingredients", {
      headers,
      data: {
        ...base,
        name: "Synthetic low fat",
        nutrients: {
          ...core,
          crudeFat: 2,
          crudeFibre: 4,
          moisture: 10,
          ash: 0,
        },
      },
    });
    expect(low.status()).toBe(201);
    const a = (await low.json()).id;
    await page.goto("/");
    await page
      .getByRole("button", { name: "Feed studio", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Ingredients", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Add ingredient", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name", { exact: true }).fill("Synthetic high fat");
    await dialog.getByLabel("Price per kg (₦)", { exact: true }).fill("300");
    await dialog
      .getByLabel("Nutrient basis", { exact: true })
      .selectOption("as-fed");
    await dialog
      .getByLabel("Energy system", { exact: true })
      .selectOption("ME");
    await dialog.getByLabel("Species", { exact: true }).selectOption("poultry");
    await dialog
      .getByLabel("Applicable stages (comma separated)", { exact: true })
      .fill("starter");
    await dialog
      .getByLabel("Phosphorus basis", { exact: true })
      .selectOption("total");
    await dialog
      .getByLabel("Price quotation date", { exact: true })
      .fill(base.quotedOn);
    const labels = {
      energy: "Energy (kcal/kg)",
      protein: "Crude protein (%)",
      dryMatter: "Dry matter (%)",
      calcium: "Calcium (%)",
      phosphorus: "Phosphorus (%)",
      methionine: "Methionine (%)",
      lysine: "Lysine (%)",
      crudeFat: "Crude fat (%)",
      crudeFibre: "Crude fibre (%)",
      moisture: "Moisture (as-fed %)",
      ash: "Ash (%)",
    };
    const values = {
      ...core,
      crudeFat: 10,
      crudeFibre: 4,
      moisture: 10,
      ash: 0,
    };
    for (const key of Object.keys(values) as (keyof typeof values)[])
      await dialog
        .getByLabel(labels[key], { exact: true })
        .fill(String(values[key]));
    await dialog
      .getByLabel("Source and verification reference", { exact: true })
      .fill(source);
    await dialog
      .getByLabel("Review status", { exact: true })
      .selectOption("approved");
    await dialog
      .getByRole("button", { name: "Save new reference", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    const feed = await (
      await page.request.get(`/api/feed?organizationId=${org}`)
    ).json();
    const b = feed.ingredients.find(
      (i: { name: string }) => i.name === "Synthetic high fat",
    ).id;
    await page
      .getByRole("button", { name: "Specifications", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Add specification", exact: true })
      .click();
    await dialog
      .getByLabel("Profile name", { exact: true })
      .fill("Synthetic expanded starter");
    await dialog
      .getByLabel("Production stage", { exact: true })
      .fill("starter");
    await dialog
      .getByLabel("Reviewed source reference", { exact: true })
      .fill(source);
    for (const [key, value] of Object.entries({
      energy: 2000,
      protein: 20,
      dryMatter: 80,
      calcium: 0,
      phosphorus: 0,
      methionine: 0,
      lysine: 0,
      crudeFat: 4,
    }))
      await dialog
        .getByLabel(`${key} min`, { exact: true })
        .fill(String(value));
    for (const [key, value] of Object.entries({
      crudeFibre: 5,
      moisture: 15,
      ash: 5,
    }))
      await dialog
        .getByLabel(`${key} max`, { exact: true })
        .fill(String(value));
    await dialog.getByRole("checkbox").check();
    await dialog
      .getByRole("button", { name: "Register reviewed profile", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    const profiles = await (
      await page.request.get(`/api/feed?organizationId=${org}`)
    ).json();
    const profile = profiles.profiles[0].id;
    await page.getByRole("button", { name: "Formulator", exact: true }).click();
    await expect(page.getByLabel("Recipe name", { exact: true })).toBeEnabled();
    await page
      .getByLabel("Recipe name", { exact: true })
      .fill("Synthetic expanded recipe");
    for (const [index, id] of [a, b].entries()) {
      await page
        .getByRole("button", { name: "Add ingredient", exact: true })
        .click();
      await page
        .getByLabel(`Ingredient ${index + 1}`, { exact: true })
        .selectOption(id);
      await page
        .getByLabel(`percent ingredient ${index + 1}`, { exact: true })
        .fill("50");
    }
    await page
      .getByRole("combobox", { name: "Nutritional specification", exact: true })
      .selectOption(profile);
    await page
      .getByRole("button", { name: "Find least-cost formula", exact: true })
      .click();
    await expect(
      page.getByLabel("percent ingredient 2", { exact: true }),
    ).toHaveValue("25");
    const result = page.getByRole("table").filter({
      has: page.getByRole("columnheader", {
        name: "Specification check",
        exact: true,
      }),
    });
    await expect(
      result
        .getByRole("row")
        .filter({ has: page.getByText("Crude fat (%)", { exact: true }) }),
    ).toContainText("4.0000");
    await expect(
      result
        .getByRole("row")
        .filter({ has: page.getByText("Ash (%)", { exact: true }) }),
    ).toContainText("0.0000");
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
      .filter({ hasText: "Synthetic expanded recipe" });
    const csvPromise = page.waitForEvent("download");
    await row.getByRole("button", { name: /Download CSV/ }).click();
    const csv = readFileSync((await (await csvPromise).path())!, "utf8");
    expect(csv).toContain("Crude fat (%)");
    expect(csv).toContain("Moisture (as-fed %)");
    const xlsxPromise = page.waitForEvent("download");
    await row.getByRole("button", { name: /Download XLSX/ }).click();
    expect(
      readFileSync((await (await xlsxPromise).path())!)
        .subarray(0, 2)
        .toString(),
    ).toBe("PK");
    await page.reload();
    await page
      .getByRole("button", { name: "Feed studio", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Specifications", exact: true })
      .click();
    await page
      .getByText("Synthetic expanded starter · v1 · starter", { exact: true })
      .click();
    await expect(
      page
        .getByRole("row")
        .filter({ has: page.getByText("Crude fat (%)", { exact: true }) }),
    ).toContainText("4");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
  } finally {
    if (org) await db.query("DELETE FROM organizations WHERE id=$1", [org]);
    await db.query("DELETE FROM users WHERE email=ANY($1::text[])", [
      [ownerEmail, reviewerEmail],
    ]);
    await db.end();
  }
});
