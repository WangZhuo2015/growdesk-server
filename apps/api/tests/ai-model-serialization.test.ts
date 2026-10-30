import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import {
  AiMessageListResponseSchema,
  AiModelInfoSchema,
  AiRunResponseSchema,
  AiRunSchema,
} from "@growdesk/contracts";

test("real response serializers resolve nullable model metadata in runs and messages", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  app.addSchema(AiModelInfoSchema);
  app.addSchema(AiRunSchema);
  const llm = { source: "api", provider: "test_provider", model: "test_model", modelBasis: "requested" };
  const run = {
    id: "00000000-0000-4000-8000-000000000001",
    sessionId: "00000000-0000-4000-8000-000000000002",
    userId: "00000000-0000-4000-8000-000000000003",
    babyId: null, status: "queued", attempt: 1, lastEventSeq: "1",
    resultSummary: null, proposedPlan: null, errorCode: null, errorMessage: null,
    createdAt: "2026-10-30T00:00:00.000Z", startedAt: null, finishedAt: null,
  };
  for (const [name, metadata] of [["absent", {}], ["null", { llm: null, asr: null }], ["present", { llm, asr: llm }]] as const) {
    const data = { ...run, ...metadata };
    app.get(`/run/${name}`, { schema: { response: { 200: AiRunResponseSchema } } }, async () => ({ data }));
  }
  const message = {
    id: run.id, sessionId: run.sessionId, role: "assistant", content: "test response",
    attachmentIds: [], createdAt: run.createdAt, llm,
  };
  app.get("/messages", { schema: { response: { 200: AiMessageListResponseSchema } } }, async () => ({ data: [message], page: { nextCursor: null } }));
  for (const [name, metadata] of [["absent", {}], ["null", { llm: null, asr: null }], ["present", { llm, asr: llm }]] as const) {
    const response = await app.inject(`/run/${name}`);
    assert.equal(response.statusCode, 200, response.payload);
    assert.deepEqual(response.json().data, { ...run, ...metadata });
  }
  const messages = await app.inject("/messages");
  assert.equal(messages.statusCode, 200, messages.payload);
  assert.deepEqual(messages.json().data, [message]);
});
