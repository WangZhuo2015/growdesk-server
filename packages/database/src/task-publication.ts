import type pg from "pg";
import { FencingTokenMismatchError } from "./errors.js";

/** Publish a task artifact and success receipt in the same fenced transaction. */
export async function publishTaskResult(
  pool: pg.Pool,
  taskId: string,
  workerId: string,
  fenceToken: bigint,
  result: Record<string, unknown> | null,
  publish: (client: pg.PoolClient) => Promise<void>,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const owned = await client.query<{ cancel_requested_at: Date | null }>(`SELECT cancel_requested_at FROM task_executions
      WHERE id = $1 AND lease_owner = $2 AND fence_token = $3 AND status = 'running' FOR UPDATE`, [taskId, workerId, fenceToken.toString()]);
    if (!owned.rows[0]) throw new FencingTokenMismatchError("Task publication lost its lease");
    if (owned.rows[0].cancel_requested_at) {
      await client.query("UPDATE task_executions SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = clock_timestamp() WHERE id = $1", [taskId]);
      await client.query("COMMIT"); return false;
    }
    const lease = await client.query("SELECT id FROM task_executions WHERE id = $1 AND lease_expires_at > clock_timestamp()", [taskId]);
    if (!lease.rowCount) throw new FencingTokenMismatchError("Task lease expired before publication");
    await publish(client);
    const completed = await client.query(`UPDATE task_executions SET status = 'succeeded', result_ref = $4::jsonb,
      lease_owner = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
      WHERE id = $1 AND lease_owner = $2 AND fence_token = $3 AND status = 'running'
        AND lease_expires_at > clock_timestamp() AND cancel_requested_at IS NULL`, [taskId, workerId, fenceToken.toString(), JSON.stringify(result)]);
    if (!completed.rowCount) throw new FencingTokenMismatchError("Task lease expired during publication");
    await client.query("COMMIT"); return true;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* Preserve the original error. */ }
    throw error;
  } finally { client.release(); }
}
