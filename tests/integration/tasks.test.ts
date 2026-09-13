import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createDatabaseContext } from "../../packages/database/src/client.js";
import { requireTestDatabaseUrl } from "../../packages/testkit/src/environment.js";
import {
  TaskExecutionRepository,
} from "../../packages/database/src/task-repository.js";
import {
  FencingTokenMismatchError,
} from "../../packages/database/src/errors.js";
import { WorkerEngine } from "../../apps/worker/src/worker-engine.js";
import { SchedulerEngine } from "../../apps/scheduler/src/scheduler-engine.js";

interface OwnedRun {
  directory: string;
  token: string;
  database: string;
  user: string;
  password: string;
  pgPort: number;
  redisPort: number;
}

function readRun(): OwnedRun {
  const file = process.env.BOOT02_RUN_FILE;
  if (!file) throw new Error("Integration tests require the managed test runner");
  const real = fs.realpathSync(file);
  const parent = path.dirname(real);
  if (
    path.dirname(parent) !== fs.realpathSync(os.tmpdir()) ||
    !path.basename(parent).startsWith("growdesk-integration-")
  ) {
    throw new Error("Integration manifest is outside its private run");
  }
  const stat = fs.statSync(real);
  if (stat.uid !== process.getuid?.() || stat.mode & 0o077)
    throw new Error("Unsafe manifest permissions");
  return JSON.parse(fs.readFileSync(real, "utf8")) as OwnedRun;
}

test("SH-07: Durable Task Engine & Worker/Scheduler Infrastructure suite", async (t) => {
  const run = readRun();
  const identity = {
    host: "127.0.0.1" as const,
    port: run.pgPort,
    database: run.database,
    role: run.user,
    password: run.password,
  };
  const url = requireTestDatabaseUrl(
    `postgresql://${run.user}:${run.password}@127.0.0.1:${run.pgPort}/${run.database}?sslmode=disable`,
    identity
  );

  const ctx = createDatabaseContext({ url });

  t.after(async () => {
    await ctx.close();
  });

  // Ensure all migrations up to 202609130011_tasks_and_ai are applied
  const migrations = [
    "prisma/migrations/202609120001_identity/migration.sql",
    "prisma/migrations/202609120002_foundation/migration.sql",
    "prisma/migrations/202609120003_care_feeding/migration.sql",
    "prisma/migrations/202609120004_care_diaper/migration.sql",
    "prisma/migrations/202609120005_care_sleep/migration.sql",
    "prisma/migrations/202609120006_care_food/migration.sql",
    "prisma/migrations/202609120007_care_supplement/migration.sql",
    "prisma/migrations/202609120008_care_growth/migration.sql",
    "prisma/migrations/202609120009_bff_sessions/migration.sql",
    "prisma/migrations/202609120010_attachments_medical_vaccines/migration.sql",
    "prisma/migrations/202609130011_tasks_and_ai/migration.sql",
  ];

  for (const m of migrations) {
    const sql = fs.readFileSync(m, "utf8");
    try {
      await ctx.pool.query(sql);
    } catch {
      // Ignore if table/type already exists
    }
  }

  const worker = new WorkerEngine({
    pool: ctx.pool,
    workerId: "test-worker-alpha",
    leaseSeconds: 2, // Short lease for testing
    heartbeatIntervalMs: 500,
  });

  const scheduler = new SchedulerEngine({
    pool: ctx.pool,
    dispatchBatchSize: 10,
  });

  await t.test("TASK-01: Outbox transactional creation alongside TaskExecution", async () => {
    const taskId = crypto.randomUUID();
    const result = await TaskExecutionRepository.createTask(ctx.prisma, {
      id: taskId,
      kind: "mock_noop",
      ownerScope: "user:test-owner",
      maxAttempts: 3,
      inputPayload: { message: "hello outbox" },
    });

    assert.equal(result.id, taskId);

    const task = await TaskExecutionRepository.getTask(ctx.pool, taskId);
    assert.ok(task);
    assert.equal(task.kind, "mock_noop");
    assert.equal(task.status, "queued");
    assert.equal(task.attempt, 0);
    assert.equal(task.fenceToken, 0n);

    // Verify outbox entry exists
    const outboxRows = await ctx.pool.query(
      "SELECT * FROM task_outbox WHERE aggregate_id = $1",
      [taskId]
    );
    assert.equal(outboxRows.rowCount, 1);
    assert.equal(outboxRows.rows[0].dispatch_state, "active");
  });

  await t.test("TASK-02: Conditional claim atomically increments fence token and sets lease", async () => {
    const taskId = crypto.randomUUID();
    await TaskExecutionRepository.createTask(ctx.prisma, {
      id: taskId,
      kind: "mock_noop",
      ownerScope: "user:test-owner",
    });

    const claim1 = await TaskExecutionRepository.claimTask(
      ctx.pool,
      taskId,
      "worker-1",
      10
    );

    assert.ok(claim1);
    assert.equal(claim1.status, "running");
    assert.equal(claim1.attempt, 1);
    assert.equal(claim1.fenceToken, 1n);
    assert.equal(claim1.leaseOwner, "worker-1");

    // Second worker attempting to claim active lease fails
    const claim2 = await TaskExecutionRepository.claimTask(
      ctx.pool,
      taskId,
      "worker-2",
      10
    );
    assert.equal(claim2, null);
  });

  await t.test("TASK-03: Stale worker with outdated fence token is strictly rejected on completion", async () => {
    const taskId = crypto.randomUUID();
    await TaskExecutionRepository.createTask(ctx.prisma, {
      id: taskId,
      kind: "mock_noop",
      ownerScope: "user:test-owner",
    });

    // Worker 1 claims task (fence = 1n) with short lease (1s)
    const claim1 = await TaskExecutionRepository.claimTask(
      ctx.pool,
      taskId,
      "worker-1",
      1
    );
    assert.ok(claim1);
    assert.equal(claim1.fenceToken, 1n);

    // Fast-forward lease expiration by updating DB
    await ctx.pool.query(
      "UPDATE task_executions SET lease_expires_at = CURRENT_TIMESTAMP - interval '1 second' WHERE id = $1",
      [taskId]
    );

    // Worker 2 steals task because lease expired (fence = 2n)
    const claim2 = await TaskExecutionRepository.claimTask(
      ctx.pool,
      taskId,
      "worker-2",
      10
    );
    assert.ok(claim2);
    assert.equal(claim2.fenceToken, 2n);
    assert.equal(claim2.leaseOwner, "worker-2");

    // Worker 1 (stale zombie worker) attempts to commit -> MUST be rejected with FencingTokenMismatchError!
    await assert.rejects(
      async () => {
        await TaskExecutionRepository.completeTask(
          ctx.pool,
          taskId,
          "worker-1",
          claim1.fenceToken,
          { result: "zombie output" }
        );
      },
      (err: unknown) => {
        return err instanceof FencingTokenMismatchError;
      }
    );

    // Worker 2 commits with valid fence token -> SUCCEEDS!
    await TaskExecutionRepository.completeTask(
      ctx.pool,
      taskId,
      "worker-2",
      claim2.fenceToken,
      { result: "valid output" }
    );

    const task = await TaskExecutionRepository.getTask(ctx.pool, taskId);
    assert.ok(task);
    assert.equal(task.status, "succeeded");
    assert.deepEqual(task.resultRef, { result: "valid output" });
  });

  await t.test("TASK-04: Periodic heartbeat extends lease correctly", async () => {
    const taskId = crypto.randomUUID();
    await TaskExecutionRepository.createTask(ctx.prisma, {
      id: taskId,
      kind: "mock_noop",
      ownerScope: "user:test-owner",
    });

    const claim = await TaskExecutionRepository.claimTask(
      ctx.pool,
      taskId,
      "worker-heartbeat",
      5
    );
    assert.ok(claim);

    const originalExpiresAt = claim.leaseExpiresAt.getTime();

    // Small pause to ensure timestamp advances
    await new Promise((resolve) => setTimeout(resolve, 50));

    const hb = await TaskExecutionRepository.heartbeat(
      ctx.pool,
      taskId,
      "worker-heartbeat",
      claim.fenceToken,
      10
    );
    assert.equal(hb.cancelRequested, false);

    const updatedTask = await TaskExecutionRepository.getTask(ctx.pool, taskId);
    assert.ok(updatedTask);
    assert.ok(updatedTask.leaseExpiresAt!.getTime() > originalExpiresAt);
  });

  await t.test("TASK-05: Worker honors cancellation request and aborts gracefully", async () => {
    const taskId = crypto.randomUUID();
    await TaskExecutionRepository.createTask(ctx.prisma, {
      id: taskId,
      kind: "cancellable_task",
      ownerScope: "user:test-owner",
    });

    worker.registerProcessor({
      kind: "cancellable_task",
      async execute(ctx) {
        // Wait for cancellation
        for (let i = 0; i < 20; i++) {
          if (ctx.isCancelled()) {
            return;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      },
    });

    // Request cancellation concurrently
    setTimeout(async () => {
      await TaskExecutionRepository.requestCancel(ctx.pool, taskId);
    }, 50);

    const outcome = await worker.processTask(taskId);
    assert.equal(outcome.status, "cancelled");

    const task = await TaskExecutionRepository.getTask(ctx.pool, taskId);
    assert.ok(task);
    assert.equal(task.status, "cancelled");
  });

  await t.test("TASK-06: Outbox dispatcher claims with FOR UPDATE SKIP LOCKED and closes dispatched records", async () => {
    // Close any previous pending outbox records to isolate this test assertion
    await ctx.pool.query("UPDATE task_outbox SET dispatch_state = 'closed' WHERE dispatch_state = 'active'");

    const taskId = crypto.randomUUID();
    await TaskExecutionRepository.createTask(ctx.prisma, {
      id: taskId,
      kind: "mock_noop",
      ownerScope: "user:test-owner",
      inputPayload: { foo: "bar" },
    });

    const dispatched: string[] = [];
    const customScheduler = new SchedulerEngine({
      pool: ctx.pool,
      onDispatch: async (item) => {
        dispatched.push(item.aggregateId);
      },
    });

    const count = await customScheduler.dispatchBatch();
    assert.ok(count >= 1);
    assert.ok(dispatched.includes(taskId));

    // Subsequent dispatch finds 0 active items for this task
    const rows = await ctx.pool.query(
      "SELECT dispatch_state FROM task_outbox WHERE aggregate_id = $1",
      [taskId]
    );
    assert.equal(rows.rows[0].dispatch_state, "closed");
  });

  await t.test("TASK-07: Scheduler reconciliation detects expired running tasks and re-enqueues within retry limit", async () => {
    const taskId = crypto.randomUUID();
    await TaskExecutionRepository.createTask(ctx.prisma, {
      id: taskId,
      kind: "mock_noop",
      ownerScope: "user:test-owner",
      maxAttempts: 3,
    });

    // Worker claims task with attempt 1
    const claim = await TaskExecutionRepository.claimTask(
      ctx.pool,
      taskId,
      "worker-stalled",
      1
    );
    assert.ok(claim);

    // Force lease expiration
    await ctx.pool.query(
      "UPDATE task_executions SET lease_expires_at = CURRENT_TIMESTAMP - interval '5 seconds' WHERE id = $1",
      [taskId]
    );

    // Run reconciliation
    const recon = await scheduler.reconcile();
    assert.ok(recon.recoveredCount >= 1);

    const task = await TaskExecutionRepository.getTask(ctx.pool, taskId);
    assert.ok(task);
    assert.equal(task.status, "queued");
    assert.equal(task.leaseOwner, null);
    assert.equal(task.leaseExpiresAt, null);

    // Verify re-enqueue outbox was created
    const outboxRows = await ctx.pool.query(
      "SELECT * FROM task_outbox WHERE aggregate_id = $1 AND phase_key = 'reconcile_retry'",
      [taskId]
    );
    assert.ok(outboxRows.rowCount! >= 1);
  });

  await t.test("TASK-08: Task reaching max attempts is transitioned to failed with error details", async () => {
    const taskId = crypto.randomUUID();
    await TaskExecutionRepository.createTask(ctx.prisma, {
      id: taskId,
      kind: "mock_noop",
      ownerScope: "user:test-owner",
      maxAttempts: 2,
    });

    // Set attempt to maxAttempts (2) and simulate lease expiration
    await ctx.pool.query(
      "UPDATE task_executions SET status = 'running', attempt = 2, lease_expires_at = CURRENT_TIMESTAMP - interval '5 seconds' WHERE id = $1",
      [taskId]
    );

    const recon = await scheduler.reconcile();
    assert.ok(recon.failedCount >= 1);

    const task = await TaskExecutionRepository.getTask(ctx.pool, taskId);
    assert.ok(task);
    assert.equal(task.status, "failed");
    assert.deepEqual(task.errorDetails, {
      code: "MAX_ATTEMPTS_EXCEEDED",
      message: "Task lease expired and exceeded max retry attempts",
    });
  });

  await t.test("TASK-09: Park task puts execution in awaiting_confirmation and releases lease", async () => {
    const taskId = crypto.randomUUID();
    await TaskExecutionRepository.createTask(ctx.prisma, {
      id: taskId,
      kind: "planning_task",
      ownerScope: "user:test-owner",
    });

    worker.registerProcessor({
      kind: "planning_task",
      async execute() {
        return {
          parkPlan: {
            planHash: "hash_abc_123",
            actions: [
              {
                actionId: crypto.randomUUID(),
                entityType: "feeding",
                operation: "create",
                summary: "Record 120ml milk",
                payload: { amountMl: "120.0" },
              },
            ],
          },
        };
      },
    });

    const outcome = await worker.processTask(taskId);
    assert.equal(outcome.status, "awaiting_confirmation");

    const task = await TaskExecutionRepository.getTask(ctx.pool, taskId);
    assert.ok(task);
    assert.equal(task.status, "awaiting_confirmation");
    assert.equal(task.leaseOwner, null);
    assert.equal(task.leaseExpiresAt, null);
    assert.ok(task.resultRef);
  });
});
