import pg, { type PoolClient } from "pg";
const globalDb = globalThis as unknown as { farmPool?: pg.Pool };
export const pool =
  globalDb.farmPool ??
  new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
if (process.env.NODE_ENV !== "production") globalDb.farmPool = pool;
export async function tenant<T>(
  userId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE farm_app");
    await client.query("SELECT set_config('app.user_id',$1,true)", [userId]);
    const value = await run(client);
    await client.query("COMMIT");
    return value;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
export async function audit(
  client: PoolClient,
  org: string,
  action: string,
  object: string,
) {
  await client.query(
    "INSERT INTO audit_logs(organization_id,action,object_id) VALUES($1,$2,$3)",
    [org, action, object],
  );
}
