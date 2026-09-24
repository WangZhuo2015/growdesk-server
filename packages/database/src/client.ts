import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client.js";
import { parseDatabaseConfig } from "./config.js";

export interface DatabaseContextOptions {
  readonly url: string;
  readonly maxConnections?: number;
  readonly idleTimeoutMillis?: number;
  readonly connectionTimeoutMillis?: number;
}

export interface DatabaseContext {
  readonly pool: pg.Pool;
  readonly adapter: PrismaPg;
  readonly prisma: PrismaClient;
  close(): Promise<void>;
}

export function createDatabaseContext(options: DatabaseContextOptions): DatabaseContext {
  const config = parseDatabaseConfig(options.url, "runtime");

  const pool = new pg.Pool({
    connectionString: config.url,
    // Prisma's PostgreSQL adapter serializes timestamps in UTC and expects
    // timestamptz results in UTC. Pin every pooled session independently of
    // the host/role timezone, including reads of SQL-imported legacy history.
    options: "-c timezone=UTC",
    max: options.maxConnections ?? 10,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 10000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5000,
  });

  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  let closed = false;

  return {
    pool,
    adapter,
    prisma,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        await prisma.$disconnect();
      } finally {
        await pool.end();
      }
    },
  };
}
