import Fastify from "fastify";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import {
  HealthLiveResponseSchema,
  HealthReadyResponseSchema,
  type HealthLiveResponse,
  type HealthReadyResponse,
} from "@growdesk/contracts";
import {
  createReadinessDependencies,
  type ReadinessDependencies,
} from "./readiness.js";

export interface ApiAppOptions {
  readonly logger?: boolean;
  readonly databaseUrl?: string;
  readonly redisUrl?: string;
  readonly readiness?: ReadinessDependencies;
}

/**
 * Build the HTTP application without opening a listener or external client.
 * The liveness route intentionally reports process health only. Readiness is
 * limited to the foundation PostgreSQL and Redis probes; auth, schema and
 * business readiness belong to later implementation tasks.
 */
export function buildApiApp(options: ApiAppOptions = {}) {
  const readiness = options.readiness ?? createReadinessDependencies({
    DATABASE_URL: options.databaseUrl,
    REDIS_URL: options.redisUrl,
  });
  const app = Fastify({
    logger: options.logger ?? false,
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.addSchema(HealthLiveResponseSchema);
  app.addSchema(HealthReadyResponseSchema);
  app.get(
    "/health/live",
    {
      schema: {
        operationId: "getHealthLive",
        response: {
          200: HealthLiveResponseSchema,
        },
      },
    },
    async (): Promise<HealthLiveResponse> => ({
      status: "ok",
      service: "growdesk-api",
    }),
  );

  app.get(
    "/health/ready",
    {
      schema: {
        operationId: "getHealthReady",
        response: {
          200: HealthReadyResponseSchema,
          503: HealthReadyResponseSchema,
        },
      },
    },
    async (_request, reply): Promise<HealthReadyResponse> => {
      let result = { postgres: false, redis: false };
      try {
        result = await readiness.check();
      } catch {
        // Readiness fails closed without returning driver details.
      }
      const ready = result.postgres && result.redis;
      if (!ready) reply.code(503);
      return {
        status: ready ? "ok" : "unavailable",
        service: "growdesk-api",
        stage: "foundation",
        dependencies: {
          postgres: result.postgres ? "ok" : "unavailable",
          redis: result.redis ? "ok" : "unavailable",
        },
      };
    },
  );

  app.addHook("onClose", async () => {
    await readiness.close();
  });

  return app;
}
