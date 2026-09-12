import { createRedisProbe, type RedisProbe } from "@growdesk/adapters";
import { createPostgresProbe, type PostgresProbe } from "@growdesk/database";

export interface ReadinessResult {
  readonly postgres: boolean;
  readonly redis: boolean;
}

export interface ReadinessDependencies {
  check(): Promise<ReadinessResult>;
  close(): Promise<void>;
}

/**
 * Build the foundation dependency checks used by /health/ready. Missing or
 * invalid configuration is represented as false; it never prevents /health/live
 * from serving and never exposes connection details in an HTTP response.
 */
export function createReadinessDependencies(
  env: NodeJS.ProcessEnv = process.env,
): ReadinessDependencies {
  const postgres: PostgresProbe = createPostgresProbe(env.DATABASE_URL);
  const redis: RedisProbe = createRedisProbe(env.REDIS_URL);

  return {
    async check(): Promise<ReadinessResult> {
      const [postgresReady, redisReady] = await Promise.all([
        postgres.check(),
        redis.check(),
      ]);
      return { postgres: postgresReady, redis: redisReady };
    },
    async close(): Promise<void> {
      await Promise.all([postgres.close(), redis.close()]);
    },
  };
}
