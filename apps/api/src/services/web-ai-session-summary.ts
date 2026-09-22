import type pg from "pg";
import type { WebAiMessage } from "@growdesk/contracts";

export interface SummaryDatabase {
  query<T extends pg.QueryResultRow>(sql: string, values: unknown[]): Promise<{ rows: T[] }>;
}
export interface SessionMessageSummary {
  messageCount: number;
  lastMessage: WebAiMessage | null;
}
interface SummaryRow {
  session_id: string;
  message_count: string;
  last_id: string | null;
  last_role: "user" | "assistant" | "system" | null;
  last_content: string | null;
  last_created_at: Date | null;
}

/** IDs must come from the already-authorized, bounded session page. */
export async function loadSessionMessageSummaries(
  database: SummaryDatabase,
  sessionIds: readonly string[],
): Promise<Map<string, SessionMessageSummary>> {
  const ids = [...new Set(sessionIds)];
  if (ids.length > 1000) throw new Error("Session summary page exceeds its bound");
  const summaries = new Map<string, SessionMessageSummary>();
  if (ids.length === 0) return summaries;
  // One statement gives counts and last messages the same MVCC snapshot.
  // No messages/images are fetched for sessions outside this authorized page.
  const result = await database.query<SummaryRow>(`
    SELECT requested.id AS session_id,
      (SELECT count(*)::text FROM ai_messages m WHERE m.session_id = requested.id) AS message_count,
      last_message.id AS last_id, last_message.role AS last_role,
      last_message.content AS last_content, last_message.created_at AS last_created_at
    FROM unnest($1::text[]) AS requested(id)
    LEFT JOIN LATERAL (
      SELECT m.id, m.role, left(m.content, 4096) AS content, m.created_at
      FROM ai_messages m WHERE m.session_id = requested.id
      ORDER BY m.created_at DESC, m.id DESC LIMIT 1
    ) AS last_message ON TRUE`, [ids]);
  const expected = new Set(ids);
  for (const row of result.rows) {
    const count = Number(row.message_count);
    if (!expected.has(row.session_id) || summaries.has(row.session_id)
        || !Number.isSafeInteger(count) || count < 0) {
      throw new Error("Invalid session summary returned by database");
    }
    let lastMessage: WebAiMessage | null = null;
    if (row.last_id !== null) {
      if (count === 0 || !row.last_id || !row.last_role || !["user", "assistant", "system"].includes(row.last_role)
          || typeof row.last_content !== "string" || !(row.last_created_at instanceof Date)
          || !Number.isFinite(row.last_created_at.getTime())) {
        throw new Error("Invalid last message returned by database");
      }
      lastMessage = { id: row.last_id, sessionId: row.session_id, role: row.last_role,
        content: row.last_content, image: null, toolsJson: null, createdAt: row.last_created_at.toISOString() };
    } else if (count !== 0) {
      throw new Error("Session message count and last message disagree");
    }
    summaries.set(row.session_id, { messageCount: count, lastMessage });
  }
  if (summaries.size !== ids.length) throw new Error("Incomplete session summaries");
  return summaries;
}
