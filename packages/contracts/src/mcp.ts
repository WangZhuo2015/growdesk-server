import { Type, type Static } from "@sinclair/typebox";
import { SuccessStatusResponseSchema } from "./common.js";

// ==========================================
// 1. RFC8414 & OAuth Protected Resource Metadata
// ==========================================

export const OAuthServerMetadataSchema = Type.Object(
  {
    issuer: Type.String(),
    authorization_endpoint: Type.String(),
    token_endpoint: Type.String(),
    revocation_endpoint: Type.String(),
    scopes_supported: Type.Array(Type.String()),
    response_types_supported: Type.Array(Type.String()),
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

export const OAuthTokenRequestSchema = Type.Object(
  {
    grant_type: Type.String(),
    client_id: Type.String(),
    code: Type.Optional(Type.String()),
    redirect_uri: Type.Optional(Type.String()),
    code_verifier: Type.Optional(Type.String()),
    refresh_token: Type.Optional(Type.String()),
  },
  { $id: "OAuthTokenRequest", additionalProperties: false }
);

export type OAuthTokenRequest = Static<typeof OAuthTokenRequestSchema>;

export const OAuthTokenResponseSchema = Type.Object(
  {
    access_token: Type.String(),
    token_type: Type.Literal("Bearer"),
    expires_in: Type.Integer(),
    refresh_token: Type.Optional(Type.String()),
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
