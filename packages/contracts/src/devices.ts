import { Type, type Static } from "@sinclair/typebox";
import {
  Nullable,
  DateTimeString,
  UuidString,
  PaginatedEnvelope,
  SuccessEnvelope,
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

export const NotificationQuietHoursSchema = Type.Object({
  start: Type.String({ pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$", description: "Inclusive local HH:mm; must differ from end" }),
  end: Type.String({ pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$", description: "Exclusive local HH:mm; may cross midnight" }),
}, { $id: "NotificationQuietHours", additionalProperties: false });

export const NotificationKindsSchema = Type.Object({
  family_record: Type.Boolean({ description: "Family care record notifications; subscribed devices default to enabled" }),
}, { $id: "NotificationKinds", additionalProperties: false });

export const NotificationPreferencesQuerySchema = Type.Object({
  babyId: Type.Optional(UuidString),
}, { $id: "NotificationPreferencesQuery", additionalProperties: false });

export const PutNotificationPreferencesRequestSchema = Type.Object({
  babyId: Type.Optional(Nullable(UuidString)),
  timeZone: Type.String({ minLength: 1, maxLength: 100, description: "IANA timezone, validated by the server; Local is not accepted" }),
  kinds: NotificationKindsSchema,
  quietHours: Nullable(NotificationQuietHoursSchema),
}, { $id: "PutNotificationPreferencesRequest", additionalProperties: false });
export type PutNotificationPreferencesRequest = Static<typeof PutNotificationPreferencesRequestSchema>;

export const NotificationPreferencesSchema = Type.Object({
  babyId: Nullable(UuidString),
  timeZone: Type.String(),
  kinds: NotificationKindsSchema,
  quietHours: Nullable(NotificationQuietHoursSchema),
}, { $id: "NotificationPreferences", additionalProperties: false });
export type NotificationPreferences = Static<typeof NotificationPreferencesSchema>;
export const NotificationPreferencesResponseSchema = SuccessEnvelope(NotificationPreferencesSchema, {
  $id: "NotificationPreferencesResponse",
});
export type NotificationPreferencesResponse = Static<typeof NotificationPreferencesResponseSchema>;
