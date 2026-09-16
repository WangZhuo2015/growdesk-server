import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { parseRedisConfig, type RedisConfig } from "@growdesk/adapters";
import { createDatabaseContext, parseDatabaseConfig, type DatabaseConfig } from "@growdesk/database";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { SchedulerEngine } from "./scheduler-engine.js";
export * from "./scheduler-engine.js";

export interface SchedulerDependencies {
  readonly database: DatabaseConfig;
  readonly redis: RedisConfig;
}

export function requireSchedulerDependencies(env: NodeJS.ProcessEnv = process.env): SchedulerDependencies {
  return {
    database: parseDatabaseConfig(env.DATABASE_URL, "runtime"),
    redis: parseRedisConfig(env.REDIS_URL, "runtime"),
  };
}

export interface SchedulerRuntime {
  readonly run: () => Promise<void>;
  readonly stop: () => void;
}

/** A signal-aware idle runtime until durable dispatch/reconcile is implemented. */
export function createSchedulerRuntime(): SchedulerRuntime {
  let stopped = false;
  let resolveStopped: (() => void) | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  const stoppedPromise = new Promise<void>((resolvePromise) => {
    resolveStopped = resolvePromise;
  });

  return {
    async run(): Promise<void> {
      if (stopped) return;
      // A pending Promise alone does not keep a Node process alive. Keep one
      // owned timer so a configured scheduler can receive SIGTERM reliably.
      heartbeat = setInterval(() => undefined, 60_000);
      try {
        await stoppedPromise;
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = undefined;
      }
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      resolveStopped?.();
    },
  };
}

function readQueueName(env: NodeJS.ProcessEnv): string {
  const value = (env.GROWDESK_TASK_QUEUE ?? "growdesk-tasks").trim();
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(value)) {
    throw new Error("GROWDESK_TASK_QUEUE must contain only letters, digits, '.', '_' or '-'");
  }
  return value;
}

function readDispatchBatchSize(env: NodeJS.ProcessEnv): number {
  const value = Number(env.GROWDESK_DISPATCH_BATCH_SIZE ?? "100");
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("GROWDESK_DISPATCH_BATCH_SIZE must be an integer between 1 and 100");
  }
  return value;
}

function asPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export async function runScheduler(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const dependencies = requireSchedulerDependencies(env);
  const database = createDatabaseContext({ url: dependencies.database.url });
  const redis = new Redis(dependencies.redis.url, { maxRetriesPerRequest: null });
  const queueName = readQueueName(env);
  const queue = new Queue(queueName, { connection: redis });
  const scheduler = new SchedulerEngine({
    pool: database.pool,
    dispatchBatchSize: readDispatchBatchSize(env),
    onDispatch: async (item) => {
      const payload = asPayload(item.payload);
      // Outbox closure occurs in SchedulerEngine only after this add resolves.
      // A stable ID makes a repeated PG dispatch an idempotent transport write.
      await queue.add(
        item.type,
        {
          taskId: item.aggregateId,
          outboxId: item.id,
          payloadVersion: item.payloadVersion,
          payload,
        },
        {
          jobId: `growdesk-${item.aggregateId}-${item.phaseKey}-${item.id}`,
          removeOnComplete: { age: 3600, count: 10_000 },
          removeOnFail: { age: 86_400, count: 10_000 },
        },
      );
    },
  });

  const runtime = createSchedulerRuntime();
  const stop = (): void => runtime.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const dispatchTimer = setInterval(() => {
    void scheduler.dispatchBatch().catch((error: unknown) => {
      console.error("Scheduler dispatch failed", error instanceof Error ? error.message : String(error));
    });
  }, 1_000);
  const reconcileTimer = setInterval(() => {
    void scheduler.reconcile().catch((error: unknown) => {
      console.error("Scheduler reconcile failed", error instanceof Error ? error.message : String(error));
    });
  }, 30_000);
  console.info(`GrowDesk scheduler dispatching queue '${queueName}'`);
  try {
    await scheduler.reconcile();
    await scheduler.dispatchBatch();
    await runtime.run();
  } finally {
    clearInterval(dispatchTimer);
    clearInterval(reconcileTimer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await queue.close();
    await redis.quit();
    await database.close();
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMainModule()) {
  runScheduler().catch((error: unknown) => {
    console.error("Scheduler startup failed");
    process.exitCode = 1;
    if (error instanceof Error) console.error(error.message);
  });
}
