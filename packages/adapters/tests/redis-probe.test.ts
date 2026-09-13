import assert from "node:assert/strict";
import { test } from "node:test";
import { createRedisProbe, type RedisProbeClient } from "../src/redis-probe.js";

function fakeClient(overrides: Partial<RedisProbeClient> = {}): RedisProbeClient {
  return {
    status: "wait",
    async connect() {},
    async ping() { return "PONG"; },
    disconnect() {},
    ...overrides,
  };
}

const validUrl = "redis://default:test_password@127.0.0.1:56379/1";

test("Redis probe runs PING and disconnects the client", async () => {
  const calls: string[] = [];
  let disconnected = 0;
  const probe = createRedisProbe(validUrl, {
    createClient: () => fakeClient({
      async connect() { calls.push("connect"); },
      async ping() { calls.push("PING"); return "PONG"; },
      disconnect() { disconnected += 1; },
    }),
  });

  assert.equal(await probe.check(), true);
  assert.deepEqual(calls, ["connect", "PING"]);
  assert.equal(disconnected, 1);
  await probe.close();
});

test("Redis probe fails closed for missing configuration", async () => {
  const probe = createRedisProbe(undefined);
  assert.equal(await probe.check(), false);
  await probe.close();
});

test("Redis probe bounds a hung ping and disconnects", async () => {
  let disconnected = 0;
  const probe = createRedisProbe(validUrl, {
    timeoutMs: 10,
    createClient: () => fakeClient({
      async ping() { await new Promise<string>(() => {}); return "PONG"; },
      disconnect() { disconnected += 1; },
    }),
  });

  const started = Date.now();
  assert.equal(await probe.check(), false);
  assert.ok(Date.now() - started < 500);
  assert.equal(disconnected, 1);
  await probe.close();
});

test("Redis probe single-flights concurrent checks and closes in-flight clients", async () => {
  let pingCalls = 0;
  let disconnected = 0;
  let releasePing!: () => void;
  const probe = createRedisProbe(validUrl, {
    createClient: () => fakeClient({
      async ping() {
        pingCalls += 1;
        await new Promise<void>((resolve) => { releasePing = resolve; });
        return "PONG";
      },
      disconnect() { disconnected += 1; },
    }),
  });

  const first = probe.check();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = probe.check();
  assert.strictEqual(first, second);
  assert.equal(pingCalls, 1);
  const closing = probe.close();
  releasePing();
  assert.equal(await first, true);
  await closing;
  assert.ok(disconnected >= 1);
  assert.equal(await probe.check(), false);
});
