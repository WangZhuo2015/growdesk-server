import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { WebAiSession, WebAiMessage, WebAiSessionInput, WebAiMessageInput, WebAiListOptions } from "@growdesk/contracts";

type Database = Pick<pg.Pool, "query">;
interface SessionRow { id: string; user_id: string; baby_id: string | null; title: string; context_type: string; created_at: Date; updated_at: Date }
interface MessageRow { id: string; session_id: string; role: "user" | "assistant" | "system"; content: string; image: string | null; tools_json: string | null; created_at: Date }
export class WebAiStateError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}
const visibleBaby = `(s.baby_id IS NULL OR EXISTS (
  SELECT 1 FROM baby_members bm JOIN babies b ON b.id = bm.baby_id AND b.family_id = bm.family_id
  JOIN family_members fm ON fm.family_id = b.family_id AND fm.user_id = bm.user_id
  WHERE bm.user_id = s.user_id AND bm.baby_id = s.baby_id AND bm.status = 'active' AND bm.deleted_at IS NULL
    AND fm.status = 'active' AND fm.deleted_at IS NULL AND b.deleted_at IS NULL
))`;
const messageDto = (row: MessageRow): WebAiMessage => ({ id: row.id, sessionId: row.session_id, role: row.role, content: row.content, image: row.image, toolsJson: row.tools_json, createdAt: row.created_at.toISOString() });
const sessionDto = (row: SessionRow, messages: WebAiMessage[] = [], count = messages.length, last: WebAiMessage | null = messages.at(-1) ?? null): WebAiSession => ({
  id: row.id, userId: row.user_id, babyId: row.baby_id, title: row.title, contextType: row.context_type,
  createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), messages, messageCount: count, lastMessage: last,
});

/** All authoritative state is in PostgreSQL. No per-process map, filesystem cache or success fallback. */
export class WebAiSessionService {
  constructor(private readonly pool: pg.Pool) {}

  private async session(database: Database, userId: string, id: string, lock = false): Promise<SessionRow> {
    const result = await database.query<SessionRow>(`SELECT s.* FROM ai_sessions s WHERE s.id = $1 AND s.user_id = $2 AND ${visibleBaby}${lock ? " FOR UPDATE OF s" : ""}`, [id, userId]);
    const row = result.rows[0];
    if (!row) throw new WebAiStateError(404, "SESSION_NOT_FOUND", "Conversation not found or no longer authorized");
    return row;
  }

  private async transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); const value = await work(client); await client.query("COMMIT"); return value; }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async create(userId: string, body: WebAiSessionInput): Promise<WebAiSession> {
    return this.transaction(async client => {
      if (body.babyId) {
        const membership = await client.query(`SELECT bm.baby_id FROM baby_members bm
          JOIN babies b ON b.id = bm.baby_id AND b.family_id = bm.family_id
          JOIN family_members fm ON fm.family_id = b.family_id AND fm.user_id = bm.user_id
          WHERE bm.user_id = $1 AND bm.baby_id = $2 AND bm.status = 'active' AND bm.deleted_at IS NULL
          AND fm.status = 'active' AND fm.deleted_at IS NULL AND b.deleted_at IS NULL FOR SHARE OF bm, fm, b`, [userId, body.babyId]);
        if (!membership.rowCount) throw new WebAiStateError(403, "BABY_ACCESS_DENIED", "Baby access denied");
      }
      const result = await client.query<SessionRow>(`INSERT INTO ai_sessions (id, user_id, baby_id, title, context_type, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING *`,
      [randomUUID(), userId, body.babyId ?? null, body.title?.trim() || "新对话", body.contextType?.trim() || "general"]);
      return sessionDto(result.rows[0]!);
    });
  }

  async get(userId: string, id: string): Promise<WebAiSession> {
    return this.transaction(async client => {
      // One locked parent serializes append, rename and deletion across Web instances.
      const session = await this.session(client, userId, id, true);
      const size = await client.query<{ count: string; bytes: string }>(`SELECT count(*) AS count,
        COALESCE(sum(octet_length(content) + COALESCE(octet_length(image),0) + COALESCE(octet_length(tools_json),0)),0) AS bytes FROM ai_messages WHERE session_id = $1`, [id]);
      if (Number(size.rows[0]!.count) > 5000 || Number(size.rows[0]!.bytes) > 16_000_000) throw new WebAiStateError(413, "CONVERSATION_TOO_LARGE", "Conversation requires paginated export; no history was truncated");
      const messages = await client.query<MessageRow>("SELECT * FROM ai_messages WHERE session_id = $1 ORDER BY created_at, id", [id]);
      return sessionDto(session, messages.rows.map(messageDto));
    });
  }

  async list(userId: string, options: WebAiListOptions): Promise<{ total: number; sessions: WebAiSession[] }> {
    const values = [userId, options.babyId ?? null, options.contextType ?? null];
    const where = `s.user_id = $1 AND ($2::text IS NULL OR s.baby_id = $2) AND ($3::text IS NULL OR s.context_type = $3) AND ${visibleBaby}`;
    const count = await this.pool.query<{ total: string }>(`SELECT count(*) AS total FROM ai_sessions s WHERE ${where}`, values);
    const rows = await this.pool.query<SessionRow>(`SELECT s.* FROM ai_sessions s WHERE ${where} ORDER BY s.updated_at DESC, s.id DESC LIMIT $4 OFFSET $5`, [...values, options.limit ?? 30, options.offset ?? 0]);
    const sessions: WebAiSession[] = [];
    for (const row of rows.rows) {
      const countResult = await this.pool.query<{ total: string }>("SELECT count(*) AS total FROM ai_messages WHERE session_id = $1", [row.id]);
      const last = await this.pool.query<MessageRow>("SELECT id, session_id, role, left(content, 4096) AS content, NULL::text AS image, NULL::text AS tools_json, created_at FROM ai_messages WHERE session_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [row.id]);
      sessions.push(sessionDto(row, [], Number(countResult.rows[0]!.total), last.rows[0] ? messageDto(last.rows[0]) : null));
    }
    return { total: Number(count.rows[0]!.total), sessions };
  }

  async rename(userId: string, id: string, title: string): Promise<WebAiSession> {
    return this.transaction(async client => {
      await this.session(client, userId, id, true);
      const row = await client.query<SessionRow>("UPDATE ai_sessions SET title = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2 RETURNING *", [id, userId, title.trim() || "新对话"]);
      return sessionDto(row.rows[0]!);
    });
  }

  async remove(userId: string, id: string): Promise<{ deleted: boolean }> {
    return this.transaction(async client => {
      await this.session(client, userId, id, true);
      const active = await client.query("SELECT r.id FROM ai_runs r JOIN task_executions t ON t.id = r.id WHERE r.session_id = $1 AND t.status NOT IN ('succeeded', 'failed', 'cancelled') LIMIT 1", [id]);
      if (active.rowCount) throw new WebAiStateError(409, "SESSION_RUN_ACTIVE", "Cancel the running task before deleting its conversation");
      await client.query("DELETE FROM ai_sessions WHERE id = $1 AND user_id = $2", [id, userId]);
      return { deleted: true };
    });
  }

  async append(userId: string, id: string, body: WebAiMessageInput): Promise<WebAiMessage> {
    return this.transaction(async client => {
      await this.session(client, userId, id, true);
      const existing = await client.query<MessageRow>("SELECT * FROM ai_messages WHERE id = $1", [body.id]);
      const row = existing.rows[0];
      if (row) {
        if (row.session_id !== id || row.role !== body.role || row.content !== body.content || row.image !== (body.image ?? null) || row.tools_json !== (body.toolsJson ?? null)) throw new WebAiStateError(409, "MESSAGE_ID_REUSED", "Message ID already has different content");
        return messageDto(row);
      }
      const size = await client.query<{ count: string; bytes: string }>(`SELECT count(*) AS count,
        COALESCE(sum(octet_length(content) + COALESCE(octet_length(image),0) + COALESCE(octet_length(tools_json),0)),0) AS bytes FROM ai_messages WHERE session_id = $1`, [id]);
      const addedBytes = Buffer.byteLength(body.content) + Buffer.byteLength(body.image ?? "") + Buffer.byteLength(body.toolsJson ?? "");
      if (Number(size.rows[0]!.count) >= 5000 || Number(size.rows[0]!.bytes) + addedBytes > 16_000_000) throw new WebAiStateError(413, "CONVERSATION_TOO_LARGE", "Create a new conversation; existing history is preserved");
      // Parent lock plus strictly increasing timestamps preserve append order even within the same millisecond.
      const result = await client.query<MessageRow>(`INSERT INTO ai_messages (id, session_id, role, content, image, tools_json, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, GREATEST(clock_timestamp(), COALESCE((SELECT max(created_at) + interval '1 millisecond' FROM ai_messages WHERE session_id = $2), clock_timestamp()))) RETURNING *`,
      [body.id, id, body.role, body.content, body.image ?? null, body.toolsJson ?? null]);
      await client.query("UPDATE ai_sessions SET updated_at = clock_timestamp() WHERE id = $1", [id]);
      return messageDto(result.rows[0]!);
    });
  }
}
