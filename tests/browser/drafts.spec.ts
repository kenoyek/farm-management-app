import { test as base, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
const test = base.extend<{ organizationId: string }>({
  organizationId: async ({ page }, provide) => {
    const email = `draft-browser-${randomUUID()}@test.invalid`;
    let org = "";
    const password = readFileSync(".local/postgres.env", "utf8").match(
      /POSTGRES_PASSWORD=(.+)/,
    )![1];
    const db = new pg.Pool({
      connectionString: `postgresql://postgres:${password}@127.0.0.1:54329/farmstead`,
    });
    try {
      const account = await page.request.post("/api/auth/register", {
        headers: { Origin: "http://localhost:3000" },
        data: { email, password: "Test-only password phrase 42" },
      });
      expect(account.status()).toBe(200);
      const created = await page.request.post("/api/organizations", {
        headers: { Origin: "http://localhost:3000" },
        data: { name: "Draft browser farm" },
      });
      expect(created.status()).toBe(201);
      org = (await created.json()).id;
      await page.goto("/");
      await page
        .getByRole("button", { name: "Feed studio", exact: true })
        .click();
      await expect(
        page.getByLabel("Recipe name", { exact: true }),
      ).toBeEnabled();
      await provide(org);
    } finally {
      if (org) await db.query("DELETE FROM organizations WHERE id=$1", [org]);
      await db.query("DELETE FROM users WHERE email=$1", [email]);
      await db.end();
    }
  },
});
test("autosaves a private draft and restores it after navigation and reload", async ({
  page,
  organizationId,
}) => {
  await page
    .getByLabel("Recipe name", { exact: true })
    .fill("Survives navigation");
  await page.getByLabel("Batch weight (kg)", { exact: true }).fill("125");
  await page.getByRole("button", { name: "My farms", exact: true }).click();
  await page.getByRole("button", { name: "Feed studio", exact: true }).click();
  await expect(page.getByLabel("Recipe name", { exact: true })).toHaveValue(
    "Survives navigation",
  );
  await expect(
    page.getByLabel("Batch weight (kg)", { exact: true }),
  ).toHaveValue("125");
  await expect(page.getByText("Draft saved", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Feed studio", exact: true }).click();
  await expect(page.getByLabel("Recipe name", { exact: true })).toHaveValue(
    "Survives navigation",
  );
  const persisted = await page.request.get(
    `/api/formulation-draft?organizationId=${organizationId}`,
  );
  expect((await persisted.json()).draft.content.batchKg).toBe(125);
});
test("keeps two-tab conflicts local until the user chooses the saved draft", async ({
  page,
  context,
  organizationId,
}) => {
  await page
    .getByLabel("Recipe name", { exact: true })
    .fill("Shared starting point");
  await expect(page.getByText("Draft saved", { exact: true })).toBeVisible();
  const second = await context.newPage();
  await second.goto("/");
  await second
    .getByRole("button", { name: "Feed studio", exact: true })
    .click();
  await expect(second.getByLabel("Recipe name", { exact: true })).toHaveValue(
    "Shared starting point",
  );
  await page
    .getByLabel("Recipe name", { exact: true })
    .fill("Latest server draft");
  await expect(page.getByText("Draft saved", { exact: true })).toBeVisible();
  await second
    .getByLabel("Recipe name", { exact: true })
    .fill("Local copy to preserve");
  await expect(
    second.getByText("Draft conflict", { exact: true }),
  ).toBeVisible();
  const download = second.waitForEvent("download");
  await second.getByRole("button", { name: "Download local draft" }).click();
  const file = await download;
  expect(JSON.parse(readFileSync((await file.path())!, "utf8")).name).toBe(
    "Local copy to preserve",
  );
  const persisted = await page.request.get(
    `/api/formulation-draft?organizationId=${organizationId}`,
  );
  expect((await persisted.json()).draft.content.name).toBe(
    "Latest server draft",
  );
  second.once("dialog", (dialog) => void dialog.accept());
  await second.getByRole("button", { name: "Load saved draft" }).click();
  await expect(second.getByLabel("Recipe name", { exact: true })).toHaveValue(
    "Latest server draft",
  );
  await expect(second.getByText("Draft saved", { exact: true })).toBeVisible();
  await second.close();
});
test("recovers failed saves when returning to the editor, then retries online", async ({
  page,
  organizationId,
}) => {
  await page.route("**/api/formulation-draft*", (route) =>
    route.request().method() === "POST"
      ? route.abort("failed")
      : route.continue(),
  );
  await page
    .getByLabel("Recipe name", { exact: true })
    .fill("Offline recovery copy");
  await expect(
    page.getByRole("alert").filter({ hasText: "Draft not saved:" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "My farms", exact: true }).click();
  await page.getByRole("button", { name: "Feed studio", exact: true }).click();
  await expect(page.getByLabel("Recipe name", { exact: true })).toHaveValue(
    "Offline recovery copy",
  );
  await expect(
    page.getByRole("alert").filter({ hasText: "Draft not saved:" }),
  ).toBeVisible();
  await page.unroute("**/api/formulation-draft*");
  await page.getByRole("button", { name: "Retry draft save" }).click();
  await expect(page.getByText("Draft saved", { exact: true })).toBeVisible();
  const persisted = await page.request.get(
    `/api/formulation-draft?organizationId=${organizationId}`,
  );
  expect((await persisted.json()).draft.content.name).toBe(
    "Offline recovery copy",
  );
});
test("blocks editing until a saved draft can be loaded and offers a retry", async ({
  page,
  organizationId,
}) => {
  await page
    .getByLabel("Recipe name", { exact: true })
    .fill("Saved before connection issue");
  await expect(page.getByText("Draft saved", { exact: true })).toBeVisible();
  let writes = 0;
  await page.route("**/api/formulation-draft*", (route) => {
    if (route.request().method() === "GET") return route.abort("failed");
    writes++;
    return route.continue();
  });
  await page.getByRole("button", { name: "My farms", exact: true }).click();
  await page.getByRole("button", { name: "Feed studio", exact: true }).click();
  await expect(
    page.getByText("Draft unavailable", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Recipe name", { exact: true })).toBeDisabled();
  expect(writes).toBe(0);
  await page.unroute("**/api/formulation-draft*");
  await page.getByRole("button", { name: "Load saved draft" }).click();
  await expect(page.getByLabel("Recipe name", { exact: true })).toHaveValue(
    "Saved before connection issue",
  );
  await expect(page.getByLabel("Recipe name", { exact: true })).toBeEnabled();
  expect(
    (
      await (
        await page.request.get(
          `/api/formulation-draft?organizationId=${organizationId}`,
        )
      ).json()
    ).draft.content.name,
  ).toBe("Saved before connection issue");
});
