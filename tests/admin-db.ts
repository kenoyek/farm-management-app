// Local test-fixture administration only. Never imported by application modules.
import pg from "pg";
import { readFileSync } from "node:fs";
if (
  !process.env.DATABASE_URL?.includes("@127.0.0.1:54329/farmstead") &&
  !process.env.TEST_DATABASE_ADMIN_URL
)
  throw Error(
    "Integration tests require a local database or explicit test-only admin URL.",
  );
const password = process.env.TEST_DATABASE_ADMIN_URL
  ? null
  : readFileSync(".local/postgres.env", "utf8").match(
      /POSTGRES_PASSWORD=(.+)/,
    )![1];
export const admin = new pg.Pool({
  connectionString:
    process.env.TEST_DATABASE_ADMIN_URL ??
    `postgresql://postgres:${password}@127.0.0.1:54329/farmstead`,
});
