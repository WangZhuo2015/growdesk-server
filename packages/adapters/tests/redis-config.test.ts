import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRedisConfig } from "../src/redis-config.js";

const valid = "redis://:test_password@127.0.0.1:56379/0";

test("Redis guard accepts an isolated loopback test URL without connecting", () => {
  const config = parseRedisConfig(valid, "test");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 56379);
  assert.equal(config.database, 0);
});

test("runtime Redis supports an explicitly configured ACL user", () => {
  const config = parseRedisConfig("redis://worker:test_password@redis.internal:6379/2", "runtime");
  assert.equal(config.username, "worker");
});

for (const [name, value] of Object.entries({
  remoteHost: valid.replace("127.0.0.1", "redis.production.invalid"),
  defaultPort: valid.replace(":56379/", ":6379/"),
  noPassword: "redis://127.0.0.1:56379/0",
  query: `${valid}?host=redis.production.invalid`,
})) {
  test(`Redis guard rejects ${name} before a connection`, () => {
    assert.throws(() => parseRedisConfig(value, "test"), (error: Error) => {
      assert.match(error.message, /^Redis configuration rejected:/);
      assert.doesNotMatch(error.message, /test_password/);
      return true;
    });
  });
}
