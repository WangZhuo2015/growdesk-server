import test from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { loadSessionMessageSummaries, type SummaryDatabase } from "../../apps/api/src/services/web-ai-session-summary.js";

function fixtureDatabase(rows: pg.QueryResultRow[]) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const database: SummaryDatabase = {
    async query<T extends pg.QueryResultRow>(sql: string, values: unknown[]) {
      calls.push({ sql, values });
      // Deliberately controlled database boundary; production rows are validated
      // by loadSessionMessageSummaries before they become public DTOs.
      return { rows: rows as T[] };
    },
  };
  return { database, calls };
}
function emptyRow(id: string) {
  return { session_id: id, message_count: "0", last_id: null, last_role: null, last_content: null, last_created_at: null };
}

test("a page of 30 sessions requires one summary query rather than 60", async () => {
  const ids = Array.from({ length: 30 }, (_, i) => `test_session_${i}`);
  const { database, calls } = fixtureDatabase(ids.map(emptyRow));
  const result = await loadSessionMessageSummaries(database, ids);
  assert.equal(result.size, 30);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.values, [ids]);
  assert.match(calls[0]!.sql, /unnest\(\$1::text\[\]\)/);
  assert.match(calls[0]!.sql, /LEFT JOIN LATERAL/);
  assert.deepEqual(result.get(ids[0]!), { messageCount: 0, lastMessage: null });
});

test("empty pages require no additional query", async () => {
  const { database, calls } = fixtureDatabase([]);
  assert.equal((await loadSessionMessageSummaries(database, [])).size, 0);
  assert.equal(calls.length, 0);
});

test("last message DTO retains order metadata but excludes images and tool payloads", async () => {
  const stamp = new Date("2026-01-01T00:00:00.000Z");
  const { database } = fixtureDatabase([{ session_id: "test_session", message_count: "2", last_id: "test_message",
    last_role: "assistant", last_content: "test_reply", last_created_at: stamp }]);
  assert.deepEqual((await loadSessionMessageSummaries(database, ["test_session"])).get("test_session"), {
    messageCount: 2,
    lastMessage: { id: "test_message", sessionId: "test_session", role: "assistant", content: "test_reply",
      image: null, toolsJson: null, createdAt: stamp.toISOString() },
  });
});

test("incomplete, duplicate, unexpected and inconsistent summaries fail closed", async () => {
  const variants: pg.QueryResultRow[][] = [[], [emptyRow("other_session")],
    [emptyRow("test_session"), emptyRow("test_session")],
    [{ ...emptyRow("test_session"), message_count: "1" }],
    [{ ...emptyRow("test_session"), message_count: "9007199254740993" }],
    [{ ...emptyRow("test_session"), message_count: "-1" }]];
  for (const rows of variants) {
    await assert.rejects(loadSessionMessageSummaries(fixtureDatabase(rows).database, ["test_session"]));
  }
});

test("summary input is bounded before accessing the database", async () => {
  const { database, calls } = fixtureDatabase([]);
  await assert.rejects(loadSessionMessageSummaries(database, Array.from({ length: 1001 }, (_, i) => `test_${i}`)));
  assert.equal(calls.length, 0);
});
