import { Type, type Static } from "@sinclair/typebox";

export const AppConfigSchema = Type.Object(
  {
    timeZone: Type.String({ description: "Default server time zone" }),
    features: Type.Record(Type.String(), Type.Boolean(), { description: "Feature flags" }),
    serverVersion: Type.String({ description: "Current server semver" }),
    minClientVersion: Type.String({ description: "Minimum supported client semver" }),
  },
  { $id: "AppConfig", additionalProperties: false }
);

export type AppConfig = Static<typeof AppConfigSchema>;

export const AppConfigResponseSchema = Type.Object(
  {
    data: AppConfigSchema,
  },
  { $id: "AppConfigResponse", additionalProperties: false }
);

export type AppConfigResponse = Static<typeof AppConfigResponseSchema>;
