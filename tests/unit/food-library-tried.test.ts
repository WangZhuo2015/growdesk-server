import test from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyRequest } from "fastify";
import { FoodService } from "../../apps/api/src/services/food-service.js";
import { foodRoutes } from "../../apps/api/src/routes/food-routes.js";
import type { PrismaClient } from "@growdesk/database";
import type { UserPrincipal } from "@growdesk/domain";

type Row = Record<string, unknown>;
type CreateArguments = { data: Row };
type Transaction = {
  foodLibraryItem: { create(args: CreateArguments): Promise<Row> };
  familyFoodStatus: { create(args: CreateArguments): Promise<Row> };
};
const principal = { userId: "test_user_food", familyMemberships: [{ familyId: "test_family_food", status: "active", role: "admin" }], babyMemberships: [] } as unknown as UserPrincipal;
const body = { name: "test_rice", category: "other", allergenRisk: "low" as const, recommendedAgeMonths: 6, tried: true };

// The real service and repository execute. Only the database boundary is a
// fixture: stage item/status changes and expose them to reads after commit.
function harness() {
  const writes: Array<{ create: Row }> = [];
  const rows: Row[] = [];
  const prisma = {
    $transaction: async <T>(apply: (tx: Transaction) => Promise<T>): Promise<T> => {
      const pendingRows: Row[] = [];
      const pendingStatuses: Array<{ create: Row }> = [];
      const result = await apply({
        foodLibraryItem: { create: async ({ data }) => {
          const row = { ...data, id: "test_custom_food" };
          pendingRows.push(row);
          return row;
        } },
        familyFoodStatus: { create: async ({ data }) => {
          pendingStatuses.push({ create: data });
          return data;
        } },
      });
      rows.push(...pendingRows);
      writes.push(...pendingStatuses);
      return result;
    },
    foodLibraryItem: { findMany: async () => rows },
    familyFoodStatus: {
      upsert: async () => { throw new Error("Post-commit status writes are forbidden"); },
      findMany: async () => writes.map(write => write.create),
    },
  } as unknown as PrismaClient;
  return { writes, prisma, service: new FoodService(prisma) };
}

test("F3 service persists explicit tried in the active family and returns it on create/list", async () => {
  const h = harness();
  const created = await h.service.createFoodLibraryItem(principal, body);
  assert.equal(h.writes.length, 1, "tried status must be persisted");
  assert.equal(h.writes[0].create.familyId, "test_family_food");
  assert.equal(h.writes[0].create.foodItemId, "test_custom_food");
  assert.equal(h.writes[0].create.tried, true);
  assert.deepEqual(created.familyStatus, { tried: true, reaction: null });
  assert.deepEqual((await h.service.listFoodLibraryItems(principal))[0]?.familyStatus, created.familyStatus);
});

test("F3 route-local create schema accepts optional tried without dropping it", async t => {
  const h = harness();
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  app.decorate("authenticate", async (request: FastifyRequest) => { request.principal = principal; });
  await app.register(foodRoutes, { prisma: h.prisma });
  t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: "/api/v1/food/items", payload: body });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().familyStatus.tried, true);
  const reload = await app.inject({ method: "GET", url: "/api/v1/food/items" });
  assert.equal(reload.statusCode, 200, reload.body);
  assert.equal(reload.json().data.length, 1, "created food must survive a separate list request");
  assert.equal(reload.json().data[0].id, response.json().id);
  assert.deepEqual(reload.json().data[0].familyStatus, { tried: true, reaction: null });
});

test("F3 omission keeps old create behavior; false is explicitly persisted", async () => {
  const h = harness();
  const { tried, ...withoutTried } = body;
  await h.service.createFoodLibraryItem(principal, withoutTried);
  assert.equal(h.writes.length, 0);
  await h.service.createFoodLibraryItem(principal, { ...body, tried: false });
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].create.tried, false);
});
