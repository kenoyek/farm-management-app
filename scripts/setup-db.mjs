import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { resolve } from "node:path";
if (!process.env.DATABASE_URL) {
  mkdirSync(".local", { recursive: true });
  const secretPath = ".local/postgres.env";
  if (!existsSync(secretPath))
    writeFileSync(
      secretPath,
      `POSTGRES_PASSWORD=${randomBytes(32).toString("hex")}\nPOSTGRES_DB=farmstead\n`,
      { mode: 0o600 },
    );
  const password = readFileSync(secretPath, "utf8").match(
    /POSTGRES_PASSWORD=(.+)/,
  )[1];
  const url = `postgresql://postgres:${password}@127.0.0.1:54329/farmstead`;
  if (
    existsSync(".env.local") &&
    readFileSync(".env.local", "utf8").includes("DATABASE_URL=")
  )
    throw Error(
      "Existing DATABASE_URL must be supplied to avoid overwriting configuration",
    );
  writeFileSync(
    ".env.local",
    `${existsSync(".env.local") ? readFileSync(".env.local", "utf8") : ""}\nDATABASE_URL=${url}\n`,
    { mode: 0o600 },
  );
  process.env.DATABASE_URL = url;
}
const local = process.env.DATABASE_URL.includes("@127.0.0.1:54329/farmstead");
if (local) {
  try {
    execFileSync("docker", ["inspect", "farmstead-postgres"], {
      stdio: "ignore",
    });
    execFileSync("docker", ["start", "farmstead-postgres"], {
      stdio: "ignore",
    });
  } catch {
    execFileSync(
      "docker",
      [
        "run",
        "-d",
        "--name",
        "farmstead-postgres",
        "--env-file",
        ".local/postgres.env",
        "-p",
        "127.0.0.1:54329:5432",
        "-v",
        `${resolve(".local/pgdata")}:/var/lib/postgresql/data`,
        "postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b",
      ],
      { stdio: "inherit" },
    );
  }
}
let ready = false;
for (let i = 0; i < 30; i++) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    await client.query("SELECT 1");
    ready = true;
    await client.end();
    break;
  } catch {
    await client.end().catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
  }
}
if (!ready) throw Error("PostgreSQL did not become ready");
await import("./migrate.mjs");
if (local) {
  const pgPassword = readFileSync(".local/postgres.env", "utf8").match(
    /POSTGRES_PASSWORD=(.+)/,
  )[1];
  const admin = new pg.Client({
    connectionString: `postgresql://postgres:${pgPassword}@127.0.0.1:54329/farmstead`,
  });
  await admin.connect();
  const appSecretPath = ".local/app-role.secret";
  if (!existsSync(appSecretPath))
    writeFileSync(appSecretPath, randomBytes(32).toString("hex"), {
      mode: 0o600,
    });
  const secret = readFileSync(appSecretPath, "utf8").trim();
  const sql = (
    await admin.query(
      "SELECT format('ALTER ROLE farm_server LOGIN PASSWORD %L', $1::text) AS statement",
      [secret],
    )
  ).rows[0].statement;
  await admin.query(sql);
  await admin.end();
  const url = `postgresql://farm_server:${secret}@127.0.0.1:54329/farmstead`;
  const existing = existsSync(".env.local")
    ? readFileSync(".env.local", "utf8")
    : "";
  const content = /^DATABASE_URL=.*$/m.test(existing)
    ? existing.replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${url}`)
    : existing + `\nDATABASE_URL=${url}\n`;
  writeFileSync(".env.local", content, { mode: 0o600 });
  console.log("Local runtime uses the restricted farm_server login.");
}
