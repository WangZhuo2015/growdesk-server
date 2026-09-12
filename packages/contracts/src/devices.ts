import { Type, type Static } from "@sinclair/typebox";
import {
  Nullable,
  DateTimeString,
  UuidString,
  PaginatedEnvelope,
  SuccessStatusResponseSchema,
} from "./common.js";

export const PushPlatformSchema = Type.Union([
  Type.Literal("ios"),
  Type.Literal("web"),
]);

export type PushPlatform = Static<typeof PushPlatformSchema>;

export const PushEnvironmentSchema = Type.Union([
  Type.Literal("sandbox"),
  Type.Literal("production"),
]);

export type PushEnvironment = Static<typeof PushEnvironmentSchema>;

export const RegisterPushDeviceRequestSchema = Type.Object(
  {
    platform: PushPlatformSchema,
    environment: PushEnvironmentSchema,
    token: Type.String({ minLength: 1 }),
    deviceLabel: Type.Optional(Type.String({ maxLength: 100 })),
  },
  { $id: "RegisterPushDeviceRequest", additionalProperties: false }
);

export type RegisterPushDeviceRequest = Static<typeof RegisterPushDeviceRequestSchema>;

export const UnregisterPushDeviceResponseSchema = SuccessStatusResponseSchema;
export type UnregisterPushDeviceResponse = Static<typeof UnregisterPushDeviceResponseSchema>;

export const NotificationItemSchema = Type.Object(
  {
    id: UuidString,
    userId: UuidString,
    eventKey: Type.String(),
    title: Type.String(),
    body: Type.String(),
    data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    readAt: Nullable(DateTimeString),
    createdAt: DateTimeString,
  },
  { $id: "NotificationItem", additionalProperties: false }
);

export type NotificationItem = Static<typeof NotificationItemSchema>;

export const NotificationListResponseSchema = PaginatedEnvelope(NotificationItemSchema, {
  $id: "NotificationListResponse",
});

export type NotificationListResponse = Static<typeof NotificationListResponseSchema>;

export const MarkNotificationReadResponseSchema = SuccessStatusResponseSchema;
export type MarkNotificationReadResponse = Static<typeof MarkNotificationReadResponseSchema>;
