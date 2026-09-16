import type { FastifyPluginAsync } from "fastify";
import { Type } from "@sinclair/typebox";
import { weatherResponse } from "../services/weather-service.js";
export const weatherRoutes: FastifyPluginAsync = async app => {
  const cache = new Map<string, { until: number; data: unknown }>();
  app.get("/api/v1/weather", { schema: { querystring: Type.Object({ lat: Type.Optional(Type.Number({ minimum: -90, maximum: 90 })), lon: Type.Optional(Type.Number({ minimum: -180, maximum: 180 })), city: Type.Optional(Type.String({ maxLength: 100 })) }, { additionalProperties: false }) } }, async (request, reply) => {
    const key = request.url;
    const cached = cache.get(key);
    if (cached && cached.until > Date.now()) return { data: cached.data };
    const result = await weatherResponse(new Request(`http://localhost${request.url}`));
    const data: unknown = await result.json();
    if (!result.ok) return reply.status(result.status).send({ error: { code: "WEATHER_UNAVAILABLE", message: "天气服务暂时不可用" } });
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(key, { data, until: Date.now() + 600000 });
    return { data };
  });
};
