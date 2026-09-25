import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";

type QueryClient = {
  query(sql: string, values?: unknown): Promise<{ rows: unknown[]; rowCount: number }>;
};
type TestPrincipal = { userId: string };
type AiServiceInstance = {
  retryRun(principal: TestPrincipal, id: string): Promise<{ data: { status: string } }>;
  cancelRun(principal: TestPrincipal, id: string): Promise<unknown>;
};

const require = createRequire(import.meta.url);
function load<T>(relative: string, mocks: Record<string, unknown>): T {
  const source = fs.readFileSync(new URL(relative, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(code, { module, exports: module.exports, Date, require: (id: string) => {
    if (id in mocks) return mocks[id];
    if (id.startsWith("node:")) return require(id);
    throw new Error(`Unmocked import ${id}`);
  } });
  // Only the module boundary is asserted; the production implementation runs.
  return module.exports as T;
}
const { TaskExecutionRepository } = load<{
  TaskExecutionRepository: { reconcile(client: QueryClient): Promise<unknown> };
}>("../../packages/database/src/task-repository.ts", {
  "./generated/client.js": { Prisma: { JsonNull: null } }, "./errors.js": {},
});
const { AiService } = load<{
  AiService: new (database: unknown, pool: unknown) => AiServiceInstance;
}>("../../apps/api/src/services/ai-service.ts", {
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
    const task: Record<string, unknown> = { status, attempt: 1, cancelRequestedAt: marker };
    let dispatched = false;
    const tx = {
      taskExecution: { update: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(task, data); } },
      taskOutbox: { create: async ({ data }: { data: Record<string, unknown> }) => {
        assert.equal(task.cancelRequestedAt, null, "retry must clear cancellation or claimTask will refuse the queued run");
        assert.equal(task.status, "queued");
        assert.equal(data.aggregateId, "test_run");
        assert.equal(data.phaseKey, "retry_2");
        dispatched = true;
      } },
    };
    const service = new AiService({
      aiRun: { findUnique: async () => ({ userId: "test_user", taskExecution: task }) },
      $transaction: async (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx),
    }, {});
    const result = await service.retryRun({ userId: "test_user" }, "test_run");
    assert.equal(result.data.status, "queued");
    assert.equal(task.attempt, 2);
    assert.equal(task.leaseOwner, null);
    assert.equal(task.leaseExpiresAt, null);
    assert.ok(dispatched);
  });
}

test("A3 cancel keeps ownership checks and records a request without stealing a running lease", async () => {
  const queries: Array<{ sql: string; values?: unknown }> = [];
  const pool: QueryClient = { query: async (sql, values) => { queries.push({ sql, values }); return { rows: [], rowCount: 1 }; } };
  const service = new AiService({ aiRun: { findUnique: async () => ({ userId: "test_user", taskExecution: { status: "running" } }) } }, pool);
  await assert.rejects(() => service.cancelRun({ userId: "test_other_user" }, "test_run"));
  assert.equal(queries.length, 0);
  await service.cancelRun({ userId: "test_user" }, "test_run");
  assert.equal(queries.length, 1);
  assert.ok(queries[0], "the accepted cancellation must produce a query");
  assert.match(queries[0].sql, /cancel_requested_at = CURRENT_TIMESTAMP/);
  assert.doesNotMatch(queries[0].sql, /lease_owner = NULL/);
});
