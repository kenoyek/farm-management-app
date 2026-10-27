import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";

test("reviews exact source mappings, preserves history and handles stale tabs without approval", async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  const ownerEmail = `alias-owner-${randomUUID()}@test.invalid`;
  const reviewerEmail = `alias-reviewer-${randomUUID()}@test.invalid`;
  const password = "Synthetic browser-only identity password 42";
  const evidence =
    "Synthetic browser identity fixture only; not scientific evidence";
  const headers = { Origin: "http://localhost:3000" };
  const secret = readFileSync(".local/postgres.env", "utf8").match(
    /POSTGRES_PASSWORD=(.+)/,
  )![1];
  const db = new pg.Pool({
    connectionString: `postgresql://postgres:${secret}@127.0.0.1:54329/farmstead`,
  });
  let org = "";
  const entry = (p: Page) =>
    p
      .locator(".catalog-entry")
      .filter({
        has: p.locator("summary").filter({ hasText: "Broiler Starter" }),
      });
  async function open(p: Page) {
    await p.goto("/");
    await p.getByRole("button", { name: "Feed studio", exact: true }).click();
    await p
      .getByRole("button", { name: "Source catalog", exact: true })
      .click();
    await p.getByLabel("Reference category").selectOption("recipe");
    await p.getByLabel("Search source labels").fill("Limestone");
    await expect(entry(p)).toHaveCount(1);
    await entry(p).locator("summary").click();
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
          data: { name: "Synthetic alias review farm" },
        })
      ).json()
    ).id;
    expect(
      (
        await page.request.post("/api/imports/confirm", {
          headers,
          data: { organizationId: org, confirmed: true },
        })
      ).ok(),
    ).toBe(true);
    const reference = await page.request.post("/api/ingredients", {
      headers,
      data: {
        organizationId: org,
        name: "Synthetic calcium product",
        source: evidence,
        price: null,
        basis: null,
        energySystem: null,
        nutrients: {
          energy: null,
          protein: null,
          dryMatter: null,
          calcium: null,
          phosphorus: null,
          methionine: null,
          lysine: null,
        },
      },
    });
    expect(reference.status()).toBe(201);
    const ingredient = (await reference.json()).id;
    const registered = await page.request.post("/api/auth/register", {
      headers,
      data: { email: reviewerEmail, password },
    });
    expect(registered.ok()).toBe(true);
    const reviewer = (await registered.json()).user.id;
    await db.query("INSERT INTO memberships VALUES($1,$2,'nutritionist')", [
      org,
      reviewer,
    ]);
    await open(page);
    await entry(page)
      .getByRole("button", { name: "Review mapping", exact: true })
      .click();
    const form = entry(page).getByRole("form");
    await form.getByLabel("Alias decision").selectOption("mapped");
    await expect(form.getByLabel("Exact ingredient reference")).toHaveValue("");
    await form
      .getByLabel("Exact ingredient reference")
      .selectOption(ingredient);
    await form.getByLabel("Identity review evidence").fill(evidence);
    await form.getByRole("checkbox").check();
    await form
      .getByRole("button", { name: "Save alias decision", exact: true })
      .click();
    await expect(entry(page).getByRole("status")).toContainText(
      "Alias decision saved",
    );
    await expect(
      entry(page).getByText("mapped · review v1", { exact: false }),
    ).toBeVisible();
    const second = await context.newPage();
    await open(second);
    await entry(second)
      .getByRole("button", { name: "Review mapping", exact: true })
      .click();
    const stale = entry(second).getByRole("form");
    await stale.getByLabel("Alias decision").selectOption("rejected");
    await stale
      .getByLabel("Identity review evidence")
      .fill("Stale synthetic decision; must not overwrite newer evidence");
    await stale.getByRole("checkbox").check();
    await entry(page)
      .getByRole("button", { name: "Review mapping", exact: true })
      .click();
    await form.getByLabel("Alias decision").selectOption("unresolved");
    await form
      .getByLabel("Identity review evidence")
      .fill("Synthetic identity requires more product evidence");
    await form.getByRole("checkbox").check();
    await form
      .getByRole("button", { name: "Save alias decision", exact: true })
      .click();
    await expect(
      entry(page).getByText("unresolved · review v2", { exact: false }),
    ).toBeVisible();
    await stale
      .getByRole("button", { name: "Save alias decision", exact: true })
      .click();
    await expect(entry(second).getByRole("alert")).toContainText(
      "changed in another session",
    );
    await expect(stale.getByLabel("Identity review evidence")).toHaveValue(
      "Stale synthetic decision; must not overwrite newer evidence",
    );
    await expect(
      stale.getByRole("button", { name: "Save alias decision", exact: true }),
    ).toBeDisabled();
    await stale
      .getByRole("button", {
        name: "Reload latest review (discard edits)",
        exact: true,
      })
      .click();
    await expect(stale.getByLabel("Alias decision")).toHaveValue("unresolved");
    await stale.getByLabel("Alias decision").selectOption("rejected");
    await stale
      .getByLabel("Identity review evidence")
      .fill("Synthetic reviewed rejection of the original workbook alias");
    await stale.getByRole("checkbox").check();
    await stale
      .getByRole("button", { name: "Save alias decision", exact: true })
      .click();
    await expect(
      entry(second).getByText("rejected · review v3", { exact: true }),
    ).toBeVisible();
    await expect(
      entry(second).getByText("v1 · mapped", { exact: true }),
    ).toBeVisible();
    const downloadPromise = second.waitForEvent("download");
    await entry(second)
      .getByRole("button", { name: "Download review evidence", exact: true })
      .click();
    const download = await downloadPromise;
    const exported = JSON.parse(readFileSync((await download.path())!, "utf8"));
    expect(
      exported.reviews.map((r: { revision: number }) => r.revision),
    ).toEqual([3, 2, 1]);
    expect(exported.reviews[2].ingredient_id).toBe(ingredient);
    expect(exported.source.issues.join(" ")).toContain("Oyster Shell");
    expect(exported.source.source_hash).toHaveLength(64);
    await open(second);
    await expect(
      entry(second).getByText("rejected · review v3", { exact: true }),
    ).toBeVisible();
    await second.getByLabel("Alias review status").selectOption("mapped");
    await expect(second.locator(".catalog-entry")).toHaveCount(0);
    await second.getByLabel("Alias review status").selectOption("rejected");
    await expect(second.locator(".catalog-entry")).toHaveCount(1);
    await second.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        second.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      )
      .toBe(true);
    expect(
      (
        await db.query("SELECT review_status FROM ingredients WHERE id=$1", [
          ingredient,
        ])
      ).rows[0].review_status,
    ).toBe("unverified");
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM formula_versions WHERE organization_id=$1",
          [org],
        )
      ).rows[0].count,
    ).toBe(0);
    await second.close();
    expect(
      (
        await page.request.post("/api/auth/login", {
          headers,
          data: { email: ownerEmail, password },
        })
      ).ok(),
    ).toBe(true);
    await open(page);
    await expect(
      entry(page).getByRole("button", { name: "Review mapping", exact: true }),
    ).toHaveCount(0);
    await entry(page)
      .getByRole("button", { name: "View review history", exact: true })
      .click();
    await expect(
      entry(page).getByText("v3 · rejected", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Preview source references", exact: true })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "Source reference catalog · preview",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", {
        name: "Alias review for Limestone",
        exact: true,
      }),
    ).toHaveCount(0);
  } finally {
    if (org) await db.query("DELETE FROM organizations WHERE id=$1", [org]);
    await db.query("DELETE FROM users WHERE email=ANY($1::text[])", [
      [ownerEmail, reviewerEmail],
    ]);
    await db.end();
  }
});
