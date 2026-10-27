import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";

test("explains infeasibility, preserves run evidence and restores scenarios as drafts", async ({
  page,
}) => {
  test.setTimeout(60000);
  const emails = [
    `optimizer-owner-${randomUUID()}@test.invalid`,
    `optimizer-reviewer-${randomUUID()}@test.invalid`,
  ];
  const headers = { Origin: "http://localhost:3000" },
    evidence = "Synthetic optimizer fixture, not agricultural guidance";
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
            email: emails[0],
            password: "Test-only optimizer password 42",
          },
        })
      ).ok(),
    ).toBe(true);
    org = (
      await (
        await page.request.post("/api/organizations", {
          headers,
          data: { name: "Optimizer history farm" },
        })
      ).json()
    ).id;
    const reviewer = (
      await (
        await page.request.post("/api/auth/register", {
          headers,
          data: {
            email: emails[1],
            password: "Test-only optimizer password 42",
          },
        })
      ).json()
    ).user.id;
    await db.query("INSERT INTO memberships VALUES($1,$2,'nutritionist')", [
      org,
      reviewer,
    ]);
    const ingredient = async (name: string, price: number, protein: number) => {
      const response = await page.request.post("/api/ingredients", {
        headers,
        data: {
          organizationId: org,
          name,
          source: evidence,
          nutrients: {
            energy: 3000,
            protein,
            dryMatter: 90,
            calcium: 1,
            phosphorus: 0.5,
            methionine: 0.5,
            lysine: 1,
          },
          price,
          basis: "as-fed",
          energySystem: "ME",
          reviewStatus: "approved",
          species: "poultry",
          stages: ["starter"],
          phosphorusBasis: "total",
          quotedOn: new Date().toISOString().slice(0, 10),
        },
      });
      expect(response.status()).toBe(201);
      return (await response.json()).id as string;
    };
    const a = await ingredient("Cheap fixture", 100, 10),
      b = await ingredient("Rich fixture", 300, 50);
    const profileResponse = await page.request.post("/api/profiles", {
      headers,
      data: {
        organizationId: org,
        name: "Starter fixture",
        species: "poultry",
        stage: "starter",
        source: evidence,
        basis: "as-fed",
        energySystem: "ME",
        phosphorusBasis: "total",
        limits: {
          energy: { min: 2000 },
          protein: { min: 20 },
          calcium: { min: 0 },
          phosphorus: { min: 0 },
          methionine: { min: 0 },
          lysine: { min: 0 },
        },
      },
    });
    expect(profileResponse.status()).toBe(201);
    const profile = (await profileResponse.json()).id;
    await page.goto("/");
    await page
      .getByRole("button", { name: "Feed studio", exact: true })
      .click();
    await page
      .getByLabel("Recipe name", { exact: true })
      .fill("Diagnostic scenario");
    await page.getByLabel("Batch weight (kg)", { exact: true }).fill("100");
    await page
      .getByRole("combobox", { name: "Nutritional specification", exact: true })
      .selectOption(profile);
    await page
      .getByRole("button", { name: "Add ingredient", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Ingredient 1", exact: true })
      .selectOption(a);
    await page.getByLabel("percent ingredient 1", { exact: true }).fill("50");
    await page
      .getByRole("button", { name: "Add ingredient", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Ingredient 2", exact: true })
      .selectOption(b);
    await page.getByLabel("percent ingredient 2", { exact: true }).fill("50");
    await page
      .getByLabel("Available kg ingredient 2", { exact: true })
      .fill("10");
    await page
      .getByRole("combobox", { name: "Save status", exact: true })
      .selectOption("approved");
    await page
      .getByRole("button", { name: "Find least-cost formula", exact: true })
      .click();
    const live = page.getByRole("region", {
      name: "Optimization evidence",
      exact: true,
    });
    await expect(
      live.getByRole("listitem").filter({ hasText: "protein:" }),
    ).toContainText("attainable maximum 14.000000");
    await expect(
      live.getByRole("row").filter({ hasText: "Rich fixture" }),
    ).toContainText("availability: 10%");
    await live
      .getByRole("button", { name: "Open saved run", exact: true })
      .click();
    const saved = page.getByRole("region", {
      name: "Saved optimization run",
      exact: true,
    });
    await expect(
      saved.getByRole("heading", { name: "Diagnostic scenario", exact: true }),
    ).toBeVisible();
    const download = page.waitForEvent("download");
    await saved
      .getByRole("button", { name: "Download run JSON", exact: true })
      .click();
    const record = JSON.parse(
      readFileSync((await (await download).path())!, "utf8"),
    );
    expect(record.result.status).toBe("infeasible");
    expect(record.result.fractions).toBeNull();
    expect(record.request.modelVersion).toBe(4);
    expect(record.request.lines[1].availableKg).toBe(10);
    expect(record.request.ingredientSnapshot).toHaveLength(2);
    page.once("dialog", (dialog) => void dialog.accept());
    await saved
      .getByRole("button", { name: "Load scenario as draft", exact: true })
      .click();
    await expect(
      page.getByRole("combobox", { name: "Save status", exact: true }),
    ).toHaveValue("draft");
    await expect(
      page.getByLabel("Available kg ingredient 2", { exact: true }),
    ).toHaveValue("10");
    await page
      .getByLabel("Available kg ingredient 2", { exact: true })
      .fill("");
    await expect(live).not.toBeVisible();
    await page
      .getByRole("button", { name: "Find least-cost formula", exact: true })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: /HiGHS found an optimum/ }),
    ).toBeVisible();
    expect(
      Number(
        await page
          .getByLabel("percent ingredient 1", { exact: true })
          .inputValue(),
      ),
    ).toBeCloseTo(75, 7);
    expect(
      Number(
        await page
          .getByLabel("percent ingredient 2", { exact: true })
          .inputValue(),
      ),
    ).toBeCloseTo(25, 7);
    await live.getByText("Independent primal checks", { exact: true }).click();
    await expect(
      live.getByText("Objective error (NGN/kg)", { exact: true }),
    ).toBeVisible();
    await live
      .getByRole("button", { name: "Open saved run", exact: true })
      .click();
    await expect(
      saved.getByText(/Original ingredient and specification snapshots/),
    ).toBeVisible();
    await page
      .getByRole("combobox", { name: "Run status", exact: true })
      .selectOption("infeasible");
    await expect(page.getByRole("button", { name: /^View run / })).toHaveCount(
      1,
    );
    await page
      .getByRole("combobox", { name: "Run status", exact: true })
      .selectOption("optimal");
    await expect(page.getByRole("button", { name: /^View run / })).toHaveCount(
      1,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      saved.getByRole("button", { name: "Download run JSON", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.reload();
    await page
      .getByRole("button", { name: "Feed studio", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Optimizer history", exact: true })
      .click();
    await expect(page.getByRole("button", { name: /^View run / })).toHaveCount(
      2,
    );
    expect(
      (
        await db.query(
          "SELECT count(*) FROM formula_versions WHERE organization_id=$1",
          [org],
        )
      ).rows[0].count,
    ).toBe("0");
  } finally {
    if (org) await db.query("DELETE FROM organizations WHERE id=$1", [org]);
    await db.query("DELETE FROM users WHERE email=ANY($1::text[])", [emails]);
    await db.end();
  }
});
