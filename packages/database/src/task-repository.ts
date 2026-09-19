import pg from "pg";
import { randomUUID } from "node:crypto";
import { PrismaClient, Prisma } from "./generated/client.js";
import {
  ConcurrencyConflictError,
  RecordNotFoundError,
  FencingTokenMismatchError,
} from "./errors.js";
import { TransactionClient } from "./unit-of-work.js";

export interface CreateTaskExecutionInput {
  readonly id?: string;
  readonly kind: string;
  readonly ownerScope: string;
  readonly maxAttempts?: number;
  readonly inputPayload?: Record<string, unknown>;
  readonly phaseKey?: string;
}

export interface TaskClaimResult {
  readonly id: string;
  readonly kind: string;
  readonly ownerScope: string;
  readonly status: string;
  readonly attempt: number;
  readonly fenceToken: bigint;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: Date;
  readonly cancelRequested: boolean;
  readonly progress: unknown;
  readonly resultRef: unknown;
}

export interface OutboxBatchItem {
  readonly id: string;
  readonly type: string;
  readonly aggregateId: string;
  readonly payloadVersion: number;
  readonly payload: unknown;
  readonly phaseKey: string;
  readonly nextDispatchAt: Date;
}

export interface TaskEntity {
  readonly id: string;
  readonly kind: string;
  readonly ownerScope: string;
  readonly status: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly fenceToken: bigint;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly lastHeartbeatAt: Date | null;
  readonly cancelRequestedAt: Date | null;
  readonly progress: unknown;
  readonly resultRef: unknown;
  readonly errorDetails: unknown;
  readonly nextEventSeq: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface RawTaskRow {
  readonly id: string;
  readonly kind: string;
  readonly owner_scope: string;
  readonly status: string;
  readonly attempt: number;
  readonly max_attempts: number;
  readonly fence_token: string;
  readonly lease_owner: string | null;
  readonly lease_expires_at: Date | null;
  readonly last_heartbeat_at: Date | null;
  readonly cancel_requested_at: Date | null;
  readonly progress: unknown;
  readonly result_ref: unknown;
  readonly error_details: unknown;
  readonly next_event_seq: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface RawOutboxRow {
  readonly id: string;
  readonly type: string;
  readonly aggregate_id: string;
  readonly payload_version: number;
  readonly payload: unknown;
  readonly phase_key: string;
  readonly next_dispatch_at: Date;
}

function mapRawTaskRow(row: RawTaskRow): TaskEntity {
  return {
    id: row.id,
    kind: row.kind,
    ownerScope: row.owner_scope,
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    fenceToken: BigInt(row.fence_token),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    cancelRequestedAt: row.cancel_requested_at,
    progress: row.progress,
    resultRef: row.result_ref,
    errorDetails: row.error_details,
    nextEventSeq: row.next_event_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TaskExecutionRepository {
  /**
   * Transactionally creates a TaskExecution record and corresponding TaskOutbox entry.
   */
  static async createTask(
    client: PrismaClient | TransactionClient,
    input: CreateTaskExecutionInput
  ): Promise<{ id: string; kind: string; outboxId: string }> {
    const taskId = input.id ?? randomUUID();
    const outboxId = randomUUID();

    await client.taskExecution.create({
      data: {
        id: taskId,
        kind: input.kind,
        ownerScope: input.ownerScope,
        status: "queued",
        attempt: 0,
        maxAttempts: input.maxAttempts ?? 3,
        fenceToken: 0n,
        progress: Prisma.JsonNull,
        resultRef: Prisma.JsonNull,
        errorDetails: Prisma.JsonNull,
        nextEventSeq: 0,
      },
    });

    const payloadJson = JSON.stringify(input.inputPayload ?? {});
    await client.$executeRaw`
      INSERT INTO task_outbox (id, type, aggregate_id, payload_version, payload, phase_key, dispatch_state, next_dispatch_at, created_at)
      VALUES (${outboxId}, ${input.kind}, ${taskId}, 1, ${payloadJson}::jsonb, ${input.phaseKey ?? "initial"}, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `;

    return { id: taskId, kind: input.kind, outboxId };
  }

  /**
   * Atomically claims a task for execution with lease duration and fencing token increment.
   */
  static async claimTask(
    pool: pg.Pool,
    taskId: string,
    workerId: string,
    leaseSeconds = 60
  ): Promise<TaskClaimResult | null> {
    const query = `
      UPDATE task_executions
      SET
        status = 'running',
        attempt = attempt + 1,
        fence_token = fence_token + 1,
        lease_owner = $2,
        lease_expires_at = CURRENT_TIMESTAMP + ($3 || ' seconds')::interval,
        last_heartbeat_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND status NOT IN ('succeeded', 'failed', 'cancelled')
        AND (status = 'queued' OR (status = 'running' AND lease_expires_at < CURRENT_TIMESTAMP))
        AND cancel_requested_at IS NULL
      RETURNING id, kind, owner_scope, status, attempt, fence_token, lease_owner, lease_expires_at, cancel_requested_at, progress, result_ref;
    `;

    const res = await pool.query<RawTaskRow>(query, [taskId, workerId, leaseSeconds]);
    if (res.rowCount === 0) {
      return null;
    }

    const row = res.rows[0];
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      kind: row.kind,
      ownerScope: row.owner_scope,
      status: row.status,
      attempt: row.attempt,
      fenceToken: BigInt(row.fence_token),
      leaseOwner: row.lease_owner!,
      leaseExpiresAt: row.lease_expires_at!,
      cancelRequested: row.cancel_requested_at !== null,
      progress: row.progress,
      resultRef: row.result_ref,
    };
  }

  /**
   * Extends the lease on a currently held task. Fails if fencing token mismatch or lease lost.
   */
  static async heartbeat(
    pool: pg.Pool,
    taskId: string,
    workerId: string,
    fenceToken: bigint,
    leaseSeconds = 60
  ): Promise<{ cancelRequested: boolean }> {
    const query = `
      UPDATE task_executions
      SET
        lease_expires_at = CURRENT_TIMESTAMP + ($4 || ' seconds')::interval,
        last_heartbeat_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND lease_owner = $2
        AND fence_token = $3
        AND status = 'running'
      RETURNING cancel_requested_at;
    `;

    const res = await pool.query<{ cancel_requested_at: Date | null }>(query, [
      taskId,
      workerId,
      fenceToken.toString(),
      leaseSeconds,
    ]);

    const row = res.rows[0];
    if (!row) {
      throw new FencingTokenMismatchError();
    }

    return { cancelRequested: row.cancel_requested_at !== null };
  }

  /**
   * Requests graceful cancellation of a task.
   */
  static async requestCancel(pool: pg.Pool, taskId: string): Promise<boolean> {
    const query = `
      UPDATE task_executions
      SET
        cancel_requested_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND status NOT IN ('succeeded', 'failed', 'cancelled')
      RETURNING id;
    `;

    const res = await pool.query(query, [taskId]);
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Completes a task execution successfully, releasing the lease.
   */
  static async completeTask(
    pool: pg.Pool,
    taskId: string,
    workerId: string,
    fenceToken: bigint,
    resultRef: Record<string, unknown> | null = null
  ): Promise<void> {
    const query = `
      UPDATE task_executions
      SET
        status = 'succeeded',
        result_ref = $4,
        lease_owner = NULL,
        lease_expires_at = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND lease_owner = $2
        AND fence_token = $3
        AND status = 'running';
    `;

    const res = await pool.query(query, [
      taskId,
      workerId,
      fenceToken.toString(),
      resultRef ? JSON.stringify(resultRef) : null,
    ]);

    if (res.rowCount === 0) {
      throw new FencingTokenMismatchError("Failed to complete task: fencing token mismatch or task not owned");
    }
  }

  /**
   * Fails a task execution, recording error details and releasing the lease.
   */
  static async failTask(
    pool: pg.Pool,
    taskId: string,
    workerId: string,
    fenceToken: bigint,
    errorDetails: Record<string, unknown>
  ): Promise<void> {
    const query = `
      UPDATE task_executions
      SET
        status = 'failed',
        error_details = $4,
        lease_owner = NULL,
        lease_expires_at = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND lease_owner = $2
        AND fence_token = $3
        AND status = 'running';
    `;

    const res = await pool.query(query, [
      taskId,
      workerId,
      fenceToken.toString(),
      JSON.stringify(errorDetails),
    ]);

    if (res.rowCount === 0) {
      throw new FencingTokenMismatchError("Failed to mark task failed: fencing token mismatch or task not owned");
    }
  }

  /**
   * Parks a task in 'awaiting_confirmation' state (e.g. for user approval of proposed plans), releasing worker lease.
   */
  static async parkTask(
    pool: pg.Pool,
    taskId: string,
    workerId: string,
    fenceToken: bigint,
    resultRef: Record<string, unknown> | null = null
  ): Promise<void> {
    const query = `
      UPDATE task_executions
      SET
        status = 'awaiting_confirmation',
        lease_owner = NULL,
        lease_expires_at = NULL,
        result_ref = $4,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND lease_owner = $2
        AND fence_token = $3
        AND status = 'running';
    `;

    const res = await pool.query(query, [
      taskId,
      workerId,
      fenceToken.toString(),
      resultRef ? JSON.stringify(resultRef) : null,
    ]);

    if (res.rowCount === 0) {
      throw new FencingTokenMismatchError("Failed to park task: fencing token mismatch or task not owned");
    }
  }

  /**
   * Marks a task as cancelled by worker during execution.
   */
  static async cancelTask(
    pool: pg.Pool,
    taskId: string,
    workerId: string,
    fenceToken: bigint
  ): Promise<void> {
    const query = `
      UPDATE task_executions
      SET
        status = 'cancelled',
        lease_owner = NULL,
        lease_expires_at = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND lease_owner = $2
        AND fence_token = $3
        AND status = 'running';
    `;

    const res = await pool.query(query, [
      taskId,
      workerId,
      fenceToken.toString(),
    ]);

    if (res.rowCount === 0) {
      throw new FencingTokenMismatchError("Failed to cancel task: fencing token mismatch or task not owned");
    }
  }

  /**
   * Retrieves a TaskExecution by ID.
   */
  static async getTask(pool: pg.Pool, taskId: string): Promise<TaskEntity | null> {
    const query = `
      SELECT id, kind, owner_scope, status, attempt, max_attempts, fence_token,
             lease_owner, lease_expires_at, last_heartbeat_at, cancel_requested_at,
             progress, result_ref, error_details, next_event_seq, created_at, updated_at
      FROM task_executions
      WHERE id = $1;
    `;

    const res = await pool.query<RawTaskRow>(query, [taskId]);
    const row = res.rows[0];
    if (!row) return null;
    return mapRawTaskRow(row);
  }

  /**
   * Claims a batch of active outbox entries using FOR UPDATE SKIP LOCKED.
   */
  static async claimNextOutboxBatch(
    pool: pg.Pool,
    limit = 10
  ): Promise<ReadonlyArray<OutboxBatchItem>> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query<RawOutboxRow>(
        `SELECT id, type, aggregate_id, payload_version, payload, phase_key, next_dispatch_at
         FROM task_outbox
         WHERE dispatch_state = 'active'
           AND next_dispatch_at <= CURRENT_TIMESTAMP + interval '5 seconds'
         ORDER BY next_dispatch_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED;`,
        [limit]
      );
      if (res.rows.length > 0) {
        const ids = res.rows.map((r) => r.id);
        await client.query(
          `UPDATE task_outbox
           SET dispatch_state = 'dispatching', last_dispatched_at = CURRENT_TIMESTAMP
           WHERE id = ANY($1)`,
          [ids]
        );
      }
      await client.query("COMMIT");
      return res.rows.map((r) => ({
        id: r.id,
        type: r.type,
        aggregateId: r.aggregate_id,
        payloadVersion: r.payload_version,
        payload: r.payload,
        phaseKey: r.phase_key,
        nextDispatchAt: r.next_dispatch_at,
      }));
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Closes an outbox entry after successful queue delivery.
   */
  static async closeOutbox(pool: pg.Pool, outboxId: string): Promise<void> {
    const query = `
      UPDATE task_outbox
      SET
        dispatch_state = 'closed',
        terminal_at = CURRENT_TIMESTAMP
      WHERE id = $1;
    `;
    await pool.query(query, [outboxId]);
  }

  /**
   * Reconciles stuck tasks:
   * 1. Running tasks whose lease has expired and haven't exceeded max attempts -> re-enqueue to queued and create new outbox.
   * 2. Running tasks whose lease has expired and have reached max attempts -> mark failed.
   * 3. Outbox entries stuck in 'dispatching' for > 1 minute -> reset to 'active'.
   */
  static async reconcile(pool: pg.Pool): Promise<{
    recoveredCount: number;
    failedCount: number;
    requeuedOutboxCount: number;
  }> {
    // A cancelled queued task cannot be claimed. Finish it here; leave a live
    // running lease to its worker so cancellation cannot race active work.
    await pool.query(`
      UPDATE task_executions
      SET status = 'cancelled',
        lease_owner = NULL,
        lease_expires_at = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE cancel_requested_at IS NOT NULL
        AND status NOT IN ('succeeded', 'failed', 'cancelled')
        AND (status <> 'running' OR lease_owner IS NULL
          OR lease_expires_at IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP)
    `);

    // 1. Recover expired tasks
    const recoverQuery = `
      UPDATE task_executions
      SET
        status = 'queued',
        lease_owner = NULL,
        lease_expires_at = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE status = 'running'
        AND lease_expires_at < CURRENT_TIMESTAMP
        AND attempt < max_attempts
        AND cancel_requested_at IS NULL
      RETURNING id, kind;
    `;
    const recoverRes = await pool.query<{ id: string; kind: string }>(recoverQuery);
    for (const task of recoverRes.rows) {
      await pool.query(
        `INSERT INTO task_outbox (id, type, aggregate_id, payload_version, payload, phase_key, dispatch_state, next_dispatch_at, created_at)
         VALUES ($1, $2, $3, 1, '{}'::jsonb, 'reconcile_retry', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [randomUUID(), task.kind, task.id]
      );
    }

    // 2. Fail tasks that exceeded max attempts
    const failQuery = `
      UPDATE task_executions
      SET
        status = 'failed',
        error_details = '{"code": "MAX_ATTEMPTS_EXCEEDED", "message": "Task lease expired and exceeded max retry attempts"}'::jsonb,
        lease_owner = NULL,
        lease_expires_at = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE status = 'running'
        AND lease_expires_at < CURRENT_TIMESTAMP
        AND attempt >= max_attempts
      RETURNING id;
    `;
    const failRes = await pool.query(failQuery);

    // 3. Reset stalled outbox entries
    const resetOutboxQuery = `
      UPDATE task_outbox
      SET
        dispatch_state = 'active',
        next_dispatch_at = CURRENT_TIMESTAMP
      WHERE dispatch_state = 'dispatching'
        AND last_dispatched_at < CURRENT_TIMESTAMP - interval '1 minute'
      RETURNING id;
    `;
    const resetRes = await pool.query(resetOutboxQuery);

    return {
      recoveredCount: recoverRes.rowCount ?? 0,
      failedCount: failRes.rowCount ?? 0,
      requeuedOutboxCount: resetRes.rowCount ?? 0,
    };
  }
}
