import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { parseRedisConfig, type RedisConfig } from "@growdesk/adapters";
import { parseDatabaseConfig, type DatabaseConfig } from "@growdesk/database";

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

export async function runScheduler(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  requireSchedulerDependencies(env);
  const runtime = createSchedulerRuntime();
  const stop = (): void => runtime.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.info("GrowDesk scheduler is idle: durable jobs are not registered in BOOT-02.");
  try {
    await runtime.run();
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
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
