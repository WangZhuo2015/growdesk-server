import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BffSessionExchangeRequestSchema } from "@growdesk/contracts";
import { Value } from "@sinclair/typebox/value";

test("BFF legacy exchange source preserves the already published optional credential schema", () => {
  const spec = JSON.parse(readFileSync(new URL("../../contracts/openapi.json", import.meta.url), "utf8"));
  const published = spec.paths["/api/v1/auth/bff/session"].post.requestBody.content["application/json"].schema;
  const source = JSON.parse(JSON.stringify(BffSessionExchangeRequestSchema));
  const expected = published.properties.legacyAuthToken;
  assert.ok(expected, "the published Go migration contract must retain the credential field");
  // Print schema metadata only, never a real token or request body. This keeps
  // an omitted-field failure readable even when the full OpenAPI is very large.
  console.info("BFF_LEGACY_SCHEMA", JSON.stringify({ field: expected, propertyOrder: Object.keys(published.properties) }));
  assert.deepEqual(source.properties.legacyAuthToken, expected);
  assert.deepEqual(Object.keys(source.properties), Object.keys(published.properties));
  assert.deepEqual(source.required, published.required);
  assert.ok(!published.required.includes("legacyAuthToken"), "normal session exchange must not require a legacy token");
  const body = { sessionSecretHash: "a".repeat(64) };
  assert.equal(Value.Check(BffSessionExchangeRequestSchema, body), true);
  assert.equal(Value.Check(BffSessionExchangeRequestSchema, { ...body, legacyAuthToken: "test_legacy_token" }), true);
  for (const legacyAuthToken of [null, 42, false, {}, []]) {
    assert.equal(Value.Check(BffSessionExchangeRequestSchema, { ...body, legacyAuthToken }), false);
  }
});
