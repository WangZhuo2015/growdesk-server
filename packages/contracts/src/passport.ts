import { Type, type Static } from "@sinclair/typebox";
import {
  ApiErrorEnvelopeSchema,
  DateTimeString,
  Nullable,
  PaginatedEnvelope,
  PaginationQuerySchema,
  SuccessStatusResponseSchema,
  UuidString,
} from "./common.js";
import type { RouteDefinition } from "./routes.js";

// ==========================================
// 1. Passport Pairings
// ==========================================

export const PassportCapabilitiesSchema = Type.Object(
  {
    display: Type.Optional(Type.String({ maxLength: 50 })),
    microphone: Type.Optional(Type.Boolean()),
    speaker: Type.Optional(Type.Boolean()),
    buttons: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
  },
  { $id: "PassportCapabilities", additionalProperties: true }
);

export type PassportCapabilities = Static<typeof PassportCapabilitiesSchema>;

export const CreatePassportPairingRequestSchema = Type.Object(
  {
    hardware: Type.String({ minLength: 1, maxLength: 100 }),
    firmwareVersion: Type.String({ minLength: 1, maxLength: 100 }),
    capabilities: Type.Optional(PassportCapabilitiesSchema),
  },
  { $id: "CreatePassportPairingRequest", additionalProperties: false }
);

export type CreatePassportPairingRequest = Static<typeof CreatePassportPairingRequestSchema>;

export const CreatePassportPairingResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        pairingId: UuidString,
        pairCode: Type.String({ minLength: 4, maxLength: 20 }),
        pollToken: Type.String({ minLength: 16, maxLength: 128 }),
        expiresAt: DateTimeString,
      },
      { additionalProperties: false }
    ),
  },
  { $id: "CreatePassportPairingResponse", additionalProperties: false }
);

export type CreatePassportPairingResponse = Static<typeof CreatePassportPairingResponseSchema>;

export const ClaimPassportPairingRequestSchema = Type.Object(
  {
    pairCode: Type.String({ minLength: 4, maxLength: 20 }),
    familyId: UuidString,
    babyId: UuidString,
    deviceLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  },
  { $id: "ClaimPassportPairingRequest", additionalProperties: false }
);

export type ClaimPassportPairingRequest = Static<typeof ClaimPassportPairingRequestSchema>;

export const ClaimPassportPairingResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        pairingId: UuidString,
        status: Type.Literal("claimed"),
      },
      { additionalProperties: false }
    ),
  },
  { $id: "ClaimPassportPairingResponse", additionalProperties: false }
);

export type ClaimPassportPairingResponse = Static<typeof ClaimPassportPairingResponseSchema>;

export const PollPassportPairingRequestSchema = Type.Object(
  {
    pollToken: Type.String({ minLength: 16, maxLength: 128 }),
  },
  { $id: "PollPassportPairingRequest", additionalProperties: false }
);

export type PollPassportPairingRequest = Static<typeof PollPassportPairingRequestSchema>;

export const PollPassportPairingResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        status: Type.Union([
          Type.Literal("pending"),
          Type.Literal("claimed"),
          Type.Literal("completed"),
          Type.Literal("expired"),
        ]),
        deviceId: Type.Optional(UuidString),
        deviceCredential: Type.Optional(Type.String({ minLength: 16, maxLength: 128 })),
        familyId: Type.Optional(UuidString),
        babyId: Type.Optional(UuidString),
      },
      { additionalProperties: false }
    ),
  },
  { $id: "PollPassportPairingResponse", additionalProperties: false }
);

export type PollPassportPairingResponse = Static<typeof PollPassportPairingResponseSchema>;

// ==========================================
// 2. Passport Device Auth
// ==========================================

export const PassportAuthTokenRequestSchema = Type.Object(
  {
    deviceId: Type.Optional(UuidString),
    deviceCredential: Type.Optional(Type.String({ minLength: 16, maxLength: 128 })),
  },
  { $id: "PassportAuthTokenRequest", additionalProperties: false }
);

export type PassportAuthTokenRequest = Static<typeof PassportAuthTokenRequestSchema>;

export const PassportAuthTokenResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        accessToken: Type.String({ minLength: 1 }),
        expiresIn: Type.Integer({ minimum: 1 }),
        tokenType: Type.Literal("Bearer"),
      },
      { additionalProperties: false }
    ),
  },
  { $id: "PassportAuthTokenResponse", additionalProperties: false }
);

export type PassportAuthTokenResponse = Static<typeof PassportAuthTokenResponseSchema>;

// ==========================================
// 3. Passport Device Management
// ==========================================

export const PassportDeviceItemSchema = Type.Object(
  {
    id: UuidString,
    ownerUserId: UuidString,
    familyId: UuidString,
    babyId: UuidString,
    deviceLabel: Type.String(),
    firmwareVersion: Nullable(Type.String()),
    hardwareVersion: Nullable(Type.String()),
    capabilities: Nullable(Type.Record(Type.String(), Type.Unknown())),
    lastSeenAt: Nullable(DateTimeString),
    revokedAt: Nullable(DateTimeString),
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
  },
  { $id: "PassportDeviceItem", additionalProperties: false }
);

export type PassportDeviceItem = Static<typeof PassportDeviceItemSchema>;

export const PassportDeviceResponseSchema = Type.Object(
  {
    data: PassportDeviceItemSchema,
  },
  { $id: "PassportDeviceResponse", additionalProperties: false }
);

export type PassportDeviceResponse = Static<typeof PassportDeviceResponseSchema>;

export const PassportDeviceListResponseSchema = PaginatedEnvelope(PassportDeviceItemSchema, {
  $id: "PassportDeviceListResponse",
});

export type PassportDeviceListResponse = Static<typeof PassportDeviceListResponseSchema>;

export const RevokePassportDeviceResponseSchema = SuccessStatusResponseSchema;
export type RevokePassportDeviceResponse = Static<typeof RevokePassportDeviceResponseSchema>;

// ==========================================
// 4. Passport Card Projection
// ==========================================

export const PassportCardFieldSchema = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: 50 }),
    value: Type.String({ maxLength: 200 }),
    unit: Type.Optional(Type.String({ maxLength: 20 })),
    emphasis: Type.Optional(Type.Boolean()),
  },
  { $id: "PassportCardField", additionalProperties: false }
);

export type PassportCardField = Static<typeof PassportCardFieldSchema>;

export const PassportCardSchema = Type.Object(
  {
    schemaVersion: Type.Integer({ minimum: 1, maximum: 1 }),
    kind: Type.Literal("record_proposal"),
    entityType: Type.String({ minLength: 1, maxLength: 50 }),
    title: Type.String({ minLength: 1, maxLength: 50 }),
    status: Type.Union([
      Type.Literal("awaiting_confirmation"),
      Type.Literal("confirmed"),
      Type.Literal("superseded"),
      Type.Literal("expired"),
    ]),
    fields: Type.Array(PassportCardFieldSchema, { maxItems: 10 }),
    footer: Type.Optional(Type.String({ maxLength: 50 })),
  },
  { $id: "PassportCard", additionalProperties: false }
);

export type PassportCard = Static<typeof PassportCardSchema>;

export const PassportConfirmationMetaSchema = Type.Object(
  {
    planHash: Type.String({ minLength: 1 }),
    actionIds: Type.Array(UuidString, { minItems: 1 }),
    expiresAt: DateTimeString,
  },
  { $id: "PassportConfirmationMeta", additionalProperties: false }
);

export type PassportConfirmationMeta = Static<typeof PassportConfirmationMetaSchema>;

export const PresentPassportCardEventSchema = Type.Object(
  {
    v: Type.Literal(1),
    type: Type.Literal("card.present"),
    runId: UuidString,
    card: PassportCardSchema,
    confirmation: PassportConfirmationMetaSchema,
  },
  { $id: "PresentPassportCardEvent", additionalProperties: false }
);

export type PresentPassportCardEvent = Static<typeof PresentPassportCardEventSchema>;

const ApiErrorRef = Type.Ref(ApiErrorEnvelopeSchema);

export const PASSPORT_ROUTE_DEFINITIONS: RouteDefinition[] = [
  {
    method: "POST",
    path: "/api/v1/passport/pairings",
    operationId: "createPassportPairing",
    summary: "Request a new pairing code from Passport device",
    tags: ["Passport"],
    implementationStatus: "READY_PASSPORT",
    body: CreatePassportPairingRequestSchema,
    responses: { 201: CreatePassportPairingResponseSchema, 400: ApiErrorRef },
  },
  {
    method: "POST",
    path: "/api/v1/passport/pairings/claim",
    operationId: "claimPassportPairing",
    summary: "Claim a pairing code by authenticated user for a family and baby",
    tags: ["Passport"],
    implementationStatus: "READY_PASSPORT",
    body: ClaimPassportPairingRequestSchema,
    responses: {
      200: ClaimPassportPairingResponseSchema,
      400: ApiErrorRef,
      401: ApiErrorRef,
      403: ApiErrorRef,
      404: ApiErrorRef,
      409: ApiErrorRef,
    },
  },
  {
    method: "POST",
    path: "/api/v1/passport/pairings/{id}/poll",
    operationId: "pollPassportPairing",
    summary: "Poll pairing completion status by Passport device",
    tags: ["Passport"],
    implementationStatus: "READY_PASSPORT",
    params: Type.Object({ id: UuidString }),
    body: PollPassportPairingRequestSchema,
    responses: { 200: PollPassportPairingResponseSchema, 400: ApiErrorRef, 404: ApiErrorRef },
  },
  {
    method: "POST",
    path: "/api/v1/passport/auth/token",
    operationId: "exchangePassportAuthToken",
    summary: "Exchange device credential for short-lived Passport JWT",
    tags: ["Passport"],
    implementationStatus: "READY_PASSPORT",
    body: PassportAuthTokenRequestSchema,
    responses: { 200: PassportAuthTokenResponseSchema, 400: ApiErrorRef, 401: ApiErrorRef },
  },
  {
    method: "GET",
    path: "/api/v1/passport/devices",
    operationId: "listPassportDevices",
    summary: "List passport devices owned by user",
    tags: ["Passport"],
    implementationStatus: "READY_PASSPORT",
    querystring: PaginationQuerySchema,
    responses: { 200: PassportDeviceListResponseSchema, 401: ApiErrorRef },
  },
  {
    method: "GET",
    path: "/api/v1/passport/devices/{id}",
    operationId: "getPassportDevice",
    summary: "Get passport device details",
    tags: ["Passport"],
    implementationStatus: "READY_PASSPORT",
    params: Type.Object({ id: UuidString }),
    responses: { 200: PassportDeviceResponseSchema, 401: ApiErrorRef, 404: ApiErrorRef },
  },
  {
    method: "DELETE",
    path: "/api/v1/passport/devices/{id}",
    operationId: "revokePassportDevice",
    summary: "Revoke passport device",
    tags: ["Passport"],
    implementationStatus: "READY_PASSPORT",
    params: Type.Object({ id: UuidString }),
    responses: { 200: RevokePassportDeviceResponseSchema, 401: ApiErrorRef, 404: ApiErrorRef },
  },
  {
    method: "GET",
    path: "/api/v1/passport/ws",
    operationId: "connectPassportWebSocket",
    summary: "WebSocket voice gateway for Passport device (Upgrade: websocket)",
    tags: ["Passport"],
    implementationStatus: "READY_PASSPORT",
    responses: {
      101: Type.Object({}, { additionalProperties: true, description: "WebSocket switching protocols" }),
      400: ApiErrorRef,
      401: ApiErrorRef,
    },
  },
];
