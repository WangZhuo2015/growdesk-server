import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDatabaseConfig } from "../src/config.js";

const valid = "postgresql://test_runner:test_password@127.0.0.1:55432/test_growdesk_boot02?sslmode=disable";

test("database guard accepts an owned PostgreSQL test URL without connecting", () => {
  const config = parseDatabaseConfig(valid, "test");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 55432);
  assert.equal(config.database, "test_growdesk_boot02");
  assert.equal(config.username, "test_runner");
});

for (const [name, value] of Object.entries({
  sqlite: "file:./prod.db",
  productionHost: valid.replace("127.0.0.1", "database.production.invalid"),
  unknownHost: valid.replace("127.0.0.1", "localhost"),
  productionDatabase: valid.replace("test_growdesk_boot02", "growdesk"),
  wrongRole: valid.replace("test_runner:", "postgres:"),
  defaultPort: valid.replace(":55432/", ":5432/"),
  driverOverride: `${valid}&host=database.production.invalid`,
  strictTls: valid.replace("sslmode=disable", "sslmode=require"),
})) {
  test(`database guard rejects ${name} before a connection`, () => {
    assert.throws(() => parseDatabaseConfig(value, "test"), (error: Error) => {
      assert.match(error.message, /^Database configuration rejected:/);
      assert.doesNotMatch(error.message, /test_password/);
      return true;
    });
  });
}
