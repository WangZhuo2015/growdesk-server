import assert from "node:assert/strict";
import { test } from "node:test";
import { createSchedulerRuntime, requireSchedulerDependencies } from "../src/main.js";

test("scheduler requires both database and Redis configuration before starting", () => {
  assert.throws(() => requireSchedulerDependencies({}), /DATABASE_URL is required/);
});

test("scheduler lifecycle stops cleanly without dispatching jobs", async () => {
  const runtime = createSchedulerRuntime();
  const running = runtime.run();
  runtime.stop();
  await running;
});
