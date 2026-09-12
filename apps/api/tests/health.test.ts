import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApiApp } from "../src/app.js";
import type { ReadinessDependencies } from "../src/readiness.js";

test("health liveness is a real Fastify route", async () => {
  const app = buildApiApp();
  try {
    const response = await app.inject({ method: "GET", url: "/health/live" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      status: "ok",
      service: "growdesk-api",
    });
  } finally {
    await app.close();
  }
});

test("health route does not expose business endpoints in the baseline", async () => {
  const app = buildApiApp();
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/families" });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
  }
});

function readiness(postgres: boolean, redis: boolean, onClose?: () => void): ReadinessDependencies {
  return {
    async check() {
      return { postgres, redis };
    },
    async close() {
      onClose?.();
    },
  };
}

test("health readiness is 503 when dependencies are not configured", async () => {
  const app = buildApiApp();
  try {
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), {
      status: "unavailable",
      service: "growdesk-api",
      stage: "foundation",
      dependencies: { postgres: "unavailable", redis: "unavailable" },
    });
  } finally {
    await app.close();
  }
});

test("health readiness is 200 only when both foundation dependencies respond", async () => {
  const app = buildApiApp({ readiness: readiness(true, true) });
  try {
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      status: "ok",
      service: "growdesk-api",
      stage: "foundation",
      dependencies: { postgres: "ok", redis: "ok" },
    });
  } finally {
    await app.close();
  }
});

test("liveness does not call or depend on readiness", async () => {
  let checks = 0;
  const app = buildApiApp({
    readiness: {
      async check() {
        checks += 1;
        throw new Error("dependency failure");
      },
      async close() {},
    },
  });
  try {
    const response = await app.inject({ method: "GET", url: "/health/live" });
    assert.equal(response.statusCode, 200);
    assert.equal(checks, 0);
  } finally {
    await app.close();
  }
});

test("readiness closes its dependency owner with the app", async () => {
  let closed = 0;
  const app = buildApiApp({ readiness: readiness(true, true, () => { closed += 1; }) });
  await app.close();
  assert.equal(closed, 1);
});
