import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { admin } from "./admin-db";
import { pool, tenant } from "../src/lib/db";
import {
  inspectUpload,
  storeUpload,
  mapUpload,
  confirmUpload,
  workbookUploadApi,
} from "../src/lib/workbook-upload-api";
import { suggestMapping, type Inspection } from "../src/lib/upload-model";
let owner: string,
  other: string,
  auditor: string,
  org: string,
  foreignOrg: string,
  job: string,
  foreignJob: string,
  inspection: Inspection;
const bytes = readFileSync("data/source/Feed Formula Calculator.xlsx");
beforeAll(async () => {
  inspection = await inspectUpload(bytes);
  const users = [];
  for (let i = 0; i < 3; i++)
    users.push(
      (
        await admin.query(
          "INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id",
          [`${randomUUID()}@test.invalid`, "fixture"],
        )
      ).rows[0].id,
    );
  [owner, other, auditor] = users;
  org = await tenant(
    owner,
    async (c) =>
      (await c.query("SELECT create_organization('Upload tests') AS id"))
        .rows[0].id,
  );
  foreignOrg = await tenant(
    other,
    async (c) =>
      (await c.query("SELECT create_organization('Other uploads') AS id"))
        .rows[0].id,
  );
  await admin.query("INSERT INTO memberships VALUES($1,$2,'auditor')", [
    org,
    auditor,
  ]);
  job = (
    await tenant(owner, (c) =>
      storeUpload(c, org, "source.xlsx", bytes, inspection),
    )
  ).id;
  foreignJob = (
    await tenant(other, (c) =>
      storeUpload(c, foreignOrg, "source.xlsx", bytes, inspection),
    )
  ).id;
});
afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])", [
    [org, foreignOrg],
  ]);
  await admin.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
    [owner, other, auditor],
  ]);
  await pool.end();
  await admin.end();
});
it("deduplicates identical bytes per organization without leaking another tenant’s upload", async () => {
  const repeat = await tenant(owner, (c) =>
    storeUpload(c, org, "renamed.xlsx", bytes, inspection),
  );
  expect(repeat.id).toBe(job);
  expect(repeat.filename).toBe("source.xlsx");
  expect(foreignJob).not.toBe(job);
  expect(
    (
      await tenant(owner, (c) =>
        c.query("SELECT * FROM workbook_uploads WHERE organization_id=$1", [
          org,
        ]),
      )
    ).rowCount,
  ).toBe(1);
  expect(
    (
      await tenant(other, (c) =>
        c.query("SELECT * FROM workbook_uploads WHERE organization_id=$1", [
          org,
        ]),
      )
    ).rowCount,
  ).toBe(0);
});
it("retains original bytes and permits authorized, authenticated source downloads only", async () => {
  const response = await workbookUploadApi(
    new NextRequest(
      `http://localhost/api/workbook-uploads/${job}/download?organizationId=${org}`,
    ),
    { id: auditor },
    `workbook-uploads/${job}/download`,
  );
  expect(Buffer.from(await response!.arrayBuffer()).equals(bytes)).toBe(true);
  expect(response!.headers.get("cache-control")).toBe("private, no-store");
  await expect(
    workbookUploadApi(
      new NextRequest(
        `http://localhost/api/workbook-uploads/${job}/download?organizationId=${org}`,
      ),
      { id: other },
      `workbook-uploads/${job}/download`,
    ),
  ).rejects.toMatchObject({ status: 404 });
});
it("blocks confirmation before preview and when mapped formulas produce row errors", async () => {
  await expect(
    tenant(owner, (c) => confirmUpload(c, org, job, 0)),
  ).rejects.toMatchObject({ status: 422 });
  const mapping = suggestMapping(inspection);
  mapping.sheet = "Broiler Starter";
  mapping.firstRow = 8;
  mapping.lastRow = 8;
  mapping.columns = {
    name: "C",
    price: "L",
    energy: "E",
    protein: "F",
    dryMatter: "G",
    calcium: "H",
    phosphorus: "I",
    methionine: "J",
    lysine: "K",
  };
  const mapped = await tenant(owner, (c) => mapUpload(c, org, job, 0, mapping));
  expect(mapped.preview.errorCount).toBe(1);
  await expect(
    tenant(owner, (c) => confirmUpload(c, org, job, 1)),
  ).rejects.toMatchObject({ status: 422 });
  expect(
    (
      await tenant(owner, (c) =>
        c.query("SELECT * FROM ingredients WHERE organization_id=$1", [org]),
      )
    ).rowCount,
  ).toBe(0);
});
it("rejects stale mappings and confirmations, then imports atomically once under concurrency", async () => {
  const mapping = suggestMapping(inspection);
  await expect(
    tenant(owner, (c) => mapUpload(c, org, job, 0, mapping)),
  ).rejects.toMatchObject({ status: 409 });
  const valid = await tenant(owner, (c) => mapUpload(c, org, job, 1, mapping));
  expect(valid.revision).toBe(2);
  await expect(
    tenant(owner, (c) => confirmUpload(c, org, job, 1)),
  ).rejects.toMatchObject({ status: 409 });
  const [first, second] = await Promise.all([
    tenant(owner, (c) => confirmUpload(c, org, job, 2)),
    tenant(owner, (c) => confirmUpload(c, org, job, 2)),
  ]);
  expect(first.count).toBe(32);
  expect(second.count).toBe(32);
  expect([first.alreadyImported, second.alreadyImported].sort()).toEqual([
    false,
    true,
  ]);
  const rows = (
    await tenant(owner, (c) =>
      c.query("SELECT * FROM ingredients WHERE upload_id=$1", [job]),
    )
  ).rows;
  expect(rows).toHaveLength(32);
  expect(
    rows.every(
      (r) =>
        r.review_status === "unverified" &&
        r.basis === null &&
        r.quoted_on === null,
    ),
  ).toBe(true);
  expect(rows.find((r) => r.name === "Maize").price).toBe("230.0000");
  expect(
    rows.find((r) => r.name === "Defatted Soybean meal").nutrients.methionine,
  ).toBeNull();
  expect(
    (
      await tenant(owner, (c) =>
        c.query(
          "SELECT * FROM audit_logs WHERE organization_id=$1 AND action='workbook.imported'",
          [org],
        ),
      )
    ).rowCount,
  ).toBe(1);
});
it("preserves confirmed mappings, source bytes and ingredient tenant-parent integrity", async () => {
  await expect(
    tenant(owner, (c) => mapUpload(c, org, job, 2, suggestMapping(inspection))),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    tenant(owner, (c) =>
      c.query("UPDATE workbook_uploads SET state='uploaded' WHERE id=$1", [
        job,
      ]),
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    tenant(owner, (c) =>
      c.query(
        "UPDATE workbook_uploads SET filename='changed.xlsx' WHERE id=$1",
        [job],
      ),
    ),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    tenant(owner, (c) =>
      c.query(
        "INSERT INTO ingredients(organization_id,name,source,nutrients,upload_id,upload_row) VALUES($1,'Forged','source','{}',$2,1)",
        [org, foreignJob],
      ),
    ),
  ).rejects.toMatchObject({ code: "23503" });
});
it("denies auditor and outsider writes without changing upload state", async () => {
  await expect(
    tenant(auditor, (c) =>
      storeUpload(c, org, "other.xlsx", bytes, inspection),
    ),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    tenant(auditor, (c) => confirmUpload(c, org, job, 2)),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    tenant(other, (c) => mapUpload(c, org, job, 2, suggestMapping(inspection))),
  ).rejects.toMatchObject({ status: 403 });
});
