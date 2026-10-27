import { databaseClient } from "./database-client.mjs";
import { existsSync, readdirSync, readFileSync } from "node:fs";
let migrationUrl =
  process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (
  migrationUrl?.includes("@127.0.0.1:54329/farmstead") &&
  existsSync(".local/postgres.env")
) {
  const secret = readFileSync(".local/postgres.env", "utf8").match(
    /POSTGRES_PASSWORD=(.+)/,
  )[1];
  migrationUrl = `postgresql://postgres:${secret}@127.0.0.1:54329/farmstead`;
}
const client = await databaseClient(migrationUrl);
await client.connect();
try {
  await client.query("SELECT pg_advisory_lock(734218)");
  await client.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  for (const name of readdirSync("migrations")
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    if (
      (
        await client.query("SELECT 1 FROM schema_migrations WHERE name=$1", [
          name,
        ])
      ).rowCount
    )
      continue;
    await client.query("BEGIN");
    try {
      await client.query(readFileSync(`migrations/${name}`, "utf8"));
      await client.query("INSERT INTO schema_migrations(name) VALUES($1)", [
        name,
      ]);
      await client.query("COMMIT");
      console.log(`Applied ${name}`);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  }
} finally {
  await client.query("SELECT pg_advisory_unlock(734218)");
  await client.end();
}
