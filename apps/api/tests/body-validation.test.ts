import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@sinclair/typebox";
import { Nullable } from "@growdesk/contracts";
import { buildApiApp } from "../src/app.js";

test("body validation preserves nullable JSON values without coercion", async () => {
  const app = buildApiApp();
  app.post(
    "/test/body-validation",
    {
      schema: {
        body: Type.Object(
          {
            text: Nullable(Type.String()),
            count: Nullable(Type.Integer()),
            enabled: Nullable(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request) => request.body,
  );

  try {
    const nullResponse = await app.inject({
      method: "POST",
      url: "/test/body-validation",
      payload: { text: null, count: null, enabled: null },
    });
    assert.equal(nullResponse.statusCode, 200);
    assert.deepEqual(nullResponse.json(), { text: null, count: null, enabled: null });

    const exactPrimitiveResponse = await app.inject({
      method: "POST",
      url: "/test/body-validation",
      payload: { text: "", count: 0, enabled: false },
    });
    assert.equal(exactPrimitiveResponse.statusCode, 200);
    assert.deepEqual(exactPrimitiveResponse.json(), { text: "", count: 0, enabled: false });

    for (const payload of [
      { text: 0, count: null, enabled: null },
      { text: false, count: null, enabled: null },
      { text: null, count: false, enabled: null },
      { text: null, count: null, enabled: 0 },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/test/body-validation",
        payload,
      });
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
    }
  } finally {
    await app.close();
  }
});

test("query validation retains Fastify's default scalar coercion", async () => {
  const app = buildApiApp();
  app.get(
    "/test/query-validation",
    {
      schema: {
        querystring: Type.Object({ limit: Type.Integer({ minimum: 1 }) }),
      },
    },
    async (request) => ({ limit: request.query.limit, type: typeof request.query.limit }),
  );

  try {
    const response = await app.inject({ method: "GET", url: "/test/query-validation?limit=2" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { limit: 2, type: "number" });
  } finally {
    await app.close();
  }
});
