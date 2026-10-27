// One-time/idempotent preparation of a dedicated preview database. Never place
// the migration/admin URL in the Vercel application environment.
import { databaseClient } from "./database-client.mjs";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const output = resolve(
  process.env.PREVIEW_CREDENTIALS_FILE ?? ".local/preview-runtime.env",
);
let admin, runtime;
try {
  process.env.MIGRATION_DATABASE_TRANSPORT ??=
    process.env.PREVIEW_DATABASE_TRANSPORT ?? "tcp";
  if (
    !process.env.MIGRATION_DATABASE_URL &&
    process.env.PREVIEW_DATABASE_ADMIN_URL
  )
    process.env.MIGRATION_DATABASE_URL = process.env.PREVIEW_DATABASE_ADMIN_URL;
  if (!process.env.MIGRATION_DATABASE_URL)
    throw Error(
      "MIGRATION_DATABASE_URL is required for a dedicated preview database.",
    );
  const url = new URL(process.env.MIGRATION_DATABASE_URL);
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw Error("Use a PostgreSQL migration URL.");
  if (!["localhost", "127.0.0.1"].includes(url.hostname))
    url.searchParams.set("sslmode", "verify-full");
  process.env.MIGRATION_DATABASE_URL = url.toString();
  admin = await databaseClient(url.toString());
  await admin.connect();
  const existing = (
    await admin.query(
      "SELECT to_regclass('public.schema_migrations') AS migrations,(SELECT count(*) FROM information_schema.tables WHERE table_schema='public')::integer AS tables",
    )
  ).rows[0];
  if (!existing.migrations && existing.tables > 0)
    throw Error(
      "Refusing a nonempty database without Farmstead migration history. Create a dedicated preview database.",
    );
  if (existing.migrations) {
    const known = new Set(
      readdirSync("migrations").filter((f) => f.endsWith(".sql")),
    );
    if (
      (await admin.query("SELECT name FROM schema_migrations")).rows.some(
        (r) => !known.has(r.name),
      )
    )
      throw Error("This database has unrelated migration history.");
  }
  let secret = randomBytes(32).toString("hex");
  if (existsSync(output)) {
    const saved = readFileSync(output, "utf8").match(/^DATABASE_URL=(.+)$/m);
    if (!saved)
      throw Error(
        "Existing preview credential file is invalid; it was not overwritten.",
      );
    const previous = new URL(saved[1]);
    if (
      previous.hostname.replace("-pooler.", ".") !==
        url.hostname.replace("-pooler.", ".") ||
      previous.pathname !== url.pathname ||
      previous.port !== url.port ||
      previous.username !== "farm_server"
    )
      throw Error(
        "Existing preview credentials target another database; use a separate PREVIEW_CREDENTIALS_FILE.",
      );
    secret = decodeURIComponent(previous.password);
    if (secret.length < 32)
      throw Error("Existing preview runtime secret is invalid.");
  }
  await import("./migrate.mjs");
  const statement = (
    await admin.query(
      "SELECT format('ALTER ROLE farm_server LOGIN PASSWORD %L',$1::text) AS sql",
      [secret],
    )
  ).rows[0].sql;
  await admin.query(statement);
  const runtimeUrl = new URL(url);
  runtimeUrl.username = "farm_server";
  runtimeUrl.password = secret;
  if (
    runtimeUrl.hostname.endsWith(".neon.tech") &&
    !runtimeUrl.hostname.split(".")[0].endsWith("-pooler")
  )
    runtimeUrl.hostname = runtimeUrl.hostname.replace(".", "-pooler.");
  runtime = await databaseClient(runtimeUrl.toString());
  await runtime.connect();
  const role = (
    await runtime.query(
      "SELECT rolname,rolsuper,rolbypassrls,rolinherit,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=current_user",
    )
  ).rows[0];
  if (
    role.rolname !== "farm_server" ||
    role.rolsuper ||
    role.rolbypassrls ||
    role.rolinherit ||
    role.rolcreaterole ||
    role.rolcreatedb
  )
    throw Error("Runtime role must be restricted.");
  let denied = false;
  try {
    await runtime.query("SELECT id FROM organizations LIMIT 1");
  } catch (error) {
    if (error.code === "42501") denied = true;
    else throw error;
  }
  if (!denied)
    throw Error("Runtime role must not directly read tenant tables.");
  await runtime.query("BEGIN");
  await runtime.query("SET LOCAL ROLE farm_app");
  await runtime.query("SELECT set_config('app.user_id','',true)");
  if (
    (await runtime.query("SELECT id FROM organizations LIMIT 1")).rowCount !== 0
  )
    throw Error("Tenant isolation check failed.");
  await runtime.query("ROLLBACK");
  if (!existsSync(output)) {
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    writeFileSync(output, `DATABASE_URL=${runtimeUrl.toString()}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  }
  console.log(
    "Preview migrations and restricted runtime checks passed. Runtime URL retained in a private credentials file; no administrator URL was saved.",
  );
} catch (error) {
  // Driver/URL errors can contain credentials. Only expose safe error codes.
  console.error("Preview database setup failed.", {
    code:
      typeof error?.code === "string"
        ? error.code
        : "CONFIGURATION_OR_CONNECTIVITY",
  });
  process.exitCode = 1;
} finally {
  await runtime?.end().catch(() => {});
  await admin?.end().catch(() => {});
}
