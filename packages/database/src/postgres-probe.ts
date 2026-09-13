import { Client, type ClientConfig } from "pg";
import { parseDatabaseConfig } from "./config.js";

const DEFAULT_TIMEOUT_MS = 1_000;

export interface PostgresProbeClient {
  connect(): Promise<unknown>;
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
  on?(event: "error", listener: (error: unknown) => void): unknown;
}

export interface PostgresProbeClientConfig {
  readonly connectionString: string;
  readonly connectionTimeoutMillis: number;
  readonly query_timeout: number;
  readonly statement_timeout: number;
}

export interface PostgresProbeOptions {
  readonly timeoutMs?: number;
  readonly createClient?: (config: PostgresProbeClientConfig) => PostgresProbeClient;
}

export interface PostgresProbe {
  check(): Promise<boolean>;
  close(): Promise<void>;
}

function timeoutMs(raw: number | undefined): number {
  return Number.isInteger(raw) && raw !== undefined && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function createPgClient(config: PostgresProbeClientConfig): PostgresProbeClient {
  const clientConfig: ClientConfig = {
    connectionString: config.connectionString,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    query_timeout: config.query_timeout,
    statement_timeout: config.statement_timeout,
  };
  return new Client(clientConfig);
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

async function closeClient(client: PostgresProbeClient, limitMs: number): Promise<void> {
  try {
    await bounded(client.end(), limitMs);
  } catch {
    // A probe must stay bounded even if a broken connection does not close.
  }
}

function attachErrorHandler(client: PostgresProbeClient): void {
  client.on?.("error", () => undefined);
}

/**
 * Create a one-connection PostgreSQL readiness probe. It validates the
 * runtime URL, runs only SELECT 1, and closes the client after every check.
 * Probe failures deliberately collapse to false so driver errors cannot leak
 * connection strings or server details through the health endpoint.
 */
export function createPostgresProbe(
  raw: string | undefined,
  options: PostgresProbeOptions = {},
): PostgresProbe {
  const limitMs = timeoutMs(options.timeoutMs);
  let config: ReturnType<typeof parseDatabaseConfig> | undefined;
  try {
    config = parseDatabaseConfig(raw, "runtime");
  } catch {
    config = undefined;
  }

  let activeClient: PostgresProbeClient | undefined;
  let closed = false;
  let inFlight: Promise<boolean> | undefined;

  return {
    check(): Promise<boolean> {
      if (!config || closed) return Promise.resolve(false);
      if (inFlight) return inFlight;

      const run = (async (): Promise<boolean> => {
        let client: PostgresProbeClient | undefined;
        try {
          client = (options.createClient ?? createPgClient)({
            connectionString: config.url,
            connectionTimeoutMillis: limitMs,
            query_timeout: limitMs,
            statement_timeout: limitMs,
          });
          activeClient = client;
          attachErrorHandler(client);
          await bounded(client.connect(), limitMs);
          await bounded(client.query("SELECT 1"), limitMs);
          return true;
        } catch {
          return false;
        } finally {
          if (client) {
            if (activeClient === client) activeClient = undefined;
            await closeClient(client, limitMs);
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
      const pending = inFlight;
      if (pending) await pending.catch(() => undefined);
    },
  };
}
