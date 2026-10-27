import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import books from "../data/workbook-audit.json";
import { admin } from "./admin-db";
import { pool, tenant } from "../src/lib/db";
import { stageCatalog } from "../src/lib/catalog-api";
let owner: string,
  other: string,
  auditor: string,
  org: string,
  foreignOrg: string,
  old: string,
  job: string;
beforeAll(async () => {
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
      (await c.query("SELECT create_organization('Reference tests') AS id"))
        .rows[0].id,
  );
  foreignOrg = await tenant(
    other,
    async (c) =>
      (await c.query("SELECT create_organization('Foreign references') AS id"))
        .rows[0].id,
  );
  await admin.query("INSERT INTO memberships VALUES($1,$2,'auditor')", [
    org,
    auditor,
  ]);
  old = (
    await tenant(owner, (c) =>
      c.query(
        "INSERT INTO ingredients(organization_id,name,source,nutrients,price) VALUES($1,'Maize','Original source','{\"protein\":9}',230) RETURNING id",
        [org],
      ),
    )
  ).rows[0].id;
  job = (
    await tenant(owner, (c) =>
      c.query(
        "INSERT INTO imports(organization_id,source_hashes,raw_data) VALUES($1,$2,'[]') RETURNING id",
        [
          org,
          JSON.stringify(
            books.map((w) => ({ file: w.file, sha256: w.sha256 })),
          ),
        ],
      ),
    )
  ).rows[0].id;
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
it("stages a complete catalog once and lets an auditor read real rows", async () => {
  expect(await tenant(owner, (c) => stageCatalog(c, org, job))).toBe(220);
  expect(await tenant(owner, (c) => stageCatalog(c, org, job))).toBe(0);
  expect(
    (
      await tenant(auditor, (c) =>
        c.query(
          "SELECT * FROM import_reference_rows WHERE organization_id=$1",
          [org],
        ),
      )
    ).rowCount,
  ).toBe(220);
  expect(
    (
      await tenant(other, (c) =>
        c.query(
          "SELECT * FROM import_reference_rows WHERE organization_id=$1",
          [org],
        ),
      )
    ).rowCount,
  ).toBe(0);
});
it("denies outsider and auditor catalog writes and cross-tenant import references", async () => {
  const insert = (user: string, target: string) =>
    tenant(user, (c) =>
      c.query(
        "INSERT INTO import_reference_rows(organization_id,import_id,source_hash,sheet,source_row,category,label,context,fields,issues) VALUES($1,$2,'fixture','Test',1,'requirement','Test','Test','{}','[]')",
        [target, job],
      ),
    );
  await expect(insert(auditor, org)).rejects.toMatchObject({ code: "42501" });
  await expect(insert(other, org)).rejects.toMatchObject({ code: "42501" });
  await expect(insert(other, foreignOrg)).rejects.toMatchObject({
    code: "23503",
  });
});
it("appends revisions without changing historical references or recipe snapshots", async () => {
  await tenant(owner, async (c) => {
    await c.query(
      "INSERT INTO formula_versions(organization_id,name,batch_kg,lines,ingredient_snapshot,result) VALUES($1,'Historical recipe',100,'[]',$2,'{}')",
      [org, JSON.stringify([{ id: old, price: "230.0000" }])],
    );
    await c.query(
      "INSERT INTO ingredients(organization_id,parent_id,revision,name,source,nutrients,price) VALUES($1,$2,2,'Maize','New quote','{\"protein\":10}',500)",
      [org, old],
    );
  });
  const previous = (
    await tenant(owner, (c) =>
      c.query("SELECT * FROM ingredients WHERE id=$1", [old]),
    )
  ).rows[0];
  expect(previous.price).toBe("230.0000");
  expect(previous.nutrients.protein).toBe(9);
  expect(
    (
      await tenant(owner, (c) =>
        c.query(
          "SELECT ingredient_snapshot FROM formula_versions WHERE organization_id=$1",
          [org],
        ),
      )
    ).rows[0].ingredient_snapshot[0].price,
  ).toBe("230.0000");
  await expect(
    tenant(owner, (c) =>
      c.query("UPDATE ingredients SET price=1 WHERE id=$1", [old]),
    ),
  ).rejects.toMatchObject({ code: "42501" });
});
it("rejects invalid lineage, concurrent successors and inherited scientific approval", async () => {
  await expect(
    tenant(other, (c) =>
      c.query(
        "INSERT INTO ingredients(organization_id,parent_id,revision,name,source,nutrients) VALUES($1,$2,2,'Forged','source','{}')",
        [foreignOrg, old],
      ),
    ),
  ).rejects.toMatchObject({ code: "23503" });
  await expect(
    tenant(owner, (c) =>
      c.query(
        "INSERT INTO ingredients(organization_id,parent_id,revision,name,source,nutrients) VALUES($1,$2,3,'Wrong version','source','{}')",
        [org, old],
      ),
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    tenant(owner, (c) =>
      c.query(
        "INSERT INTO ingredients(organization_id,parent_id,revision,name,source,nutrients) VALUES($1,$2,2,'Duplicate successor','source','{}')",
        [org, old],
      ),
    ),
  ).rejects.toMatchObject({ code: "23505" });
  await expect(
    tenant(owner, (c) =>
      c.query(
        "INSERT INTO ingredients(organization_id,review_status,name,source,nutrients) VALUES($1,'approved','Unsafe','source','{}')",
        [org],
      ),
    ),
  ).rejects.toMatchObject({ code: "42501" });
});
it("refuses to attribute bundled source rows to a different imported workbook version", async () => {
  const wrong = (
    await tenant(owner, (c) =>
      c.query(
        "INSERT INTO imports(organization_id,source_hashes,raw_data) VALUES($1,'[]','[]') RETURNING id",
        [org],
      ),
    )
  ).rows[0].id;
  await expect(
    tenant(owner, (c) => stageCatalog(c, org, wrong)),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (
      await tenant(owner, (c) =>
        c.query("SELECT * FROM import_reference_rows WHERE import_id=$1", [
          wrong,
        ]),
      )
    ).rowCount,
  ).toBe(0);
});
it("lets nutritionists approve a new revision while the reviewed source stays immutable", async () => {
  await admin.query(
    "UPDATE memberships SET role='nutritionist' WHERE organization_id=$1 AND user_id=$2",
    [org, auditor],
  );
  await expect(
    tenant(auditor, (c) =>
      c.query("UPDATE ingredients SET review_status='approved' WHERE id=$1", [
        old,
      ]),
    ),
  ).rejects.toMatchObject({ code: "42501" });
  const parent = (
    await tenant(auditor, (c) =>
      c.query("SELECT id FROM ingredients WHERE parent_id=$1", [old]),
    )
  ).rows[0].id;
  await tenant(auditor, (c) =>
    c.query(
      "INSERT INTO ingredients(organization_id,parent_id,revision,name,source,nutrients,price,review_status,basis,energy_system,verified_at,reviewer_id,species,stages,phosphorus_basis,quoted_on) VALUES($1,$2,3,'Maize','Qualified review fixture','{\"protein\":10}',500,'approved','as-fed','ME',now(),current_actor(),'poultry',ARRAY['starter'],'total',current_date)",
      [org, parent],
    ),
  );
  const versions = (
    await tenant(auditor, (c) =>
      c.query(
        "SELECT revision,review_status FROM ingredients WHERE organization_id=$1 ORDER BY revision",
        [org],
      ),
    )
  ).rows;
  expect(versions).toEqual([
    { revision: 1, review_status: "unverified" },
    { revision: 2, review_status: "unverified" },
    { revision: 3, review_status: "approved" },
  ]);
});
