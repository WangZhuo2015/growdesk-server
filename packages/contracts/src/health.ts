import { Type, type Static } from "@sinclair/typebox";

export const HealthLiveResponseSchema = Type.Object(
  {
    status: Type.Literal("ok"),
    service: Type.Literal("growdesk-api"),
  },
  {
    $id: "HealthLiveResponse",
    additionalProperties: false,
  }
);

export type HealthLiveResponse = Static<typeof HealthLiveResponseSchema>;

export const HealthDependencyStatusSchema = Type.Union([
  Type.Literal("ok"),
  Type.Literal("unavailable"),
]);

export type HealthDependencyStatus = Static<typeof HealthDependencyStatusSchema>;

export const HealthReadyResponseSchema = Type.Object(
  {
    status: HealthDependencyStatusSchema,
    service: Type.Literal("growdesk-api"),
    stage: Type.Literal("foundation"),
    dependencies: Type.Object(
      {
        postgres: HealthDependencyStatusSchema,
        redis: HealthDependencyStatusSchema,
      },
      { additionalProperties: false }
    ),
  },
  {
    $id: "HealthReadyResponse",
    additionalProperties: false,
  }
);

export type HealthReadyResponse = Static<typeof HealthReadyResponseSchema>;
