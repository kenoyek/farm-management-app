import pg from "pg";

// Runtime application queries keep using native pg. This optional migration
// transport supports cloud workspaces that expose HTTPS/WSS but no TCP egress.
export async function databaseClient(connectionString) {
  const transport = process.env.MIGRATION_DATABASE_TRANSPORT ?? "tcp";
  if (transport === "tcp")
    return new pg.Client({ connectionString, connectionTimeoutMillis: 15000 });
  if (
    transport !== "neon" ||
    !new URL(connectionString).hostname.endsWith(".neon.tech")
  )
    throw Error("Unsupported migration transport or database host.");
  const { Client, neonConfig } = await import("@neondatabase/serverless");
  neonConfig.webSocketConstructor = WebSocket;
  return new Client({ connectionString, connectionTimeoutMillis: 15000 });
}
