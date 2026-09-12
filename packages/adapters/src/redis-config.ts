export type RedisGuardMode = "test" | "runtime";

export interface RedisConfig {
  readonly url: string;
  readonly protocol: "redis:" | "rediss:";
  readonly host: string;
  readonly port: number;
  readonly database: number;
  readonly username: string | null;
}

export class RedisConfigError extends Error {
  readonly code = "REDIS_CONFIG_REJECTED";

  constructor(reason: string) {
    super(`Redis configuration rejected: ${reason}`);
    this.name = "RedisConfigError";
  }
}

function fail(reason: string): never {
  throw new RedisConfigError(reason);
}

/**
 * Parse Redis configuration without opening a socket. Test mode is deliberately
 * strict: only a loopback, password-protected, non-default test port is valid.
 * This parser checks shape and policy only; the isolated runner must still
 * verify the owned process identity before a client opens a socket.
 */
export function parseRedisConfig(
  raw: string | undefined,
  mode: RedisGuardMode = "test",
): RedisConfig {
  if (!raw) {
    return fail("REDIS_URL is required");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("REDIS_URL must be a valid URL");
  }

  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    return fail("only redis:// or rediss:// URLs are supported");
  }
  if (!url.hostname) {
    return fail("a host is required");
  }
  if (url.search || url.hash) {
    return fail("query parameters and fragments are not accepted");
  }
  if (mode === "test" && url.username && url.username !== "default") {
    return fail("only the default Redis user is supported");
  }
  if (!url.password) {
    return fail("a password is required");
  }

  const port = Number(url.port || "6379");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return fail("port is invalid");
  }

  const databaseText = url.pathname === "" || url.pathname === "/" ? "0" : url.pathname.slice(1);
  const database = Number(databaseText);
  if (!Number.isInteger(database) || database < 0 || database > 15) {
    return fail("database index is invalid");
  }

  if (mode === "test") {
    if (url.hostname !== "127.0.0.1") {
      return fail("test Redis must use the owned loopback host");
    }
    if (port === 6379) {
      return fail("test Redis must use a dedicated non-default port");
    }
  }

  return {
    url: raw,
    protocol: url.protocol,
    host: url.hostname,
    port,
    database,
    username: url.username || null,
  };
}

export function requireRedisConfig(
  env: NodeJS.ProcessEnv = process.env,
  mode: RedisGuardMode = "runtime",
): RedisConfig {
  return parseRedisConfig(env.REDIS_URL, mode);
}
