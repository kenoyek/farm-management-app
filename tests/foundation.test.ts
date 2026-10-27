import { admin } from "./admin-db";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { pool, tenant, audit } from "../src/lib/db";
import {
  hashPassword,
  verifyPassword,
  createSession,
  sessionUser,
  tokenHash,
} from "../src/lib/auth";
import { farmInput, credentials } from "../src/lib/validation";
import { checkOrigin, jsonBody } from "../src/lib/http";
const users: string[] = [];
const orgs: string[] = [];
let owner: string, other: string, auditor: string, org: string;
beforeAll(async () => {
  for (let i = 0; i < 3; i++)
    users.push(
      (
        await admin.query(
          "INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id",
          [`${randomUUID()}@test.invalid`, "test-only"],
        )
      ).rows[0].id,
    );
  [owner, other, auditor] = users;
  org = await tenant(
    owner,
    async (c) =>
      (await c.query("SELECT create_organization('Test organization') AS id"))
        .rows[0].id,
  );
  orgs.push(org);
  await admin.query("INSERT INTO memberships VALUES($1,$2,'auditor')", [
    org,
    auditor,
  ]);
});
afterAll(async () => {
  await admin.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])", [
    orgs,
  ]);
  await admin.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [users]);
  await pool.end();
  await admin.end();
});
describe("identity", () => {
  it("uses salted password hashes and rejects wrong passwords", async () => {
    const h = await hashPassword("correct horse battery staple");
    expect(h).not.toContain("correct horse");
    expect(await verifyPassword("correct horse battery staple", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
    expect(await hashPassword("correct horse battery staple")).not.toBe(h);
  });
  it("persists hashed sessions and enforces expiry and revocation", async () => {
    const t = await createSession(owner);
    expect((await sessionUser(t))?.id).toBe(owner);
    expect(
      (
        await admin.query("SELECT token_hash FROM sessions WHERE user_id=$1", [
          owner,
        ])
      ).rows[0].token_hash,
    ).toBe(tokenHash(t));
    await admin.query(
      "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
      [tokenHash(t)],
    );
    expect(await sessionUser(t)).toBe(null);
    await admin.query("DELETE FROM sessions WHERE user_id=$1", [owner]);
    expect(await sessionUser(t)).toBe(null);
  });
  it("rejects weak passwords and malformed records", () => {
    expect(
      credentials.safeParse({ email: "a@b.com", password: "short" }).success,
    ).toBe(false);
    expect(
      farmInput.safeParse({ organizationId: org, name: "", kind: "unknown" })
        .success,
    ).toBe(false);
  });
  it("rejects absent or foreign origins", () => {
    expect(() =>
      checkOrigin(
        new Request("http://localhost/api/farms", { method: "POST" }),
      ),
    ).toThrow();
    expect(() =>
      checkOrigin(
        new Request("http://localhost/api/farms", {
          headers: { Origin: "https://evil.invalid" },
        }),
      ),
    ).toThrow();
    expect(() =>
      checkOrigin(
        new Request("http://localhost/api/farms", {
          headers: { Origin: "http://localhost" },
        }),
      ),
    ).not.toThrow();
  });
  it("rejects malformed and oversized JSON", async () => {
    await expect(
      jsonBody(
        new Request("http://local", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        }),
      ),
    ).rejects.toThrow();
    await expect(
      jsonBody(
        new Request("http://local", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "x".repeat(256001),
        }),
      ),
    ).rejects.toThrow();
  });
});
describe("actual PostgreSQL runtime RLS", () => {
  it("runs as non-bypass role with transaction-local actor", async () => {
    await tenant(owner, async (c) => {
      const r = (await c.query("SELECT current_user,current_actor() AS actor"))
        .rows[0];
      expect(r.current_user).toBe("farm_app");
      expect(r.actor).toBe(owner);
    });
    const c = await pool.connect();
    try {
      expect(
        (
          await c.query(
            "SELECT nullif(current_setting('app.user_id',true),'') AS actor",
          )
        ).rows[0].actor,
      ).toBe(null);
    } finally {
      c.release();
    }
  });
  it("creates owner membership and audit atomically", async () => {
    const r = await tenant(
      owner,
      async (c) =>
        (
          await c.query(
            "SELECT role FROM memberships WHERE organization_id=$1",
            [org],
          )
        ).rows,
    );
    expect(r.some((r) => r.role === "owner")).toBe(true);
    expect(
      (
        await tenant(
          owner,
          async (c) =>
            (
              await c.query(
                "SELECT * FROM audit_logs WHERE organization_id=$1",
                [org],
              )
            ).rows,
        )
      ).length,
    ).toBe(1);
  });
  it("persists farms and denies foreign tenant reads and writes", async () => {
    await tenant(owner, async (c) => {
      const f = (
        await c.query(
          "INSERT INTO farms(organization_id,name,kind) VALUES($1,'Real farm','layers') RETURNING id",
          [org],
        )
      ).rows[0];
      await audit(c, org, "farm.created", f.id);
    });
    expect(
      (
        await tenant(
          owner,
          async (c) =>
            (
              await c.query("SELECT * FROM farms WHERE organization_id=$1", [
                org,
              ])
            ).rows,
        )
      ).length,
    ).toBe(1);
    expect(
      (
        await tenant(
          other,
          async (c) =>
            (
              await c.query("SELECT * FROM farms WHERE organization_id=$1", [
                org,
              ])
            ).rows,
        )
      ).length,
    ).toBe(0);
    await expect(
      tenant(other, (c) =>
        c.query(
          "INSERT INTO farms(organization_id,name,kind) VALUES($1,'Forged farm','layers')",
          [org],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it("allows auditors to read but not create or mutate farms", async () => {
    expect(
      (
        await tenant(
          auditor,
          async (c) =>
            (
              await c.query("SELECT * FROM farms WHERE organization_id=$1", [
                org,
              ])
            ).rows,
        )
      ).length,
    ).toBe(1);
    await expect(
      tenant(auditor, (c) =>
        c.query(
          "INSERT INTO farms(organization_id,name,kind) VALUES($1,'Forbidden farm','mixed')",
          [org],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    expect(
      (
        await tenant(auditor, (c) =>
          c.query("UPDATE farms SET name='Tampered' WHERE organization_id=$1", [
            org,
          ]),
        )
      ).rowCount,
    ).toBe(0);
  });
  it("cannot alter identities, roles or audit history", async () => {
    await expect(
      tenant(other, (c) => c.query("SELECT password_hash FROM users")),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      tenant(other, (c) =>
        c.query("INSERT INTO memberships VALUES($1,$2,'owner')", [org, other]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      tenant(owner, (c) =>
        c.query("DELETE FROM audit_logs WHERE organization_id=$1", [org]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

it("protects owner membership and restricts team changes to administrators", async () => {
  await expect(
    tenant(other, (c) =>
      c.query("SELECT change_team_member($1,$2,$3)", [org, auditor, "admin"]),
    ),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    tenant(owner, (c) =>
      c.query("SELECT change_team_member($1,$2,$3)", [org, owner, "worker"]),
    ),
  ).rejects.toMatchObject({ code: "42501" });
  await tenant(owner, (c) =>
    c.query("SELECT change_team_member($1,$2,$3)", [org, auditor, "manager"]),
  );
  expect(
    (
      await tenant(auditor, (c) =>
        c.query("SELECT member_role($1) AS role", [org]),
      )
    ).rows[0].role,
  ).toBe("manager");
  await tenant(owner, (c) =>
    c.query("SELECT change_team_member($1,$2,NULL)", [org, auditor]),
  );
  expect(
    (
      await tenant(auditor, (c) =>
        c.query("SELECT * FROM organizations WHERE id=$1", [org]),
      )
    ).rowCount,
  ).toBe(0);
});
