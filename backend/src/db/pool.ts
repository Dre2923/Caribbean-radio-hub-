import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

if (env.pgSsl && !env.pgSslRejectUnauthorized) {
  logger.warn(
    "PGSSL_REJECT_UNAUTHORIZED=false: Postgres TLS certificates will not be validated. " +
      "Only use this for a provider whose self-signed chain you trust, never as a default.",
  );
}

export const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: env.pgSsl ? { rejectUnauthorized: env.pgSslRejectUnauthorized } : undefined,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  // Errors on idle clients must never crash the process — surface and keep serving.
  logger.error("Unexpected error on idle Postgres client", { error: err.message });
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  try {
    return await pool.query<T>(text, params);
  } catch (err) {
    logger.error("Database query failed", {
      error: err instanceof Error ? err.message : String(err),
      text,
    });
    throw err;
  }
}

export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch (err) {
    logger.error("Database connectivity check failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
