import type { PoolClient } from "pg";
import { pool } from "./pool.js";
import { logger } from "../utils/logger.js";

/**
 * Runs `fn` inside a transaction: commits on success, rolls back on any
 * error (thrown or rejected) so callers never need to duplicate this
 * BEGIN/COMMIT/ROLLBACK dance around a write.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      logger.error("Rollback failed after transaction error", {
        originalError: err instanceof Error ? err.message : String(err),
        rollbackError: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
      });
    }
    throw err;
  } finally {
    client.release();
  }
}
