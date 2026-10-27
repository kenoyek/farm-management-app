import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
try {
  const role = (
    await c.query(
      "SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
    )
  ).rows[0];
  if (role.name !== "farm_server" || role.rolsuper || role.rolbypassrls)
    throw Error("Configure the restricted farm_server runtime login.");
  let denied = false;
  try {
    await c.query("SELECT id FROM organizations LIMIT 1");
  } catch (error) {
    if (error.code === "42501") denied = true;
    else throw error;
  }
  if (!denied) throw Error("Runtime must not directly read tenant tables.");
  console.log(
    "Runtime database login is ready and requires scoped tenant transactions.",
  );
} finally {
  await c.end();
}
