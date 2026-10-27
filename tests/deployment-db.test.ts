import { beforeAll, afterAll, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

// An isolated cluster keeps global farm_server/farm_app role changes away from
// the retained development database and its application credentials.
const directory = mkdtempSync(join(tmpdir(), "farmstead-preview-test-"));
const container = `farmstead-preview-test-${randomUUID().slice(0, 8)}`;
const password = randomBytes(32).toString("hex");
const credentialsFile = join(directory, "runtime.env");
let url: string, admin: pg.Client, runtime: pg.Client;
function provision(target = url, output = credentialsFile) {
  return spawnSync(process.execPath, ["scripts/provision-preview-db.mjs"], {
    env: {
      ...process.env,
      // Explicit migration targets must win over a workspace preview binding;
      // never inherit a real hosted database credential into this fixture.
      PREVIEW_DATABASE_ADMIN_URL:
        "postgresql://fixture:synthetic@unusable.invalid/ignored",
      MIGRATION_DATABASE_URL: target,
      PREVIEW_CREDENTIALS_FILE: output,
    },
    encoding: "utf8",
    timeout: 20000,
  });
}
beforeAll(async () => {
  const env = join(directory, "postgres.env");
  writeFileSync(env, `POSTGRES_PASSWORD=${password}\n`, { mode: 0o600 });
  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      container,
      "--env-file",
      env,
      "-p",
      "127.0.0.1::5432",
      "postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b",
    ],
    { stdio: "pipe", timeout: 20000 },
  );
  const port = execFileSync(
    "docker",
    [
      "inspect",
      "--format",
      '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',
      container,
    ],
    { encoding: "utf8" },
  ).trim();
  const owner = new URL(
    `postgresql://preview_owner:${password}@127.0.0.1:${port}/farmstead_preview`,
  );
  for (let attempt = 0; attempt < 60; attempt++) {
    const client = new pg.Client({
      connectionString: `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`,
      connectionTimeoutMillis: 300,
    });
    try {
      await client.connect();
      admin = client;
      break;
    } catch {
      await client.end().catch(() => {});
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!admin) throw Error("Isolated deployment database did not start.");
  await admin.query(
    (
      await admin.query(
        "SELECT format('CREATE ROLE preview_owner LOGIN CREATEDB CREATEROLE NOSUPERUSER PASSWORD %L',$1::text) AS sql",
        [password],
      )
    ).rows[0].sql,
  );
  await admin.query("CREATE DATABASE farmstead_preview OWNER preview_owner");
  url = owner.toString();
}, 30000);
afterAll(async () => {
  await runtime?.end().catch(() => {});
  await admin?.end().catch(() => {});
  try {
    execFileSync("docker", ["rm", "-fv", container], { stdio: "ignore" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
it("migrates with a nonsuperuser owner and provisions a verified restricted runtime login", async () => {
  const result = provision();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("restricted runtime checks passed");
  const saved = readFileSync(credentialsFile, "utf8").match(
    /^DATABASE_URL=(.+)$/m,
  )![1];
  expect(new URL(saved).username).toBe("farm_server");
  runtime = new pg.Client({ connectionString: saved });
  await runtime.connect();
  const user = (
    await runtime.query(
      "INSERT INTO users(email,password_hash) VALUES('preview@test.invalid','fixture') RETURNING id",
    )
  ).rows[0].id;
  await runtime.query("BEGIN");
  await runtime.query("SET LOCAL ROLE farm_app");
  await runtime.query("SELECT set_config('app.user_id',$1,true)", [user]);
  const org = (
    await runtime.query("SELECT create_organization('Preview fixture') AS id")
  ).rows[0].id;
  expect(
    (await runtime.query("SELECT id FROM organizations WHERE id=$1", [org]))
      .rowCount,
  ).toBe(1);
  await runtime.query("COMMIT");
  await expect(
    runtime.query("SELECT id FROM organizations"),
  ).rejects.toMatchObject({ code: "42501" });
  await runtime.query("BEGIN");
  await runtime.query("SET LOCAL ROLE farm_app");
  await runtime.query("SELECT set_config('app.user_id',$1,true)", [
    randomUUID(),
  ]);
  expect(
    (await runtime.query("SELECT id FROM organizations WHERE id=$1", [org]))
      .rowCount,
  ).toBe(0);
  await runtime.query("ROLLBACK");
});
it("reuses its private runtime credential and applies no duplicate migrations", () => {
  const before = readFileSync(credentialsFile, "utf8"),
    result = provision();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).not.toContain("Applied ");
  expect(readFileSync(credentialsFile, "utf8")).toBe(before);
});
it("refuses unrelated data and mismatched credential destinations before touching them", async () => {
  await admin.query("CREATE DATABASE unrelated_preview OWNER preview_owner");
  const unrelated = new URL(url);
  unrelated.pathname = "/unrelated_preview";
  const client = new pg.Client({ connectionString: unrelated.toString() });
  await client.connect();
  try {
    await client.query("CREATE TABLE existing_app(id integer)");
    expect(
      provision(unrelated.toString(), join(directory, "other.env")).status,
    ).toBe(1);
    expect(
      (
        await client.query(
          "SELECT to_regclass('public.schema_migrations') AS id",
        )
      ).rows[0].id,
    ).toBeNull();
    await client.query("DROP TABLE existing_app");
    expect(provision(unrelated.toString()).status).toBe(1);
    expect(
      (
        await client.query(
          "SELECT to_regclass('public.schema_migrations') AS id",
        )
      ).rows[0].id,
    ).toBeNull();
  } finally {
    await client.end();
  }
});
