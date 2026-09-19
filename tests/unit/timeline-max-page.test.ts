import test from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@growdesk/database";
import { BabyAccessDeniedError, ScopedTimelineRepository } from "@growdesk/database";
import type { UserPrincipal } from "@growdesk/domain";
import { TimelineService } from "../../apps/api/src/services/timeline-service.js";

const FAMILY = "test_family_pagination";
const BABY = "test_baby_pagination";
const USER = "test_user_pagination";

/**
 * Exercise the real service AND repository with an in-memory Prisma boundary.
 * All rows deliberately share a timestamp, so continuation must use the ID tie
 * breaker. These unit tests do not replace the isolated PostgreSQL suite.
 */
function harness(count: number) {
  const instant = new Date("2026-09-01T08:00:00.000Z");
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `test_entry_${String(count - index).padStart(6, "0")}`,
    familyId: FAMILY,
    babyId: BABY,
    entityType: "feeding",
    entityId: `test_record_${count - index}`,
    occurredAt: instant,
    summary: "test feeding",
    details: {},
    source: "test",
    version: 1,
    deletedAt: null,
    createdAt: instant,
    updatedAt: instant,
  }));
  const queries: Array<{ take: number; where: Record<string, unknown> }> = [];
  const prisma = {
    baby: {
      findUnique: async () => ({ familyId: FAMILY, deletedAt: null }),
    },
    timelineEntry: {
      findMany: async (query: { take: number; where: Record<string, unknown> }) => {
        queries.push(query);
        assert.equal(query.where.familyId, FAMILY);
        assert.equal(query.where.babyId, BABY);
        assert.equal(query.where.deletedAt, null);
        const predicates = query.where.OR as Array<{ id?: { lt: string } }> | undefined;
        const beforeId = predicates?.find(predicate => predicate.id)?.id?.lt;
        const typeFilter = query.where.entityType as string | { in: string[] } | undefined;
        return rows.filter(row => (!beforeId || row.id < beforeId) &&
          (!typeFilter || (typeof typeFilter === "string" ? row.entityType === typeFilter : typeFilter.in.includes(row.entityType))))
          .slice(0, query.take);
      },
    },
  } as unknown as PrismaClient;
  const principal = {
    userId: USER,
    familyMemberships: [{ familyId: FAMILY, status: "active", role: "admin" }],
    babyMemberships: [{ userId: USER, familyId: FAMILY, babyId: BABY, status: "active", role: "admin" }],
  } as unknown as UserPrincipal;
  return { rows, queries, prisma, principal, service: new TimelineService(prisma) };
}

test("timeline filters non-care projections before pagination without losing any supported kind", async () => {
  const h = harness(8);
  const kinds = ["vaccine", "medical", "feeding", "sleep", "diaper", "food", "supplement", "growth"];
  h.rows.forEach((row, i) => { row.entityType = kinds[i]!; });
  const first = await h.service.listTimeline(h.principal, BABY, { limit: 3 });
  assert.deepEqual(first.data.map(row => row.entityType), ["feeding", "sleep", "diaper"],
    "care timeline must exclude vaccine/medical before applying the page limit");
  assert.ok(first.page.nextCursor);
  const second = await h.service.listTimeline(h.principal, BABY, { limit: 3, cursor: first.page.nextCursor });
  assert.deepEqual(second.data.map(row => row.entityType), ["food", "supplement", "growth"]);
  assert.equal(second.page.nextCursor, null);
  for (const entityType of ["vaccine", "medical", "unknown"]) {
    const result = await h.service.listTimeline(h.principal, BABY, { entityType });
    assert.deepEqual(result.data, [], "an explicit filter must not re-enable non-care entries");
  }
  assert.deepEqual((await h.service.listTimeline(h.principal, BABY, { entityType: "growth" })).data.map(row => row.entityType), ["growth"]);
});

test("maximum-size timeline page retains its lookahead and every tied-timestamp row", async () => {
  const h = harness(401);
  const ids: string[] = [];
  let cursor: string | undefined;
  const sizes: number[] = [];
  for (let page = 0; page < 3; page += 1) {
    const result = await h.service.listTimeline(h.principal, BABY, { limit: 200, cursor });
    sizes.push(result.data.length);
    ids.push(...result.data.map(row => row.id));
    if (page < 2) assert.ok(result.page.nextCursor, "a full page must not hide remaining history");
    else assert.equal(result.page.nextCursor, null);
    cursor = result.page.nextCursor ?? undefined;
  }
  assert.deepEqual(sizes, [200, 200, 1]);
  assert.deepEqual(ids, h.rows.map(row => row.id));
  assert.equal(new Set(ids).size, 401);
  assert.deepEqual(h.queries.map(query => query.take), [201, 201, 201]);
});

test("exactly 200 timeline rows form a complete final page", async () => {
  const h = harness(200);
  const result = await h.service.listTimeline(h.principal, BABY, { limit: 200 });
  assert.equal(result.data.length, 200);
  assert.equal(result.page.nextCursor, null);
  assert.equal(h.queries[0]?.take, 201);
});

test("201st timeline row remains discoverable after a maximum-size page", async () => {
  const h = harness(201);
  const first = await h.service.listTimeline(h.principal, BABY, { limit: 200 });
  assert.equal(first.data.length, 200);
  assert.ok(first.page.nextCursor);
  const second = await h.service.listTimeline(h.principal, BABY, { limit: 200, cursor: first.page.nextCursor });
  assert.equal(second.data.length, 1);
  assert.equal(second.data[0]?.id, h.rows[200]?.id);
  assert.equal(second.page.nextCursor, null);
});

test("default-size and empty timeline pages preserve their existing contracts", async () => {
  const h = harness(51);
  const result = await h.service.listTimeline(h.principal, BABY);
  assert.equal(result.data.length, 50);
  assert.ok(result.page.nextCursor);
  assert.equal(h.queries[0]?.take, 51);
  const empty = harness(0);
  assert.deepEqual(await empty.service.listTimeline(empty.principal, BABY), {
    data: [], page: { nextCursor: null },
  });
});

test("lookahead does not increase the public page limit or allow unbounded repository reads", async () => {
  const h = harness(500);
  const result = await h.service.listTimeline(h.principal, BABY, { limit: 10_000 });
  assert.equal(result.data.length, 200);
  assert.equal(h.queries[0]?.take, 201);
  const repo = new ScopedTimelineRepository(h.prisma);
  const rows = await repo.listByBaby(h.principal, FAMILY, BABY, { limit: 10_000 });
  assert.equal(rows.length, 201);
  assert.equal(h.queries[1]?.take, 201);
});

test("maximum-size pagination still rejects missing baby membership before querying records", async () => {
  const h = harness(201);
  const principal = { ...h.principal, babyMemberships: [] } as UserPrincipal;
  await assert.rejects(h.service.listTimeline(principal, BABY, { limit: 200 }), BabyAccessDeniedError);
  assert.equal(h.queries.length, 0);
});
