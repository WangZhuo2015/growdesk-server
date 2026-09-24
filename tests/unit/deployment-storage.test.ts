import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const compose = readFileSync(new URL("../../deploy/compose.yaml", import.meta.url), "utf8");

test("production compose keeps attachment storage private and digest pinned", () => {
  assert.match(compose, /quay\.io\/minio\/minio@sha256:[0-9a-f]{64}/);
  assert.match(compose, /quay\.io\/minio\/mc@sha256:[0-9a-f]{64}/);
  assert.match(compose, /S3_ENDPOINT: "http:\/\/storage:9000"/);
  assert.match(compose, /growdesk-storage:\n\s+name: growdesk-storage\n\s+internal: true/);
  assert.doesNotMatch(compose, /["']?9000:9000/);
  assert.match(compose, /storage-init:\n\s+condition: service_completed_successfully/);
});
