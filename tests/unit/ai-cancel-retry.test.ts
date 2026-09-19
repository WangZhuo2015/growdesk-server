import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(relative: string, mocks: Record<string, unknown>) {
  const source = fs.readFileSync(new URL(relative, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as any };
  vm.runInNewContext(code, { module, exports: module.exports, Date, require: (id: string) => {
    if (id in mocks) return mocks[id];
    if (id.startsWith("node:")) return require(id);
    throw new Error(`Unmocked import ${id}`);
  } });
  return module.exports;
}
const { TaskExecutionRepository } = load("../../packages/database/src/task-repository.ts", {
  "./generated/client.js": { Prisma: { JsonNull: null } }, "./errors.js": {},
});
const { AiService } = load("../../apps/api/src/services/ai-service.ts", {
  "@growdesk/database": { Prisma: { JsonNull: null }, TaskExecutionRepository, RecordNotFoundError: Error, ConcurrencyConflictError: Error },
  "./feeding-service.js": {}, "@growdesk/contracts": {},
});

test("A3 reconcile terminates unclaimed cancellations before recovery or max-attempt failure", async () => {
  const queries: string[] = [];
  await TaskExecutionRepository.reconcile({ query: async (sql: string) => { queries.push(sql); return { rows: [], rowCount: 0 }; } });
  const cancellation = queries.find(sql => /SET\s+status = 'cancelled'/s.test(sql));
  assert.ok(cancellation, "reconcile must issue a cancelled transition for tasks with cancel_requested_at");
  assert.equal(queries[0], cancellation, "cancellation must win over lease recovery / max attempts");
  assert.match(cancellation, /cancel_requested_at IS NOT NULL/);
  assert.match(cancellation, /status NOT IN \('succeeded', 'failed', 'cancelled'\)/);
  assert.match(cancellation, /status <> 'running'/, "queued and awaiting-confirmation tasks have no running claim");
  assert.match(cancellation, /lease_owner IS NULL/);
  assert.match(cancellation, /lease_expires_at IS NULL/);
  assert.match(cancellation, /lease_expires_at <= CURRENT_TIMESTAMP/, "expired claims must not strand a cancellation");
  assert.match(cancellation, /lease_owner = NULL/);
  assert.match(cancellation, /lease_expires_at = NULL/);
});

for (const status of ["cancelled", "failed"]) {
  test(`A3 retry ${status} task clears the cancellation marker before dispatch`, async () => {
    const marker = new Date("2026-09-17T00:00:00Z");
    const task: any = { status, attempt: 1, cancelRequestedAt: marker };
    let dispatched = false;
    const tx = {
      taskExecution: { update: async ({ data }: any) => { Object.assign(task, data); } },
      taskOutbox: { create: async ({ data }: any) => {
        assert.equal(task.cancelRequestedAt, null, "retry must clear cancellation or claimTask will refuse the queued run");
        assert.equal(task.status, "queued");
        assert.equal(data.aggregateId, "test_run");
        assert.equal(data.phaseKey, "retry_2");
        dispatched = true;
      } },
    };
    const service = new AiService({ aiRun: { findUnique: async () => ({ userId: "test_user", taskExecution: task }) }, $transaction: async (fn: any) => fn(tx) }, {});
    const result = await service.retryRun({ userId: "test_user" }, "test_run");
    assert.equal(result.data.status, "queued");
    assert.equal(task.attempt, 2);
    assert.equal(task.leaseOwner, null);
    assert.equal(task.leaseExpiresAt, null);
    assert.ok(dispatched);
  });
}

test("A3 cancel keeps ownership checks and records a request without stealing a running lease", async () => {
  const queries: any[] = [];
  const pool = { query: async (sql: string, values: any) => { queries.push({ sql, values }); return { rows: [], rowCount: 1 }; } };
  const service = new AiService({ aiRun: { findUnique: async () => ({ userId: "test_user", taskExecution: { status: "running" } }) } }, pool);
  await assert.rejects(() => service.cancelRun({ userId: "test_other_user" }, "test_run"));
  assert.equal(queries.length, 0);
  await service.cancelRun({ userId: "test_user" }, "test_run");
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /cancel_requested_at = CURRENT_TIMESTAMP/);
  assert.doesNotMatch(queries[0].sql, /lease_owner = NULL/);
});
