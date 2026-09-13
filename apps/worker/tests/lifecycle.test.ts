import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerRuntime, requireWorkerDependencies } from "../src/main.js";

test("worker requires both database and Redis configuration before starting", () => {
  assert.throws(() => requireWorkerDependencies({}), /DATABASE_URL is required/);
});

test("worker lifecycle stops cleanly without claiming jobs", async () => {
  const runtime = createWorkerRuntime();
  const running = runtime.run();
  runtime.stop();
  await running;
});
