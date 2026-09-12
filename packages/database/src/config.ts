export type DatabaseGuardMode = "test" | "runtime";

export interface DatabaseConfig {
  readonly url: string;
  readonly protocol: "postgresql:";
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly sslmode: string | null;
}

export class DatabaseConfigError extends Error {
  readonly code = "DATABASE_CONFIG_REJECTED";

  constructor(reason: string) {
    super(`Database configuration rejected: ${reason}`);
    this.name = "DatabaseConfigError";
  }
}

function fail(reason: string): never {
  throw new DatabaseConfigError(reason);
}

/**
 * Validate a PostgreSQL URL before a driver or Prisma client is constructed.
 * Test mode is intentionally narrow so a typo cannot fall through to a local
 * production database or the historical SQLite files. This parser does not
 * prove ownership of a running instance; the isolated runner must validate its
 * manifest, cluster token, database, and role before opening a business client.
 */
export function parseDatabaseConfig(
  raw: string | undefined,
  mode: DatabaseGuardMode = "test",
): DatabaseConfig {
  if (!raw) {
    return fail("DATABASE_URL is required");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("DATABASE_URL must be a valid URL");
  }

  if (url.protocol !== "postgresql:") {
    return fail("only postgresql:// URLs are supported; SQLite and file URLs are rejected");
  }
  if (!url.hostname || !url.username || !url.password) {
    return fail("host, username, and password are required");
  }
  if (url.hash) {
    return fail("URL fragments are not accepted");
  }

  for (const [key] of url.searchParams) {
    if (key !== "sslmode" || url.searchParams.getAll(key).length !== 1) {
      return fail("driver connection overrides are not accepted");
    }
  }

  let database: string;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return fail("database name encoding is invalid");
  }
  if (!database || database.includes("/")) {
    return fail("a single database name is required");
  }
  const port = Number(url.port || "5432");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return fail("port is invalid");
  }
  if (mode === "test" && url.searchParams.has("sslmode") && url.searchParams.get("sslmode") !== "disable") {
    return fail("test PostgreSQL must use sslmode=disable");
  }

  if (mode === "test") {
    if (url.hostname !== "127.0.0.1") {
      return fail("test PostgreSQL must use the owned loopback host");
    }
    if (port === 5432) {
      return fail("test PostgreSQL must use a dedicated non-default port");
    }
    if (!/^test_[a-z0-9_]+$/i.test(database)) {
      return fail("test database must use a test_ name");
    }
    if (!/^test_[a-z0-9_]+$/i.test(url.username)) {
      return fail("test role must use a test_ name");
    }
  }

  return {
    url: raw,
    protocol: url.protocol,
    host: url.hostname,
    port,
    database,
    username: url.username,
    sslmode: url.searchParams.get("sslmode"),
  };
}

export function requireDatabaseConfig(
  env: NodeJS.ProcessEnv = process.env,
  mode: DatabaseGuardMode = "runtime",
): DatabaseConfig {
  return parseDatabaseConfig(env.DATABASE_URL, mode);
}
