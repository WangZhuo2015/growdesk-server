import { Redis, type RedisOptions } from "ioredis";
import { parseRedisConfig } from "./redis-config.js";

const DEFAULT_TIMEOUT_MS = 1_000;

export interface RedisProbeClient {
  readonly status: string;
  connect(): Promise<void>;
  ping(): Promise<string>;
  disconnect(): void;
  on?(event: "error", listener: (error: unknown) => void): unknown;
}

export interface RedisProbeClientConfig {
  readonly connectionString: string;
  readonly connectTimeout: number;
  readonly commandTimeout: number;
}

export interface RedisProbeOptions {
  readonly timeoutMs?: number;
  readonly createClient?: (config: RedisProbeClientConfig) => RedisProbeClient;
}

export interface RedisProbe {
  check(): Promise<boolean>;
  close(): Promise<void>;
}

function timeoutMs(raw: number | undefined): number {
  return Number.isInteger(raw) && raw !== undefined && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function createRedisClient(config: RedisProbeClientConfig): RedisProbeClient {
  const options: RedisOptions = {
    connectTimeout: config.connectTimeout,
    commandTimeout: config.commandTimeout,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  };
  return new Redis(config.connectionString, options);
}

async function bounded<T>(operation: Promise<T>, limitMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("probe timeout")), limitMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function attachErrorHandler(client: RedisProbeClient): void {
  client.on?.("error", () => undefined);
}

function disconnectClient(client: RedisProbeClient): void {
  try {
    client.disconnect();
  } catch {
    // A failed health probe must not surface driver teardown details.
  }
}

/**
 * Create a one-connection Redis readiness probe. It validates the runtime URL,
 * sends only PING, and disconnects after every check. Probe failures collapse
 * to false so ioredis errors cannot leak credentials or endpoint details.
 */
export function createRedisProbe(
  raw: string | undefined,
  options: RedisProbeOptions = {},
): RedisProbe {
  const limitMs = timeoutMs(options.timeoutMs);
  let config: ReturnType<typeof parseRedisConfig> | undefined;
  try {
    config = parseRedisConfig(raw, "runtime");
  } catch {
    config = undefined;
  }

  let activeClient: RedisProbeClient | undefined;
  let closed = false;
  let inFlight: Promise<boolean> | undefined;

  return {
    check(): Promise<boolean> {
      if (!config || closed) return Promise.resolve(false);
      if (inFlight) return inFlight;

      const run = (async (): Promise<boolean> => {
        let client: RedisProbeClient | undefined;
        try {
          client = (options.createClient ?? createRedisClient)({
            connectionString: config.url,
            connectTimeout: limitMs,
            commandTimeout: limitMs,
          });
          activeClient = client;
          attachErrorHandler(client);
          await bounded(client.connect(), limitMs);
          return (await bounded(client.ping(), limitMs)) === "PONG";
        } catch {
          return false;
        } finally {
          if (client) {
            if (activeClient === client) activeClient = undefined;
            disconnectClient(client);
          }
        }
      })();
      const shared = run.finally(() => {
        if (inFlight === shared) inFlight = undefined;
      });
      inFlight = shared;
      return shared;
    },
    async close(): Promise<void> {
      closed = true;
      const client = activeClient;
      activeClient = undefined;
      if (client) disconnectClient(client);
      const pending = inFlight;
      if (pending) await pending.catch(() => undefined);
    },
  };
}
