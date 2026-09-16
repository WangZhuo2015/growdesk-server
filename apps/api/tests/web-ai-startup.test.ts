import assert from "node:assert/strict";
import test from "node:test";
import { buildApiApp } from "../src/app.js";
import { ROUTE_DEFINITIONS, WEB_AI_ROUTE_DEFINITIONS } from "@growdesk/contracts";

test("Web AI contracts do not cause duplicate schema registration on repeated startup", async () => {
  for (let instance = 0; instance < 2; instance += 1) {
    const app = buildApiApp();
    try {
      await app.ready();
      assert.equal((await app.inject({ method: "GET", url: "/health/live" })).statusCode, 200);
      // Business endpoints must not mount without an explicitly configured DB.
      assert.equal((await app.inject({ method: "GET", url: "/api/v1/web/ai/sessions" })).statusCode, 404);
    } finally { await app.close(); }
  }
});

test("all six Web AI operations are exported exactly once in the canonical contract", () => {
  assert.equal(WEB_AI_ROUTE_DEFINITIONS.length, 6);
  for (const route of WEB_AI_ROUTE_DEFINITIONS) {
    const matches = ROUTE_DEFINITIONS.filter(item => item.operationId === route.operationId);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.path, route.path);
    assert.equal(matches[0]!.method, route.method);
  }
});
