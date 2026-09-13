import assert from "node:assert/strict";
import { test } from "node:test";
import { createPostgresProbe, type PostgresProbeClient } from "../src/postgres-probe.js";

function fakeClient(overrides: Partial<PostgresProbeClient> = {}): PostgresProbeClient {
  return {
    async connect() {},
    async query() {},
    async end() {},
    ...overrides,
  };
}

const validUrl = "postgresql://test_user:test_password@127.0.0.1:55432/test_database";

test("PostgreSQL probe runs SELECT 1 and closes the client", async () => {
  const calls: string[] = [];
  let ended = 0;
  const probe = createPostgresProbe(validUrl, {
    createClient: () => fakeClient({
      async connect() { calls.push("connect"); },
      async query(text) { calls.push(text); },
      async end() { ended += 1; },
    }),
  });

  assert.equal(await probe.check(), true);
  assert.deepEqual(calls, ["connect", "SELECT 1"]);
  assert.equal(ended, 1);
  await probe.close();
});

test("PostgreSQL probe fails closed for missing configuration", async () => {
  const probe = createPostgresProbe(undefined);
  assert.equal(await probe.check(), false);
  await probe.close();
});

test("PostgreSQL probe bounds a hung query and still closes", async () => {
  let ended = 0;
  const probe = createPostgresProbe(validUrl, {
    timeoutMs: 10,
    createClient: () => fakeClient({
      async query() { await new Promise<void>(() => {}); },
      async end() { ended += 1; },
    }),
  });

  const started = Date.now();
  assert.equal(await probe.check(), false);
  assert.ok(Date.now() - started < 500);
  assert.equal(ended, 1);
  await probe.close();
});

test("PostgreSQL probe single-flights concurrent checks and waits on close", async () => {
  let queryCalls = 0;
  let ended = 0;
  let releaseQuery!: () => void;
  const probe = createPostgresProbe(validUrl, {
    createClient: () => fakeClient({
      async query() {
        queryCalls += 1;
        await new Promise<void>((resolve) => { releaseQuery = resolve; });
      },
      async end() { ended += 1; },
    }),
  });

  const first = probe.check();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = probe.check();
  assert.strictEqual(first, second);
  assert.equal(queryCalls, 1);
  const closing = probe.close();
  releaseQuery();
  assert.equal(await first, true);
  await closing;
  assert.equal(ended, 1);
  assert.equal(await probe.check(), false);
});
