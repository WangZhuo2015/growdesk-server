import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { buildApiApp } from "./app.js";

const DEFAULT_PORT = 3080;
const DEFAULT_HOST = "127.0.0.1";

function readPort(raw: string | undefined): number {
  const port = Number(raw ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer from 1 through 65535");
  }
  return port;
}

export async function startApiServer(): Promise<void> {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) throw new Error("JWT_SECRET must contain at least 32 characters");
  if (!process.env.S3_BUCKET) throw new Error("S3_BUCKET is required for persistent attachment storage");
  const app = buildApiApp({
    jwtSecret,
    logger: true,
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
  });
  const port = readPort(process.env.PORT);
  const host = process.env.HOST ?? DEFAULT_HOST;
  let stopping = false;

  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, "shutting down API");
    await app.close();
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));

  try {
    await app.listen({ host, port });
    app.log.info({ host, port }, "GrowDesk API listening");
  } catch (error) {
    await app.close();
    throw error;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMainModule()) {
  startApiServer().catch((error: unknown) => {
    console.error("API startup failed");
    process.exitCode = 1;
    if (error instanceof Error) console.error(error.message);
  });
}
