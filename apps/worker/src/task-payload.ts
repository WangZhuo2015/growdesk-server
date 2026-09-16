import pg from "pg";

/** Read the durable input history for a task, then apply the dispatched job metadata. */
export async function loadTaskPayload(
  pool: pg.Pool,
  taskId: string,
  dispatchedPayload: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const result = await pool.query<{ payload: unknown }>(
    `SELECT payload
     FROM task_outbox
     WHERE aggregate_id = $1
     ORDER BY created_at ASC, id ASC`,
    [taskId],
  );
  const merged: Record<string, unknown> = {};
  for (const row of result.rows) {
    if (row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)) {
      Object.assign(merged, row.payload as Record<string, unknown>);
    }
  }
  Object.assign(merged, dispatchedPayload);
  return merged;
}
