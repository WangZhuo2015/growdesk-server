import test from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@growdesk/database";
import { normalizedLegacyUploadPath, resolveLegacyUpload } from "../../apps/api/src/services/legacy-attachment-resolver.js";

const attachmentId = "a0000000-0000-4000-8000-000000000001";
function database(rows: Array<{ id: string }>) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db = { $queryRaw: async (sql: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ sql: sql.join("?"), values });
    return rows;
  } } as unknown as Pick<PrismaClient, "$queryRaw">;
  return { db, calls };
}

test("legacy paths are restricted to a literal captured uploads path", () => {
  assert.equal(normalizedLegacyUploadPath("/uploads/test/photo.png"), "public/uploads/test/photo.png");
  for (const path of ["https://test.invalid/a", "//uploads/test.png", "/uploads/../private", "/uploads//a", "/uploads/./a", "/uploads/a%2fb", "/uploads/a\\b", "/uploads/a?token=x", "/uploads/a#x", "/uploads/a\u0000b", "/uploads/"]) {
    assert.throws(() => normalizedLegacyUploadPath(path));
  }
});

test("unsafe paths never query the database", async () => {
  const h = database([{ id: attachmentId }]);
  await assert.rejects(resolveLegacyUpload(h.db, "test_user", "/uploads/../private"));
  assert.equal(h.calls.length, 0);
});

test("only an unambiguous authorized attachment identity is returned", async () => {
  const h = database([{ id: attachmentId }]);
  assert.deepEqual(await resolveLegacyUpload(h.db, "test_user", "/uploads/test.png"), { id: attachmentId });
  assert.deepEqual(h.calls[0]!.values, ["test_user", "public/uploads/test.png"]);
  assert.match(h.calls[0]!.sql, /family_members/);
  assert.match(h.calls[0]!.sql, /baby_members/);
  assert.match(h.calls[0]!.sql, /deleted_at IS NULL/);
  assert.match(h.calls[0]!.sql, /LIMIT 2/);
});

test("absent ambiguous and malformed mappings do not expose an object", async () => {
  for (const rows of [[], [{ id: attachmentId }, { id: attachmentId }], [{ id: "not-an-attachment-id" }]]) {
    await assert.rejects(resolveLegacyUpload(database(rows).db, "test_user", "/uploads/test.png"));
  }
});
