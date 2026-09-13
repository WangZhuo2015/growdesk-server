import test from "node:test";
import assert from "node:assert/strict";
import { readRecordVersion } from "../../apps/api/src/routes/record-version.js";

test("client record version parses strictly within the persisted int32 range", () => {
  assert.equal(readRecordVersion("1"), 1);
  assert.equal(readRecordVersion("2147483647"), 2147483647);
  for (const value of [undefined, null, "", "0", "01", "-1", "1.2", "1e3", "2junk", 2, "2147483648", "9007199254740993"]) {
    assert.throws(() => readRecordVersion(value), { code: "INVALID_BASE_VERSION", statusCode: 400 });
  }
});
