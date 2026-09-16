import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { parseRedisConfig, type RedisConfig } from "@growdesk/adapters";
import { createDatabaseContext, parseDatabaseConfig, type DatabaseConfig } from "@growdesk/database";
import { Worker as BullWorker } from "bullmq";
import { Redis } from "ioredis";
import { createAiChatProcessor, createUnsupportedAiProcessor } from "./ai-processor.js";
import { WorkerEngine } from "./worker-engine.js";
export * from "./worker-engine.js";
export * from "./ai-provider.js";
export * from "./ai-processor.js";

export interface WorkerDependencies {
  readonly database: DatabaseConfig;
  readonly redis: RedisConfig;
}

export function requireWorkerDependencies(env: NodeJS.ProcessEnv = process.env): WorkerDependencies {
  return {
    database: parseDatabaseConfig(env.DATABASE_URL, "runtime"),
    redis: parseRedisConfig(env.REDIS_URL, "runtime"),
  };
}

export interface WorkerRuntime {
  readonly run: () => Promise<void>;
  readonly stop: () => void;
}

/** A signal-aware idle runtime until a feature task registers real processors. */
export function createWorkerRuntime(): WorkerRuntime {
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
      // owned timer so a configured worker can receive SIGTERM reliably.
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

function readConcurrency(env: NodeJS.ProcessEnv): number {
  const raw = env.GROWDESK_WORKER_CONCURRENCY ?? "4";
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 64) {
    throw new Error("GROWDESK_WORKER_CONCURRENCY must be an integer between 1 and 64");
  }
  return value;
}

interface DurableTaskJob {
  readonly taskId: string;
  readonly outboxId?: string;
  readonly payload?: Record<string, unknown>;
}

function readJobData(value: unknown): DurableTaskJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("BullMQ job data must be an object");
  }
  const data = value as Record<string, unknown>;
  if (typeof data.taskId !== "string" || data.taskId.length === 0) {
    throw new Error("BullMQ job data is missing taskId");
  }
  const payload = data.payload && typeof data.payload === "object" && !Array.isArray(data.payload)
    ? data.payload as Record<string, unknown>
    : {};
  return { taskId: data.taskId, outboxId: typeof data.outboxId === "string" ? data.outboxId : undefined, payload };
}

export async function runWorker(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const dependencies = requireWorkerDependencies(env);
  const database = createDatabaseContext({ url: dependencies.database.url });
  const redis = new Redis(dependencies.redis.url, { maxRetriesPerRequest: null });
  const queueName = readQueueName(env);
  const engine = new WorkerEngine({
    pool: database.pool,
    workerId: env.GROWDESK_WORKER_ID,
    leaseSeconds: Number(env.GROWDESK_TASK_LEASE_SECONDS ?? 60),
  });
  engine.registerProcessor(createAiChatProcessor(database.pool, { env }));
  engine.registerProcessor(createUnsupportedAiProcessor("voice_transcription"));
  engine.registerProcessor(createUnsupportedAiProcessor("daily_summary_synthesis"));

  const worker = new BullWorker<DurableTaskJob>(
    queueName,
    async (job) => {
      const data = readJobData(job.data);
      const payload = await engine.loadTaskPayload(data.taskId, data.payload);
      // TaskExecutionRepository owns business retry/attempt state. A failed
      // task is therefore returned as a completed transport job, preventing
      // BullMQ's transport retry from creating a second paid provider call.
      return await engine.processTask(data.taskId, payload);
    },
    {
      connection: redis,
      concurrency: readConcurrency(env),
      autorun: true,
    },
  );

  const runtime = createWorkerRuntime();
  const stop = (): void => runtime.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.info(`GrowDesk worker listening on queue '${queueName}'`);
  try {
    await runtime.run();
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await worker.close();
    await redis.quit();
    await database.close();
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMainModule()) {
  runWorker().catch((error: unknown) => {
    console.error("Worker startup failed");
    process.exitCode = 1;
    if (error instanceof Error) console.error(error.message);
  });
}
