import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import pg from "pg";
test("uploads, maps, previews and confirms unverified ingredients with retained sources", async ({
  page,
}) => {
  test.setTimeout(60000);
  const email = `upload-browser-${randomUUID()}@test.invalid`;
  let org = "";
  let otherOrg = "";
  const password = readFileSync(".local/postgres.env", "utf8").match(
    /POSTGRES_PASSWORD=(.+)/,
  )![1];
  const db = new pg.Pool({
    connectionString: `postgresql://postgres:${password}@127.0.0.1:54329/farmstead`,
  });
  try {
    expect(
      (
        await page.request.post("/api/auth/register", {
          headers: { Origin: "http://localhost:3000" },
          data: { email, password: "Test-only upload password 42" },
        })
      ).status(),
    ).toBe(200);
    const created = await page.request.post("/api/organizations", {
      headers: { Origin: "http://localhost:3000" },
      data: { name: "Workbook upload farm" },
    });
    org = (await created.json()).id;
    await page.goto("/");
    await page
      .getByRole("button", { name: "Feed studio", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Workbook import", exact: true })
      .click();
    await page
      .getByLabel("Ingredient workbook (.xlsx)", { exact: true })
      .setInputFiles({
        name: "invalid.xlsx",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("not a workbook"),
      });
    await page.getByRole("button", { name: "Upload and inspect" }).click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Invalid or unsupported workbook" }),
    ).toBeVisible();
    await page
      .getByLabel("Ingredient workbook (.xlsx)", { exact: true })
      .setInputFiles("data/source/Feed Formula Calculator.xlsx");
    await page.getByRole("button", { name: "Upload and inspect" }).click();
    await expect(
      page.getByRole("combobox", { name: "Ingredient worksheet", exact: true }),
    ).toHaveValue("Nutritional Intake");
    await expect(
      page.getByRole("combobox", {
        name: "Ingredient name column",
        exact: true,
      }),
    ).toHaveValue("B");
    await expect(
      page.getByLabel("First data row", { exact: true }),
    ).toHaveValue("7");
    await page
      .getByRole("combobox", { name: "Concentration units", exact: true })
      .selectOption("fraction");
    await page.getByRole("button", { name: "Preview mapped rows" }).click();
    await expect(
      page.getByRole("button", {
        name: /^Confirm \d+ unverified ingredient references$/,
      }),
    ).toBeDisabled();
    await page
      .getByRole("combobox", { name: "Preview row filter", exact: true })
      .selectOption("error");
    await expect(
      page.getByText(/converted protein is outside/).first(),
    ).toBeVisible();
    await page
      .getByRole("combobox", { name: "Concentration units", exact: true })
      .selectOption("percent");
    await page.getByRole("button", { name: "Preview mapped rows" }).click();
    await page
      .getByRole("combobox", { name: "Preview row filter", exact: true })
      .selectOption("all");
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "32 valid rows · 0 row errors" }),
    ).toBeVisible();
    await page
      .getByRole("button", {
        name: "Confirm 32 unverified ingredient references",
        exact: true,
      })
      .click();
    await expect(
      page.getByText(
        "32 unverified ingredient references imported from uploaded workbook.",
      ),
    ).toBeVisible();
    await expect(
      page
        .getByRole("row")
        .filter({ has: page.getByText("Maize", { exact: true }) }),
    ).toContainText("230.0000");
    await page
      .getByRole("button", { name: "Workbook import", exact: true })
      .click();
    const list = page.getByRole("combobox", {
      name: "Uploaded workbook history (latest 100)",
      exact: true,
    });
    const value = await list.locator("option").last().getAttribute("value");
    expect(value).toBeTruthy();
    await list.selectOption(value!);
    await expect(
      page.getByRole("button", { name: "Import confirmed", exact: true }),
    ).toBeDisabled();
    const rawDownload = page.waitForEvent("download");
    await page
      .getByRole("link", { name: "Download original workbook" })
      .click();
    const raw = await rawDownload;
    const original = readFileSync("data/source/Feed Formula Calculator.xlsx");
    expect(
      createHash("sha256")
        .update(readFileSync((await raw.path())!))
        .digest("hex"),
    ).toBe(createHash("sha256").update(original).digest("hex"));
    const reportDownload = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download import report CSV" })
      .click();
    const report = await reportDownload;
    expect(readFileSync((await report.path())!, "utf8")).toContain(
      "Unverified: nutrient bases",
    );
    const other = await page.request.post("/api/organizations", {
      headers: { Origin: "http://localhost:3000" },
      data: { name: "Other upload scope" },
    });
    otherOrg = (await other.json()).id;
    expect(
      (
        await page.request.get(
          `/api/workbook-uploads/${value}/download?organizationId=${otherOrg}`,
        )
      ).status(),
    ).toBe(404);
    const duplicate = await page.request.post("/api/workbook-uploads", {
      headers: { Origin: "http://localhost:3000" },
      multipart: {
        organizationId: org,
        file: {
          name: "same-bytes.xlsx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          buffer: original,
        },
      },
    });
    expect((await duplicate.json()).id).toBe(value);
    const feed = await page.request.get(`/api/feed?organizationId=${org}`);
    expect((await feed.json()).ingredients).toHaveLength(32);
  } finally {
    await db.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])", [
      [org, otherOrg].filter(Boolean),
    ]);
    await db.query("DELETE FROM users WHERE email=$1", [email]);
    await db.end();
  }
});
