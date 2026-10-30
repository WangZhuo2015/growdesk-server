import assert from "node:assert/strict";
import { test } from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeJwt, SignJWT } from "jose";
import { buildApiApp } from "../../apps/api/src/app.js";
import { createDatabaseContext } from "../../packages/database/src/client.js";
import { requireTestDatabaseUrl } from "../../packages/testkit/src/environment.js";
import type { LlmPreferenceSelection } from "../../packages/contracts/src/llm-preferences.js";

interface OwnedRun {
  directory: string;
  token: string;
  database: string;
  user: string;
  password: string;
  pgPort: number;
  redisPort: number;
}

function readRun(): OwnedRun {
  const file = process.env.BOOT02_RUN_FILE;
  if (!file) throw new Error("Integration tests require the managed test runner");
  const real = fs.realpathSync(file);
  const parent = path.dirname(real);
  if (path.dirname(parent) !== fs.realpathSync(os.tmpdir()) || !path.basename(parent).startsWith("growdesk-integration-")) {
    throw new Error("Integration manifest is outside its private run");
  }
  const stat = fs.statSync(real);
  if (stat.uid !== process.getuid?.() || stat.mode & 0o077) throw new Error("Unsafe manifest permissions");
  const run = JSON.parse(fs.readFileSync(real, "utf8")) as OwnedRun;
  if (run.directory !== parent || run.database !== "test_growdesk_integration" || run.user !== "test_runner" ||
      !/^[a-f0-9]{32}$/.test(run.token) || !/^[a-f0-9]{48}$/.test(run.password) ||
      !Number.isInteger(run.pgPort) || run.pgPort < 1025 || run.pgPort > 65535 ||
      !Number.isInteger(run.redisPort) || run.redisPort < 1025 || run.redisPort > 65535 || run.redisPort === 6379) {
    throw new Error("Invalid isolated integration identity");
  }
  return run;
}

test("SH-LLM-PREFERENCES: authenticated per-user selections persist in isolated PostgreSQL", async (t) => {
  const run = readRun();
  const jwtSecret = "test_integration_jwt_secret_min_32_chars_2026";
  const url = requireTestDatabaseUrl(
    `postgresql://${run.user}:${run.password}@127.0.0.1:${run.pgPort}/${run.database}?sslmode=disable`,
    { host: "127.0.0.1", port: run.pgPort, database: run.database, role: run.user, password: run.password },
  );
  let context = createDatabaseContext({ url });
  let app = buildApiApp({ databaseContext: context, jwtSecret });
  t.after(async () => {
    await app.close();
    await context.close();
  });

  const anonymousGet = await app.inject({ method: "GET", url: "/api/v1/web/ai/preferences" });
  assert.equal(anonymousGet.statusCode, 401);
  const anonymousPut = await app.inject({
    method: "PUT",
    url: "/api/v1/web/ai/preferences",
    payload: { feature: "chat", source: "api", profileId: "test_profile", modelId: "test_model" },
  });
  assert.equal(anonymousPut.statusCode, 401);

  const stamp = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  async function register(label: "a" | "b") {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: `test_llm_preferences_${label}_${stamp}`,
        password: "test_password_llm_preferences_2026",
        displayName: `test_llm_preferences_${label}_${stamp}`,
        deviceLabel: "test_integration",
      },
    });
    assert.equal(response.statusCode, 201, response.payload);
    return response.json<{ data: { accessToken: string; user: { id: string } } }>().data;
  }
  const userA = await register("a");
  const userB = await register("b");

  async function get(token: string) {
    return app.inject({ method: "GET", url: "/api/v1/web/ai/preferences", headers: { authorization: `Bearer ${token}` } });
  }
  async function put(token: string, value: LlmPreferenceSelection) {
    return app.inject({
      method: "PUT",
      url: "/api/v1/web/ai/preferences",
      headers: { authorization: `Bearer ${token}` },
      payload: value,
    });
  }

  const empty = await get(userA.accessToken);
  assert.equal(empty.statusCode, 200, empty.payload);
  assert.deepEqual(empty.json(), { data: { preferences: [] } });

  const chat: LlmPreferenceSelection = { feature: "chat", source: "api", profileId: "test_profile_a", modelId: "test_model_a" };
  const savedChat = await put(userA.accessToken, chat);
  assert.equal(savedChat.statusCode, 200, savedChat.payload);
  assert.deepEqual(savedChat.json(), { data: chat });

  const overwrite: LlmPreferenceSelection = { ...chat, source: "chatgpt", profileId: "test_profile_b", modelId: "test_model_b" };
  const updatedChat = await put(userA.accessToken, overwrite);
  assert.equal(updatedChat.statusCode, 200, updatedChat.payload);
  assert.deepEqual(updatedChat.json(), { data: overwrite });

  const concurrent: LlmPreferenceSelection[] = [
    { feature: "tips", source: "api", profileId: "test_tips_profile", modelId: "test_tips_model" },
    { feature: "voice", source: "chatgpt", profileId: "test_voice_profile", modelId: "test_voice_model" },
  ];
  const concurrentResults = await Promise.all(concurrent.map(value => put(userA.accessToken, value)));
  for (const response of concurrentResults) assert.equal(response.statusCode, 200, response.payload);

  const userAList = await get(userA.accessToken);
  assert.equal(userAList.statusCode, 200, userAList.payload);
  const userAPreferences = userAList.json<{ data: { preferences: LlmPreferenceSelection[] } }>().data.preferences;
  assert.deepEqual(userAPreferences, [overwrite, ...concurrent].sort((left, right) => left.feature.localeCompare(right.feature)));
  assert.deepEqual(Object.keys(userAPreferences[0]!).sort(), ["feature", "modelId", "profileId", "source"]);

  const outsiderEmpty = await get(userB.accessToken);
  assert.equal(outsiderEmpty.statusCode, 200, outsiderEmpty.payload);
  assert.deepEqual(outsiderEmpty.json(), { data: { preferences: [] } });
  const userBChat: LlmPreferenceSelection = { feature: "chat", source: "api", profileId: "test_profile_b_user", modelId: "test_model_b_user" };
  const userBWrite = await put(userB.accessToken, userBChat);
  assert.equal(userBWrite.statusCode, 200, userBWrite.payload);
  assert.deepEqual(
    (await get(userB.accessToken)).json<{ data: { preferences: LlmPreferenceSelection[] } }>().data.preferences,
    [userBChat],
  );
  assert.deepEqual(
    (await get(userA.accessToken)).json<{ data: { preferences: LlmPreferenceSelection[] } }>().data.preferences,
    [overwrite, ...concurrent].sort((left, right) => left.feature.localeCompare(right.feature)),
  );

  const invalidOwner = await app.inject({
    method: "PUT",
    url: "/api/v1/web/ai/preferences",
    headers: { authorization: `Bearer ${userA.accessToken}` },
    payload: { ...chat, userId: userB.user.id },
  });
  assert.equal(invalidOwner.statusCode, 400);
  const invalidCredentialInput = await app.inject({
    method: "PUT",
    url: "/api/v1/web/ai/preferences",
    headers: { authorization: `Bearer ${userA.accessToken}` },
    payload: {
      ...chat,
      apiKey: "test_secret_must_not_be_accepted",
      baseUrl: "https://invalid.test",
      headers: { authorization: "test_secret_must_not_be_accepted" },
    },
  });
  assert.equal(invalidCredentialInput.statusCode, 400);
  const invalidLength = await put(userA.accessToken, { ...chat, profileId: "" });
  assert.equal(invalidLength.statusCode, 400);

  const claims = decodeJwt(userA.accessToken);
  const mcpToken = await new SignJWT({ scope: "ai:read", sid: claims.sid })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("growdesk-api")
    .setAudience("http://127.0.0.1/mcp")
    .setSubject(userA.user.id)
    .setIssuedAt()
    .setExpirationTime("5m")
    .setJti(crypto.randomUUID())
    .sign(new TextEncoder().encode(jwtSecret));
  const mcpRead = await app.inject({ method: "GET", url: "/api/v1/web/ai/preferences", headers: { authorization: `Bearer ${mcpToken}` } });
  assert.equal(mcpRead.statusCode, 401);
  const mcpWrite = await app.inject({
    method: "PUT",
    url: "/api/v1/web/ai/preferences",
    headers: { authorization: `Bearer ${mcpToken}` },
    payload: { ...chat, feature: "search" },
  });
  assert.equal(mcpWrite.statusCode, 401);

  const countBeforeRestart = await context.pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM llm_preferences WHERE user_id = $1",
    [userA.user.id],
  );
  assert.equal(countBeforeRestart.rows[0]?.count, 3);
  await app.close();
  await context.close();
  context = createDatabaseContext({ url });
  app = buildApiApp({ databaseContext: context, jwtSecret });
  const afterRestart = await get(userA.accessToken);
  assert.equal(afterRestart.statusCode, 200, afterRestart.payload);
  assert.deepEqual(
    afterRestart.json<{ data: { preferences: LlmPreferenceSelection[] } }>().data.preferences,
    [overwrite, ...concurrent].sort((left, right) => left.feature.localeCompare(right.feature)),
  );
});
