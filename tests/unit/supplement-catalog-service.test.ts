import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@growdesk/database";
import type { UserPrincipal } from "@growdesk/domain";
import { BadRequestError } from "@growdesk/database";
import { SupplementCatalogService } from "../../apps/api/src/services/supplement-catalog-service.js";

const FAMILY = "test_supplement_catalog_family";
const USER = "test_supplement_catalog_user";

const principal = {
  userId: USER,
  familyMemberships: [{ familyId: FAMILY, status: "active", role: "admin" }],
  babyMemberships: [],
} as unknown as UserPrincipal;

function product(id: string, createdAt: string) {
  const stamp = new Date(createdAt);
  return {
    id,
    familyId: FAMILY,
    name: id,
    brand: "test brand",
    dosageForm: "drops",
    unitName: "滴",
    defaultDose: "1.5",
    nutrientsJson: { vitaminD: { amount: 400, unit: "IU" } },
    notes: null,
    isActive: true,
    isArchived: false,
    version: 1,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

function harness() {
  const rows = [
    product("test_sv_product_z", "2026-09-03T00:00:00.000Z"),
    product("test_sv_product_a", "2026-09-02T00:00:00.000Z"),
    product("test_sv_product_old", "2026-09-01T00:00:00.000Z"),
  ];
  const queries: Array<Record<string, any>> = [];
  const prisma = {
    supplementProduct: {
      findMany: async (query: Record<string, any>) => {
        queries.push(query);
        const predicates = query.where.OR as Array<Record<string, any>> | undefined;
        const beforeDate = predicates?.find((item) => item.createdAt?.lt)?.createdAt?.lt as Date | undefined;
        const beforeId = predicates?.find((item) => item.id?.lt)?.id?.lt as string | undefined;
        return rows
          .filter((row) => !beforeDate || row.createdAt < beforeDate || (row.createdAt.getTime() === beforeDate.getTime() && (!beforeId || row.id < beforeId)))
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id))
          .slice(0, query.take);
      },
    },
  } as unknown as PrismaClient;
  return { rows, queries, service: new SupplementCatalogService(prisma) };
}

test("supplement product keyset cursor accepts promoted source-stable IDs", async () => {
  const h = harness();
  const first = await h.service.listProducts(principal, FAMILY, { limit: 1 });
  assert.deepEqual(first.data.map((row) => row.id), ["test_sv_product_z"]);
  assert.ok(first.page.nextCursor);

  const second = await h.service.listProducts(principal, FAMILY, { limit: 1, cursor: first.page.nextCursor! });
  assert.deepEqual(second.data.map((row) => row.id), ["test_sv_product_a"]);
  assert.deepEqual(h.queries[1]?.where.OR, [
    { createdAt: { lt: new Date("2026-09-03T00:00:00.000Z") } },
    { createdAt: new Date("2026-09-03T00:00:00.000Z"), id: { lt: "test_sv_product_z" } },
  ]);
});

test("supplement product cursor rejects malformed or unsafe values", async () => {
  const h = harness();
  await assert.rejects(
    h.service.listProducts(principal, FAMILY, { cursor: Buffer.from("2026-09-03T00:00:00.000Z|not safe").toString("base64url") }),
    (error: unknown) => error instanceof BadRequestError && error.code === "INVALID_CURSOR" && error.statusCode === 400,
  );
});
