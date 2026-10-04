import { Type, type Static } from "@sinclair/typebox";
import { DateTimeString, Nullable, SuccessStatusResponseSchema, UuidString } from "./common.js";

// ==========================================
// 1. RFC8414 & OAuth Protected Resource Metadata
// ==========================================

export const OAuthServerMetadataSchema = Type.Object(
  {
    issuer: Type.String(),
    authorization_endpoint: Type.String(),
    registration_endpoint: Type.String(),
    token_endpoint: Type.String(),
    revocation_endpoint: Type.String(),
    scopes_supported: Type.Array(Type.String()),
    response_types_supported: Type.Array(Type.String()),
    grant_types_supported: Type.Array(Type.String()),
    token_endpoint_auth_methods_supported: Type.Array(Type.String()),
    code_challenge_methods_supported: Type.Array(Type.String()),
  },
  { $id: "OAuthServerMetadata", additionalProperties: false }
);

export type OAuthServerMetadata = Static<typeof OAuthServerMetadataSchema>;

export const OAuthProtectedResourceMetadataSchema = Type.Object(
  {
    resource: Type.String(),
    authorization_servers: Type.Array(Type.String()),
    scopes_supported: Type.Array(Type.String()),
    bearer_methods_supported: Type.Array(Type.String()),
  },
  { $id: "OAuthProtectedResourceMetadata", additionalProperties: false }
);

export type OAuthProtectedResourceMetadata = Static<typeof OAuthProtectedResourceMetadataSchema>;

export const OAuthErrorResponseSchema = Type.Object(
  {
    error: Type.String(),
    error_description: Type.Optional(Type.String()),
  },
  { $id: "OAuthErrorResponse", additionalProperties: false },
);
export type OAuthErrorResponse = Static<typeof OAuthErrorResponseSchema>;

export const OAuthClientRegistrationRequestSchema = Type.Object(
  {
    client_name: Type.String({ minLength: 1, maxLength: 200 }),
    redirect_uris: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { minItems: 1, maxItems: 10 }),
    scope: Type.Optional(Type.String({ maxLength: 200 })),
    grant_types: Type.Optional(Type.Array(Type.String(), { maxItems: 2 })),
    response_types: Type.Optional(Type.Array(Type.String(), { maxItems: 1 })),
    token_endpoint_auth_method: Type.Optional(Type.String()),
  },
  { $id: "OAuthClientRegistrationRequest", additionalProperties: false },
);
export type OAuthClientRegistrationRequest = Static<typeof OAuthClientRegistrationRequestSchema>;

export const OAuthClientRegistrationResponseSchema = Type.Object(
  {
    client_id: Type.String({ minLength: 1, maxLength: 128 }),
    client_id_issued_at: Type.Integer(),
    client_name: Type.String(),
    redirect_uris: Type.Array(Type.String()),
    scope: Type.String(),
    grant_types: Type.Array(Type.String()),
    response_types: Type.Array(Type.String()),
    token_endpoint_auth_method: Type.Literal("none"),
  },
  { $id: "OAuthClientRegistrationResponse", additionalProperties: false },
);
export type OAuthClientRegistrationResponse = Static<typeof OAuthClientRegistrationResponseSchema>;

export const OAuthAuthorizationQuerySchema = Type.Object(
  {
    response_type: Type.Literal("code"),
    client_id: Type.String({ minLength: 1, maxLength: 128 }),
    redirect_uri: Type.String({ minLength: 1, maxLength: 2048 }),
    scope: Type.Optional(Type.String({ maxLength: 200 })),
    state: Type.Optional(Type.String({ maxLength: 512 })),
    code_challenge: Type.String({ minLength: 43, maxLength: 43 }),
    code_challenge_method: Type.Literal("S256"),
    resource: Type.String({ minLength: 1, maxLength: 2048 }),
  },
  { $id: "OAuthAuthorizationQuery", additionalProperties: false },
);
export type OAuthAuthorizationQuery = Static<typeof OAuthAuthorizationQuerySchema>;

export const OAuthAuthorizationFormSchema = Type.Object(
  {
    requestId: UuidString,
    browserSecret: Type.String({ minLength: 43, maxLength: 43 }),
    decision: Type.Union([Type.Literal("login"), Type.Literal("allow"), Type.Literal("deny")]),
    username: Type.Optional(Type.String({ maxLength: 100 })),
    password: Type.Optional(Type.String({ maxLength: 256 })),
    babyId: Type.Optional(UuidString),
    scopeSelection: Type.Optional(Type.Literal("true")),
    scope: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String(), { maxItems: 4 })])),
  },
  { $id: "OAuthAuthorizationForm", additionalProperties: false },
);
export type OAuthAuthorizationForm = Static<typeof OAuthAuthorizationFormSchema>;

export const OAuthTokenRequestSchema = Type.Object(
  {
    grant_type: Type.String(),
    client_id: Type.String(),
    code: Type.Optional(Type.String()),
    redirect_uri: Type.Optional(Type.String()),
    code_verifier: Type.Optional(Type.String()),
    refresh_token: Type.Optional(Type.String()),
    resource: Type.Optional(Type.String()),
    scope: Type.Optional(Type.String()),
  },
  { $id: "OAuthTokenRequest", additionalProperties: false }
);

export type OAuthTokenRequest = Static<typeof OAuthTokenRequestSchema>;

export const OAuthTokenResponseSchema = Type.Object(
  {
    access_token: Type.String(),
    token_type: Type.Literal("Bearer"),
    expires_in: Type.Integer(),
    refresh_token: Type.String(),
    scope: Type.String(),
  },
  { $id: "OAuthTokenResponse", additionalProperties: false }
);

export type OAuthTokenResponse = Static<typeof OAuthTokenResponseSchema>;

export const OAuthRevokeTokenRequestSchema = Type.Object(
  {
    token: Type.String(),
    token_type_hint: Type.Optional(Type.String()),
    client_id: Type.String(),
  },
  { $id: "OAuthRevokeTokenRequest", additionalProperties: false }
);

export type OAuthRevokeTokenRequest = Static<typeof OAuthRevokeTokenRequestSchema>;

export const OAuthRevokeTokenResponseSchema = SuccessStatusResponseSchema;
export type OAuthRevokeTokenResponse = Static<typeof OAuthRevokeTokenResponseSchema>;

export const OAuthConnectionSummarySchema = Type.Object(
  {
    id: UuidString,
    clientId: Type.String({ minLength: 1, maxLength: 128 }),
    clientName: Type.String({ minLength: 1, maxLength: 200 }),
    resource: Type.String({ minLength: 1, maxLength: 2048 }),
    scopes: Type.Array(Type.String(), { minItems: 1, maxItems: 4 }),
    familyId: UuidString,
    babyId: UuidString,
    createdAt: DateTimeString,
    expiresAt: Type.Optional(DateTimeString),
    lastUsedAt: Nullable(DateTimeString),
    revokedAt: Nullable(DateTimeString),
  },
  { $id: "OAuthConnectionSummary", additionalProperties: false },
);
export type OAuthConnectionSummary = Static<typeof OAuthConnectionSummarySchema>;

export const OAuthConnectionListResponseSchema = Type.Object(
  {
    data: Type.Array(OAuthConnectionSummarySchema, { maxItems: 100 }),
    managementAvailable: Type.Literal(true),
  },
  { $id: "OAuthConnectionListResponse", additionalProperties: false },
);
export type OAuthConnectionListResponse = Static<typeof OAuthConnectionListResponseSchema>;

// ==========================================
// 2. MCP JSON-RPC 2.0
// ==========================================

export const McpRpcRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    id: Type.Union([Type.String(), Type.Integer()]),
    method: Type.String(),
    params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { $id: "McpRpcRequest", additionalProperties: false }
);

export type McpRpcRequest = Static<typeof McpRpcRequestSchema>;

export const McpRpcResponseSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    id: Type.Union([Type.String(), Type.Integer()]),
    result: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    error: Type.Optional(
      Type.Object(
        {
          code: Type.Integer(),
          message: Type.String(),
          data: Type.Optional(Type.Unknown()),
        },
        { additionalProperties: false }
      )
    ),
  },
  { $id: "McpRpcResponse", additionalProperties: false }
);

export type McpRpcResponse = Static<typeof McpRpcResponseSchema>;
