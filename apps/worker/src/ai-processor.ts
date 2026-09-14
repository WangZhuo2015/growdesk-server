import { randomUUID } from "node:crypto";
import pg from "pg";
import { FencingTokenMismatchError } from "@growdesk/database";
import type { TaskExecutionContext, TaskProcessor } from "./worker-engine.js";
import {
  AiProviderError,
  type AiProvider,
  type AiProviderAction,
  createAiProvider,
  planHash,
} from "./ai-provider.js";

interface AiRunRow {
  readonly id: string;
  readonly session_id: string;
  readonly baby_id: string | null;
}

interface FenceGuard {
  readonly workerId: string;
  readonly fenceToken: bigint;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function appendEvent(
  pool: pg.Pool,
  runId: string,
  attempt: number,
  eventType: string,
  payload: Record<string, unknown>,
  guard: FenceGuard,
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const seqResult = await client.query<{ last_event_seq: string }>(
      `UPDATE ai_runs
       SET last_event_seq = last_event_seq + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
         AND EXISTS (
           SELECT 1 FROM task_executions
           WHERE id = $1 AND status = 'running' AND lease_owner = $2 AND fence_token = $3
         )
       RETURNING last_event_seq`,
      [runId, guard.workerId, guard.fenceToken.toString()],
    );
    const row = seqResult.rows[0];
    if (!row) throw new FencingTokenMismatchError("AI run event rejected by task fence");
    const sequence = row.last_event_seq;
    await client.query(
      `INSERT INTO ai_run_events (id, run_id, sequence, event_type, payload, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, CURRENT_TIMESTAMP)`,
      [randomUUID(), runId, sequence, eventType, JSON.stringify({ ...payload, attempt })],
    );
    await client.query("COMMIT");
    return sequence;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original database/fence error.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function updateRun(
  pool: pg.Pool,
  runId: string,
  data: {
    readonly resultSummary?: string | null;
    readonly proposedPlan?: Record<string, unknown> | null;
    readonly errorCode?: string | null;
    readonly errorMessage?: string | null;
    readonly started?: boolean;
    readonly finished?: boolean;
  },
  guard: FenceGuard,
): Promise<void> {
  const sets: string[] = ["updated_at = CURRENT_TIMESTAMP"];
  const values: unknown[] = [runId, guard.workerId, guard.fenceToken.toString()];
  const add = (sql: string, value: unknown): void => {
    values.push(value);
    sets.push(`${sql} $${values.length}`);
  };
  if (data.resultSummary !== undefined) add("result_summary =", data.resultSummary);
  if (data.proposedPlan !== undefined) add("proposed_plan =", data.proposedPlan ? JSON.stringify(data.proposedPlan) : null);
  if (data.errorCode !== undefined) add("error_code =", data.errorCode);
  if (data.errorMessage !== undefined) add("error_message =", data.errorMessage);
  if (data.started) sets.push("started_at = COALESCE(started_at, CURRENT_TIMESTAMP)");
  if (data.finished) sets.push("finished_at = CURRENT_TIMESTAMP");
  const result = await pool.query(
    `UPDATE ai_runs SET ${sets.join(", ")}
     WHERE id = $1
       AND EXISTS (
         SELECT 1 FROM task_executions
         WHERE id = $1 AND status = 'running' AND lease_owner = $2 AND fence_token = $3
       )`,
    values,
  );
  if (result.rowCount === 0) throw new FencingTokenMismatchError("AI run update rejected by task fence");
}

function validateProviderActions(actions: ReadonlyArray<AiProviderAction>): AiProviderAction[] {
  const seen = new Set<string>();
  return actions.map((action, index) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(action.actionId)) {
      throw new AiProviderError(`Provider action at index ${index} has an invalid UUID actionId`, "AI_PROVIDER_INVALID_RESPONSE");
    }
    if (seen.has(action.actionId)) {
      throw new AiProviderError(`Provider returned duplicate actionId '${action.actionId}'`, "AI_PROVIDER_INVALID_RESPONSE");
    }
    seen.add(action.actionId);
    return action;
  });
}

export interface AiChatProcessorOptions {
  readonly provider?: AiProvider;
  readonly env?: NodeJS.ProcessEnv;
  readonly confirmationTtlMs?: number;
}

/** Durable processor for the persisted ai_chat_run task kind. */
export function createAiChatProcessor(
  pool: pg.Pool,
  options: AiChatProcessorOptions = {},
): TaskProcessor {
  const provider = options.provider ?? createAiProvider(options.env);
  const confirmationTtlMs = options.confirmationTtlMs ?? 30 * 60 * 1000;

  return {
    kind: "ai_chat_run",
    async execute(ctx: TaskExecutionContext) {
      const guard: FenceGuard = { workerId: ctx.workerId, fenceToken: ctx.fenceToken };
      const runResult = await pool.query<AiRunRow>(
        "SELECT id, session_id, baby_id FROM ai_runs WHERE id = $1",
        [ctx.taskId],
      );
      const run = runResult.rows[0];
      if (!run) throw new AiProviderError("AI run row is missing", "AI_INPUT_NOT_FOUND", { statusCode: 500 });

      const payload = asRecord(ctx.payload);
      const message = stringValue(payload.message);
      if (!message) {
        throw new AiProviderError("AI run input message is missing", "AI_INPUT_INVALID", { statusCode: 400 });
      }
      const attachmentIds = Array.isArray(payload.attachmentIds)
        ? payload.attachmentIds.filter((value): value is string => typeof value === "string")
        : [];

      await updateRun(pool, ctx.taskId, { started: true }, guard);
      await appendEvent(pool, ctx.taskId, ctx.attempt, "run_started", { provider: provider.name }, guard);

      let pendingText = "";
      let flushChain = Promise.resolve();
      let flushTimer: NodeJS.Timeout | undefined;
      const flush = async (): Promise<void> => {
        if (!pendingText) return flushChain;
        const text = pendingText;
        pendingText = "";
        flushChain = flushChain.then(async () => {
          await appendEvent(pool, ctx.taskId, ctx.attempt, "text_delta", { text }, guard);
        });
        await flushChain;
      };
      const scheduleFlush = (): void => {
        if (flushTimer) return;
        flushTimer = setTimeout(() => {
          flushTimer = undefined;
          void flush();
        }, 200);
      };

      try {
        const result = await provider.generate({
          sessionId: run.session_id,
          babyId: run.baby_id,
          message,
          attachmentIds,
          onTextDelta: async (delta) => {
            if (ctx.isCancelled()) return;
            pendingText += delta;
            if (pendingText.length >= 2048) await flush();
            else scheduleFlush();
          },
        });
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = undefined;
        }
        await flush();
        if (ctx.isCancelled()) {
          await appendEvent(pool, ctx.taskId, ctx.attempt, "run_cancelled", {}, guard);
          await updateRun(pool, ctx.taskId, { finished: true }, guard);
          return { result: { cancelled: true } };
        }

        const actions = validateProviderActions(result.actions);
        if (actions.length > 0) {
          const expiresAt = new Date(Date.now() + confirmationTtlMs).toISOString();
          const proposedPlan = {
            planHash: planHash(actions),
            actions,
            expiresAt,
          };
          await updateRun(pool, ctx.taskId, {
            resultSummary: result.text || null,
            proposedPlan,
          }, guard);
          await appendEvent(pool, ctx.taskId, ctx.attempt, "tool_proposed", { plan: proposedPlan }, guard);
          await appendEvent(pool, ctx.taskId, ctx.attempt, "awaiting_confirmation", {
            planHash: proposedPlan.planHash,
            expiresAt,
          }, guard);
          return { parkPlan: proposedPlan };
        }

        await updateRun(pool, ctx.taskId, { resultSummary: result.text || null, finished: true }, guard);
        await appendEvent(pool, ctx.taskId, ctx.attempt, "run_succeeded", {
          text: result.text,
          usage: result.usage ?? null,
        }, guard);
        return { result: { text: result.text, usage: result.usage ?? null } };
      } catch (error) {
        if (flushTimer) clearTimeout(flushTimer);
        if (error instanceof FencingTokenMismatchError) throw error;
        const code = error instanceof AiProviderError ? error.code : "AI_PROVIDER_ERROR";
        const messageText = error instanceof Error ? error.message : String(error);
        try {
          await updateRun(pool, ctx.taskId, { errorCode: code, errorMessage: messageText, finished: true }, guard);
          await appendEvent(pool, ctx.taskId, ctx.attempt, "run_failed", { code, message: messageText }, guard);
        } catch (persistenceError) {
          if (persistenceError instanceof FencingTokenMismatchError) throw persistenceError;
        }
        throw error;
      }
    },
  };
}

/** Explicit processor result for task kinds whose domain pipeline is not wired yet. */
export function createUnsupportedAiProcessor(kind: string): TaskProcessor {
  return {
    kind,
    async execute() {
      throw new AiProviderError(
        `Task kind '${kind}' has no configured processor in this release`,
        "TASK_PROCESSOR_UNAVAILABLE",
        { statusCode: 503 },
      );
    },
  };
}
