import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import pg from "pg";
test.use({ actionTimeout: 10000 });

test("retains reference provenance and imports an explicitly reconciled source only as a draft", async ({
  page,
}) => {
  test.setTimeout(90000);
  const ownerEmail = `source-owner-${randomUUID()}@test.invalid`,
    reviewerEmail = `source-reviewer-${randomUUID()}@test.invalid`;
  const password = "Synthetic source browser password 42",
    source =
      "Synthetic browser identity and source fixture only; not agricultural guidance";
  const headers = { Origin: "http://localhost:3000" };
  const secret = readFileSync(".local/postgres.env", "utf8").match(
    /POSTGRES_PASSWORD=(.+)/,
  )![1];
  const db = new pg.Pool({
    connectionString: `postgresql://postgres:${secret}@127.0.0.1:54329/farmstead`,
  });
  let org = "";
  async function open() {
    await page.goto("/");
    await page
      .getByRole("button", { name: "Feed studio", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Source catalog", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Reference category", exact: true })
      .selectOption("recipe");
  }
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
          data: { name: "Synthetic source recipe browser farm" },
        })
      ).json()
    ).id;
    expect(
      (
        await page.request.post("/api/imports/confirm", {
          headers,
          data: { organizationId: org, confirmed: true },
        })
      ).status(),
    ).toBe(201);
    await page.goto("/");
    await page
      .getByRole("button", { name: "Feed studio", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Ingredients", exact: true })
      .click();
    await page
      .getByRole("row")
      .filter({ has: page.getByText("Maize", { exact: true }) })
      .getByRole("button", { name: "Revise reference", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("Reference category", { exact: true })
      .fill("Synthetic grain");
    await dialog
      .getByLabel("Supplier / manufacturer", { exact: true })
      .fill("=Synthetic supplier");
    await dialog
      .getByLabel("Laboratory analysis date", { exact: true })
      .fill("2026-01-10");
    await dialog
      .getByLabel("Laboratory certificate / document reference", {
        exact: true,
      })
      .fill("Synthetic COA 42");
    await dialog
      .getByLabel("Quality and processing notes", { exact: true })
      .fill("Synthetic ground sample; no processing constraint is inferred.");
    await dialog
      .getByRole("textbox", {
        name: "Source and verification reference",
        exact: true,
      })
      .fill(source);
    await dialog
      .getByRole("button", { name: "Save reference revision", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    const feed = await (
      await page.request.get(`/api/feed?organizationId=${org}`)
    ).json();
    const revised = feed.ingredients.find(
      (i: { name: string; revision: number }) =>
        i.name === "Maize" && i.revision === 2,
    );
    expect(revised.supplier).toBe("=Synthetic supplier");
    await open();
    const panel = page.getByRole("region", {
      name: "Reviewed source recipe import",
      exact: true,
    });
    await panel
      .getByLabel("Imported recipe name", { exact: true })
      .fill("Synthetic source browser recipe");
    await panel
      .getByLabel("Imported batch weight (kg)", { exact: true })
      .fill("100");
    await panel
      .getByRole("button", { name: "Preview recipe import", exact: true })
      .click();
    await expect(panel.getByText(/30 rows have unspecified/)).toBeVisible();
    await expect(
      panel.getByRole("button", {
        name: "Import reviewed source as draft",
        exact: true,
      }),
    ).toBeDisabled();
    const user = await page.request.post("/api/auth/register", {
      headers,
      data: { email: reviewerEmail, password },
    });
    expect(user.ok()).toBe(true);
    const reviewer = (await user.json()).user.id;
    await db.query("INSERT INTO memberships VALUES($1,$2,'nutritionist')", [
      org,
      reviewer,
    ]);
    const catalog = await (
      await page.request.get(`/api/imports/catalog?organizationId=${org}`)
    ).json();
    const rows = catalog.filter(
      (r: {
        category: string;
        sheet: string;
        fields: { inclusion?: { parsed: { value?: number } } };
      }) =>
        r.category === "recipe" &&
        r.sheet === "Broiler Starter" &&
        (r.fields.inclusion?.parsed.value ?? 0) > 0,
    );
    for (const [index, row] of rows.entries()) {
      let ingredientId = revised.id;
      if (index > 0) {
        const created = await page.request.post("/api/ingredients", {
          headers,
          data: {
            organizationId: org,
            name: `Synthetic mapped ${row.label}`,
            source,
            price: 100,
            basis: null,
            energySystem: null,
            nutrients: {
              energy: 3000,
              protein: 20,
              dryMatter: null,
              calcium: 1,
              phosphorus: 0.5,
              methionine: null,
              lysine: 1,
            },
          },
        });
        expect(created.status()).toBe(201);
        ingredientId = (await created.json()).id;
      }
      expect(
        (
          await page.request.post(`/api/imports/catalog/${row.id}/reviews`, {
            headers,
            data: {
              organizationId: org,
              expectedRevision: 0,
              decision: "mapped",
              ingredientId,
              evidence: source,
              confirmed: true,
            },
          })
        ).status(),
      ).toBe(201);
    }
    await open();
    await panel
      .getByLabel("Imported recipe name", { exact: true })
      .fill("Synthetic source browser recipe");
    await panel
      .getByLabel("Imported batch weight (kg)", { exact: true })
      .fill("100");
    await panel
      .getByRole("button", { name: "Preview recipe import", exact: true })
      .click();
    await expect(
      panel.getByText(/Explicit source allocations total 100%/),
    ).toBeVisible();
    const downloaded = page.waitForEvent("download");
    await panel
      .getByRole("button", {
        name: "Download source recipe preview",
        exact: true,
      })
      .click();
    const preview = JSON.parse(
      readFileSync((await (await downloaded).path())!, "utf8"),
    );
    expect(preview.lines.map((l: { percent: number }) => l.percent)).toEqual([
      55, 10, 30, 5,
    ]);
    expect(preview.blockers).toEqual([]);
    await panel.getByRole("checkbox").check();
    await panel
      .getByRole("button", {
        name: "Import reviewed source as draft",
        exact: true,
      })
      .click();
    await expect(panel.getByRole("status")).toContainText("immutable draft");
    await expect(
      panel.getByRole("button", {
        name: "Import reviewed source as draft",
        exact: true,
      }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Recipe library", exact: true })
      .click();
    const recipe = page
      .getByRole("row")
      .filter({ hasText: "Synthetic source browser recipe" });
    await expect(recipe).toContainText("draft");
    const csvDownload = page.waitForEvent("download");
    await recipe.getByRole("button", { name: /Download CSV/ }).click();
    const csv = readFileSync((await (await csvDownload).path())!, "utf8");
    expect(csv).toContain("Source recipe audit");
    expect(csv).toContain("Synthetic COA 42");
    expect(csv).toContain("'=Synthetic supplier");
    expect(csv).toContain("NOT APPROVED");
    const xlsxDownload = page.waitForEvent("download");
    await recipe.getByRole("button", { name: /Download XLSX/ }).click();
    const exported = (await (await xlsxDownload).path())!;
    const content = JSON.parse(
      execFileSync(
        process.env.FARM_PYTHON ?? "python3",
        [
          "-c",
          "import json,sys;from openpyxl import load_workbook;w=load_workbook(open(sys.argv[1],'rb'),data_only=True);s=w['Source recipe audit'];print(json.dumps({'sheets':w.sheetnames,'blanks':sum(s.cell(r,3).value is None for r in range(7,41))}))",
          exported,
        ],
        { encoding: "utf8" },
      ),
    );
    expect(content.sheets).toHaveLength(5);
    expect(content.blanks).toBe(30);
    await page.reload();
    await page
      .getByRole("button", { name: "Feed studio", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Ingredients", exact: true })
      .click();
    await page
      .getByRole("row")
      .filter({ has: page.getByText("Maize", { exact: true }) })
      .getByRole("button", { name: "Revise reference", exact: true })
      .click();
    await expect(
      dialog.getByLabel("Laboratory certificate / document reference", {
        exact: true,
      }),
    ).toHaveValue("Synthetic COA 42");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await db.query(
      "UPDATE memberships SET role='auditor' WHERE organization_id=$1 AND user_id=$2",
      [org, reviewer],
    );
    await open();
    await panel
      .getByRole("button", { name: "Preview recipe import", exact: true })
      .click();
    await expect(
      panel.getByRole("button", {
        name: "Import reviewed source as draft",
        exact: true,
      }),
    ).toBeDisabled();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM formula_versions WHERE organization_id=$1",
          [org],
        )
      ).rows[0].count,
    ).toBe(1);
  } finally {
    if (org) await db.query("DELETE FROM organizations WHERE id=$1", [org]);
    await db.query("DELETE FROM users WHERE email=ANY($1::text[])", [
      [ownerEmail, reviewerEmail],
    ]);
    await db.end();
  }
});
