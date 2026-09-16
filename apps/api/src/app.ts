import Fastify from "fastify";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import * as contracts from "@growdesk/contracts";
import { createDatabaseContext, type DatabaseContext } from "@growdesk/database";
import { randomUUID } from "node:crypto";
import { createReadinessDependencies, type ReadinessDependencies } from "./readiness.js";
import { authPlugin } from "./plugins/auth-plugin.js";
import { authRoutes } from "./routes/auth-routes.js";
import { familyRoutes } from "./routes/family-routes.js";
import { babyRoutes } from "./routes/baby-routes.js";
import { feedingRoutes } from "./routes/feeding-routes.js";
import { formulaProductRoutes } from "./routes/formula-product-routes.js";
import { diaperRoutes } from "./routes/diaper-routes.js";
import { sleepRoutes } from "./routes/sleep-routes.js";
import { foodRoutes } from "./routes/food-routes.js";
import { supplementRoutes } from "./routes/supplement-routes.js";
import { growthRoutes } from "./routes/growth-routes.js";
import { timelineRoutes } from "./routes/timeline-routes.js";
import { attachmentRoutes } from "./routes/attachment-routes.js";
import { medicalRoutes } from "./routes/medical-routes.js";
import { notificationRoutes } from "./routes/notification-routes.js";
import { aiRoutes } from "./routes/ai-routes.js";
import { syncRoutes } from "./routes/sync-routes.js";
import { bookRoutes } from "./routes/book-routes.js";
import { knowledgeRoutes } from "./routes/knowledge-routes.js";
import { weatherRoutes } from "./routes/weather-routes.js";
import { webAiRoutes } from "./routes/web-ai-routes.js";
import { AttachmentService } from "./services/attachment-service.js";
import { MedicalService } from "./services/medical-service.js";
import { VaccineService } from "./services/vaccine-service.js";
import { NotificationService } from "./services/notification-service.js";
import { AiService } from "./services/ai-service.js";
import { SyncService } from "./services/sync-service.js";
import { type StorageDriver, AwsS3StorageDriver, MockStorageDriver } from "./storage/s3-storage-service.js";
import type { ReplayStore } from "./auth/replay-store.js";

export interface ApiAppOptions {
  readonly logger?: boolean;
  readonly databaseUrl?: string;
  readonly redisUrl?: string;
  readonly readiness?: ReadinessDependencies;
  readonly databaseContext?: DatabaseContext;
  readonly replayStore?: ReplayStore;
  readonly jwtSecret?: string;
  readonly storageDriver?: StorageDriver;
}

/** Build HTTP routes against the caller's explicit database context. */
export function buildApiApp(options: ApiAppOptions = {}) {
  const readiness = options.readiness ?? createReadinessDependencies({ DATABASE_URL: options.databaseUrl, REDIS_URL: options.redisUrl });
  const ownsDatabase = !options.databaseContext && Boolean(options.databaseUrl);
  const database = options.databaseContext ?? (options.databaseUrl ? createDatabaseContext({ url: options.databaseUrl }) : undefined);
  const app = Fastify({ logger: options.logger ?? false }).withTypeProvider<TypeBoxTypeProvider>();

  // Register canonical schemas once; exported aliases must not silently conflict.
  const registered = new Map<string, string>();
  for (const schema of Object.values(contracts)) {
    if (!schema || typeof schema !== "object" || !("$id" in schema) || typeof schema.$id !== "string") continue;
    const encoded = JSON.stringify(schema);
    const previous = registered.get(schema.$id);
    if (previous !== undefined) {
      if (previous !== encoded) throw new Error(`Conflicting contract schema: ${schema.$id}`);
      continue;
    }
    registered.set(schema.$id, encoded);
    app.addSchema(schema);
  }
  app.setErrorHandler((error: unknown, request, reply) => {
    const err = error as { statusCode?: number; code?: string; message?: string };
    const statusCode = err.statusCode ?? 500;
    const codes: Record<number, string> = { 400: "BAD_REQUEST", 401: "UNAUTHORIZED", 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "CONFLICT" };
    reply.status(statusCode).send({ error: { code: err.code ?? codes[statusCode] ?? "INTERNAL_ERROR",
      message: err.message ?? "An unexpected error occurred", requestId: request.id || randomUUID() } });
  });
  app.get("/health/live", { schema: { operationId: "getHealthLive", response: { 200: contracts.HealthLiveResponseSchema } } },
    async (): Promise<contracts.HealthLiveResponse> => ({ status: "ok", service: "growdesk-api" }));
  app.get("/health/ready", { schema: { operationId: "getHealthReady", response: { 200: contracts.HealthReadyResponseSchema, 503: contracts.HealthReadyResponseSchema } } },
    async (_request, reply): Promise<contracts.HealthReadyResponse> => {
      let result = { postgres: false, redis: false };
      try { result = await readiness.check(); } catch { /* Fail closed without driver details. */ }
      const ready = result.postgres && result.redis;
      if (!ready) reply.code(503);
      return { status: ready ? "ok" : "unavailable", service: "growdesk-api", stage: "foundation",
        dependencies: { postgres: result.postgres ? "ok" : "unavailable", redis: result.redis ? "ok" : "unavailable" } };
    });

  if (database) {
    const { prisma, pool } = database;
    app.register(authPlugin, { prisma, jwtSecret: options.jwtSecret });
    app.register(authRoutes, { prisma, pool, replayStore: options.replayStore, jwtSecret: options.jwtSecret });
    app.register(knowledgeRoutes);
    app.register(weatherRoutes);
    app.register(bookRoutes, { prisma });
    app.register(familyRoutes, { prisma });
    app.register(babyRoutes, { prisma });
    app.register(feedingRoutes, { prisma });
    app.register(formulaProductRoutes, { prisma });
    app.register(diaperRoutes, { prisma });
    app.register(sleepRoutes, { prisma });
    app.register(foodRoutes, { prisma });
    app.register(supplementRoutes, { prisma });
    app.register(growthRoutes, { prisma });
    app.register(timelineRoutes, { prisma });
    const storage = options.storageDriver ?? (process.env.S3_BUCKET ? new AwsS3StorageDriver({
      bucket: process.env.S3_BUCKET, endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }) : new MockStorageDriver());
    app.register(attachmentRoutes, { attachmentService: new AttachmentService(prisma, storage) });
    app.register(medicalRoutes, { medicalService: new MedicalService(prisma), vaccineService: new VaccineService(prisma) });
    app.register(notificationRoutes, { notificationService: new NotificationService(prisma) });
    app.register(aiRoutes, { aiService: new AiService(prisma, pool) });
    app.register(webAiRoutes, { pool });
    app.register(syncRoutes, { syncService: new SyncService(prisma) });
  }
  app.addHook("onClose", async () => { await readiness.close(); if (ownsDatabase && database) await database.close(); });
  return app;
}
