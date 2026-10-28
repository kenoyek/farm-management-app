import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";

test("compares historical saved recipes and downloads the exact saved mixing sheets", async ({
  page,
}) => {
  test.setTimeout(60000);
  const emails = [
    `report-owner-${randomUUID()}@test.invalid`,
    `report-reviewer-${randomUUID()}@test.invalid`,
  ];
  const headers = { Origin: "http://localhost:3000" },
    evidence = "Synthetic browser fixture, not agricultural guidance";
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
          data: { email: emails[0], password: "Test-only report password 42" },
        })
      ).ok(),
    ).toBe(true);
    org = (
      await (
        await page.request.post("/api/organizations", {
          headers,
          data: { name: "Recipe report farm" },
        })
      ).json()
    ).id;
    const reviewer = (
      await (
        await page.request.post("/api/auth/register", {
          headers,
          data: { email: emails[1], password: "Test-only report password 42" },
        })
      ).json()
    ).user.id;
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
          source: evidence,
          nutrients: {
            energy: 3000,
            protein: 20,
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
          stages: ["starter", "finisher"],
          phosphorusBasis: "total",
          quotedOn: new Date().toISOString().slice(0, 10),
        },
      });
      expect(response.status()).toBe(201);
      return (await response.json()).id as string;
    };
    const a = await ingredient("=SUM(1,1)", 100),
      b = await ingredient("Rich fixture", 300);
    const profile = async (stage: string) => {
      const response = await page.request.post("/api/profiles", {
        headers,
        data: {
          organizationId: org,
          name: `Test ${stage}`,
          species: "poultry",
          stage,
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
      expect(response.status()).toBe(201);
      return (await response.json()).id as string;
    };
    const starter = await profile("starter"),
      finisher = await profile("finisher");
    const save = async (
      name: string,
      profileId: string,
      batchKg: number,
      status: string,
      lines: { ingredientId: string; percent: number }[],
    ) => {
      const response = await page.request.post("/api/formulas/save", {
        headers,
        data: { organizationId: org, name, profileId, batchKg, status, lines },
      });
      expect(response.ok()).toBe(true);
      return (await response.json()).id as string;
    };
    const first = await save("Baseline saved", starter, 100, "approved", [
      { ingredientId: a, percent: 100 },
    ]);
    const second = await save("Alternative saved", starter, 500, "draft", [
      { ingredientId: a, percent: 50 },
      { ingredientId: b, percent: 50 },
    ]);
    const third = await save("Finisher saved", finisher, 100, "draft", [
      { ingredientId: b, percent: 100 },
    ]);
    await page.goto("/");
    await page
      .getByRole("button", { name: "Feed studio", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Recipe library", exact: true })
      .click();
    await page
      .getByRole("checkbox", {
        name: `Compare Baseline saved ${first.slice(0, 8)}`,
        exact: true,
      })
      .check();
    await page
      .getByRole("checkbox", {
        name: `Compare Alternative saved ${second.slice(0, 8)}`,
        exact: true,
      })
      .check();
    await page.getByLabel("Comparison batch kg", { exact: true }).fill("250");
    await page
      .getByRole("button", { name: "Compare saved versions", exact: true })
      .click();
    const comparison = page.getByRole("region", {
      name: "Saved recipe comparison",
      exact: true,
    });
    await expect(
      comparison.getByRole("row", { name: /Common batch cost delta/ }),
    ).toContainText("₦25,000.00");
    await expect(
      comparison.getByRole("row", { name: /^Saved cost \/ kg/ }),
    ).toContainText("₦100.0000");
    await expect(
      comparison.getByText(/No prices or nutrients were refreshed/),
    ).toBeVisible();
    const comparisonDownload = page.waitForEvent("download");
    await comparison
      .getByRole("button", { name: "Comparison CSV", exact: true })
      .click();
    const csv = readFileSync(
      (await (await comparisonDownload).path())!,
      "utf8",
    );
    expect(csv).toContain(first);
    expect(csv).toContain("25000.00");
    expect(csv).toContain('"\'=SUM(1,1)"');

    const rawCsv = page.waitForEvent("download");
    await page
      .getByRole("button", {
        name: `Download CSV for Baseline saved ${first.slice(0, 8)}`,
        exact: true,
      })
      .click();
    const mixing = readFileSync((await (await rawCsv).path())!, "utf8");
    expect(mixing).toContain("APPROVED SAVED VERSION");
    expect(mixing).toContain('"Original batch kg","100"');
    expect(mixing).toContain(reviewer);
    expect(mixing).toContain(first);
    const xlsxDownload = page.waitForEvent("download");
    await page
      .getByRole("button", {
        name: `Download XLSX for Alternative saved ${second.slice(0, 8)}`,
        exact: true,
      })
      .click();
    const xlsx = await xlsxDownload;
    expect(xlsx.suggestedFilename()).toBe(`farmstead-${second}.xlsx`);
    expect(
      readFileSync((await xlsx.path())!)
        .subarray(0, 2)
        .toString(),
    ).toBe("PK");
    const pdfDownload = page.waitForEvent("download");
    await page
      .getByRole("button", {
        name: `Download PDF for Alternative saved ${second.slice(0, 8)}`,
        exact: true,
      })
      .click();
    const pdf = await pdfDownload;
    expect(pdf.suggestedFilename()).toBe(`farmstead-${second}.pdf`);
    expect(
      readFileSync((await pdf.path())!)
        .subarray(0, 5)
        .toString(),
    ).toBe("%PDF-");
    await page
      .getByRole("combobox", { name: "Baseline recipe", exact: true })
      .selectOption(second);
    await page
      .getByRole("button", { name: "Compare saved versions", exact: true })
      .click();
    await expect(
      comparison.getByRole("row", { name: /Common batch cost delta/ }),
    ).toContainText("₦-25,000.00");
    await page
      .getByRole("checkbox", {
        name: `Compare Alternative saved ${second.slice(0, 8)}`,
        exact: true,
      })
      .uncheck();
    await page
      .getByRole("checkbox", {
        name: `Compare Finisher saved ${third.slice(0, 8)}`,
        exact: true,
      })
      .check();
    await page
      .getByRole("button", { name: "Compare saved versions", exact: true })
      .click();
    await expect(
      comparison.getByText(/Scientific contexts differ or are missing/),
    ).toBeVisible();
    await expect(
      comparison.getByText("Delta: Unavailable").first(),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      comparison.getByRole("heading", {
        name: "Saved recipe comparison",
        exact: true,
      }),
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
      .getByRole("button", { name: "Recipe library", exact: true })
      .click();
    await expect(
      page.getByRole("row").filter({ hasText: "Baseline saved" }),
    ).toContainText("approved");
  } finally {
    if (org) await db.query("DELETE FROM organizations WHERE id=$1", [org]);
    await db.query("DELETE FROM users WHERE email=ANY($1::text[])", [emails]);
    await db.end();
  }
});
