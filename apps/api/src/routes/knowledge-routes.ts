import type { FastifyPluginAsync } from "fastify";
import { Type } from "@sinclair/typebox";
import { MilestoneListResponseSchema, ActivityListResponseSchema, WarningSignListResponseSchema, AppConfigResponseSchema } from "@growdesk/contracts";
import { referenceData } from "../knowledge/legacy-reference-data.js";

const Query = Type.Object({ month: Type.Optional(Type.Integer({ minimum: 0, maximum: 216 })), category: Type.Optional(Type.String({ maxLength: 80 })) }, { additionalProperties: false });
type KnowledgeQuery = { month?: number; category?: string };
export const knowledgeRoutes: FastifyPluginAsync = async app => {
  const schemas = { milestones: MilestoneListResponseSchema, activities: ActivityListResponseSchema, "warning-signs": WarningSignListResponseSchema };
  for (const kind of ["milestones", "activities", "warning-signs"] as const) {
    app.get<{ Querystring: KnowledgeQuery }>(`/api/v1/development/${kind}`, {
      preHandler: [app.authenticate], schema: { querystring: Query, response: { 200: schemas[kind] } },
    }, async request => {
      const { month, category } = request.query;
      const source = kind === "warning-signs" ? referenceData.warningSigns : referenceData[kind];
      const filtered = source.filter(item => {
        if (category && item.category !== category) return false;
        if (month === undefined) return true;
        if (kind === "activities") return (item.ageMinMonths == null || Number(item.ageMinMonths) <= month) && (item.ageMaxMonths == null || Number(item.ageMaxMonths) >= month);
        return Number(item.monthAge) === month;
      });
      return { data: filtered.map(item => ({ ...item, details: item })), ...(kind === "milestones" ? { dataRelease: referenceData.dataRelease } : {}) };
    });
  }
  app.get<{ Querystring: KnowledgeQuery }>("/api/v1/knowledge/feeding-guidelines", { preHandler: [app.authenticate], schema: { querystring: Query } }, async request => ({
    data: referenceData.guidelines.filter(item => request.query.month === undefined || (Number(item.ageMinMonths) <= request.query.month && Number(item.ageMaxMonths) >= request.query.month)),
  }));
  app.get("/api/v1/app-config", { schema: { response: { 200: AppConfigResponseSchema } } }, async () => ({ data: {
    timeZone: "Asia/Shanghai", features: { swDisabled: process.env.SW_DISABLED === "1", cloud: true }, serverVersion: "0.1.0", minClientVersion: "0.1.0",
  } }));
};
