import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@growdesk/database";
import type { UserPrincipal } from "@growdesk/domain";
import { FoodService } from "../../apps/api/src/services/food-service.js";

// Actual service and repository, with only the database boundary controlled.
// This proves call ordering/projection, not a real PostgreSQL rollback.
function fixture(failStatus = false) {
  const calls: string[] = [];
  const committed: Record<string, unknown>[] = [];
  const familyId = "00000000-0000-4000-8000-000000000002";
  const prisma = {
    async $transaction(apply: (tx: unknown) => Promise<unknown>) {
      calls.push("begin");
      const pending: Record<string, unknown>[] = [];
      const tx = {
        foodLibraryItem: { async create({ data }: { data: Record<string, unknown> }) {
          calls.push("item");
          pending.push(data);
          return data;
        } },
        familyFoodStatus: { async create({ data }: { data: Record<string, unknown> }) {
          calls.push("status");
          if (failStatus) throw new Error("test_status_failure");
          pending.push(data);
          return data;
        } },
      };
      const result = await apply(tx);
      calls.push("commit");
      committed.push(...pending);
      return result;
    },
    familyFoodStatus: { async upsert() {
      calls.push("outside-transaction");
      throw new Error("A post-commit status write is forbidden");
    } },
  } as unknown as PrismaClient;
  const principal = {
    userId: "00000000-0000-4000-8000-000000000001",
    familyMemberships: [{ familyId, role: "admin", status: "active" }],
    babyMemberships: [],
  } as unknown as UserPrincipal;
  const service = new FoodService(prisma);
  return { service, principal, calls, committed, familyId };
}

const input = { name: "Test Food", category: "test", allergenRisk: "low" as const, recommendedAgeMonths: 6 };
for (const tried of [undefined, false, true]) {
  test(`food creation preserves tried=${String(tried)} with one transaction`, async () => {
    const f = fixture();
    const result = await f.service.createFoodLibraryItem(f.principal, {
      ...input, familyId: f.familyId, ...(tried === undefined ? {} : { tried }),
    });
    assert.deepEqual(f.calls, tried === undefined ? ["begin", "item", "commit"] : ["begin", "item", "status", "commit"]);
    assert.equal(result.name, input.name);
    assert.deepEqual(result.familyStatus, tried === undefined ? undefined : { tried, reaction: null });
    assert.equal(f.committed.length, tried === undefined ? 1 : 2);
    for (const row of f.committed) assert.equal(row.familyId, f.familyId);
  });
}

test("status creation failure is propagated without a post-commit retry", async () => {
  const f = fixture(true);
  await assert.rejects(f.service.createFoodLibraryItem(f.principal, { ...input, tried: true }), /test_status_failure/);
  assert.deepEqual(f.calls, ["begin", "item", "status"]);
  assert.equal(f.committed.length, 0);
});

test("an unowned explicit family is rejected before transaction creation", async () => {
  const f = fixture();
  await assert.rejects(f.service.createFoodLibraryItem(f.principal, {
    ...input, familyId: "00000000-0000-4000-8000-000000000099", tried: true,
  }));
  assert.deepEqual(f.calls, []);
});
