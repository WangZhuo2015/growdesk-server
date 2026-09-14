import { randomUUID, createHash } from "node:crypto";
import pg from "pg";
import {
  PrismaClient,
  Prisma,
  RecordNotFoundError,
  BabyAccessDeniedError,
  ConcurrencyConflictError,
  BadRequestError,
  TaskExecutionRepository,
} from "@growdesk/database";
import { UserPrincipal } from "@growdesk/domain";
import { FeedingService } from "./feeding-service.js";
import {
  CreateAiSessionRequest,
  CreateAiRunRequest,
  AiRunConfirmRequest,
  CreateVoiceRunRequest,
  CreateDailySummaryRunRequest,
  type CreateFeedingRequest,
} from "@growdesk/contracts";

export class AiProviderUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = "AI_PROVIDER_NOT_CONFIGURED";

  constructor() {
    super(
      "AI provider is not configured. Configure the approved provider, or explicitly select fixture with a fixture response for tests.",
    );
    this.name = "AiProviderUnavailableError";
  }
}

/** API-side preflight: asynchronous runs must fail clearly before persistence when no provider is usable. */
export function assertAiProviderConfigured(env: NodeJS.ProcessEnv = process.env): void {
  const mode = (env.GROWDESK_AI_PROVIDER ?? "").trim().toLowerCase();
  if (mode === "fixture") {
    if (env.GROWDESK_AI_FIXTURE_RESPONSE ?? env.GROWDESK_AI_FIXTURE_TEXT) return;
    throw new AiProviderUnavailableError();
  }
  if (mode === "openai-compatible" || mode === "openai" || mode === "compat") {
    const baseUrl = env.GROWDESK_AI_BASE_URL?.trim();
    const apiKey = (env.GROWDESK_AI_API_KEY ?? env.AI_API_KEY ?? env.OPENAI_API_KEY ?? "").trim();
    if (baseUrl && apiKey) return;
  }
  throw new AiProviderUnavailableError();
}

interface ProposedActionData {
  readonly actionId: string;
  readonly entityType: string;
  readonly operation: string;
  readonly summary: string;
  readonly payload: Record<string, unknown>;
}

interface ProposedPlanData {
  readonly planHash: string;
  readonly actions: ReadonlyArray<ProposedActionData>;
  readonly expiresAt: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asFeedingRequest(action: ProposedActionData): CreateFeedingRequest {
  const payload = action.payload;
  const feedingType = payload.feedingType;
  const occurredAt = payload.occurredAt;
  if (
    (feedingType !== "breast" && feedingType !== "bottle" && feedingType !== "formula" && feedingType !== "mixed") ||
    typeof occurredAt !== "string" ||
    Number.isNaN(Date.parse(occurredAt))
  ) {
    throw new BadRequestError(
      "A feeding action requires a valid feedingType and occurredAt",
      "AI_ACTION_INVALID",
    );
  }
  const result: CreateFeedingRequest = {
    feedingType,
    occurredAt,
    amountMl: payload.amountMl === undefined || payload.amountMl === null ? payload.amountMl ?? undefined : String(payload.amountMl),
    leftMinutes: payload.leftMinutes === undefined || payload.leftMinutes === null ? payload.leftMinutes : Number(payload.leftMinutes),
    rightMinutes: payload.rightMinutes === undefined || payload.rightMinutes === null ? payload.rightMinutes : Number(payload.rightMinutes),
    spitUp: payload.spitUp === undefined ? false : Boolean(payload.spitUp),
    formulaProductId: payload.formulaProductId === undefined ? undefined : payload.formulaProductId === null ? null : String(payload.formulaProductId),
    notes: payload.notes === undefined ? undefined : payload.notes === null ? null : String(payload.notes),
    source: "ai_chat",
    sourceAgent: "ai_chat",
  };
  if (result.amountMl !== undefined && result.amountMl !== null && !/^-?\d+(\.\d+)?$/.test(result.amountMl)) {
    throw new BadRequestError("amountMl in the feeding action must be a decimal string", "AI_ACTION_INVALID");
  }
  for (const value of [result.leftMinutes, result.rightMinutes]) {
    if (value !== undefined && value !== null && (!Number.isInteger(value) || value < 0)) {
      throw new BadRequestError("feeding duration values must be non-negative integers", "AI_ACTION_INVALID");
    }
  }
  return result;
}

export class AiService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly pool: pg.Pool
  ) {}

  private async assertBabyAccess(principal: UserPrincipal, babyId: string): Promise<void> {
    const membership = await this.prisma.babyMember.findFirst({
      where: {
        userId: principal.userId,
        babyId,
        status: "active",
        deletedAt: null,
      },
    });

    if (!membership) {
      throw new BabyAccessDeniedError(babyId, "NOT_A_MEMBER");
    }
  }

  async createSession(principal: UserPrincipal, body: CreateAiSessionRequest) {
    if (body.babyId) {
      await this.assertBabyAccess(principal, body.babyId);
    }

    const session = await this.prisma.aiSession.create({
      data: {
        id: randomUUID(),
        userId: principal.userId,
        babyId: body.babyId ?? null,
        title: body.title ?? "新对话",
        contextType: "general",
      },
    });

    return {
      data: {
        id: session.id,
        userId: session.userId,
        babyId: session.babyId,
        title: session.title,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
      },
    };
  }

  async listSessions(principal: UserPrincipal, query: { limit?: number; cursor?: string }) {
    const limit = Math.min(query.limit ?? 20, 100);
    const sessions = await this.prisma.aiSession.findMany({
      where: {
        userId: principal.userId,
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      cursor: query.cursor ? { id: query.cursor } : undefined,
      skip: query.cursor ? 1 : 0,
    });

    const hasMore = sessions.length > limit;
    const items = hasMore ? sessions.slice(0, limit) : sessions;
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]!.id : null;

    return {
      data: items.map((s) => ({
        id: s.id,
        userId: s.userId,
        babyId: s.babyId,
        title: s.title,
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
      })),
      page: {
        nextCursor,
      },
    };
  }

  async listMessages(
    principal: UserPrincipal,
    sessionId: string,
    query: { limit?: number; cursor?: string }
  ) {
    const session = await this.prisma.aiSession.findUnique({
      where: { id: sessionId },
    });

    if (!session || session.userId !== principal.userId) {
      throw new RecordNotFoundError("AiSession", sessionId);
    }

    const limit = Math.min(query.limit ?? 50, 100);
    const messages = await this.prisma.aiChatMessage.findMany({
      where: { sessionId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit + 1,
      cursor: query.cursor ? { id: query.cursor } : undefined,
      skip: query.cursor ? 1 : 0,
    });

    const hasMore = messages.length > limit;
    const items = hasMore ? messages.slice(0, limit) : messages;
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]!.id : null;

    return {
      data: items.map((m) => ({
        id: m.id,
        sessionId: m.sessionId,
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
        attachmentIds: [] as string[],
        createdAt: m.createdAt.toISOString(),
      })),
      page: {
        nextCursor,
      },
    };
  }

  async createRun(principal: UserPrincipal, sessionId: string, body: CreateAiRunRequest) {
    const session = await this.prisma.aiSession.findUnique({
      where: { id: sessionId },
    });

    if (!session || session.userId !== principal.userId) {
      throw new RecordNotFoundError("AiSession", sessionId);
    }
    assertAiProviderConfigured();

    const runId = randomUUID();
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      // 1. Insert user message
      await tx.aiChatMessage.create({
        data: {
          id: body.clientMessageId,
          sessionId,
          role: "user",
          content: body.message,
          image: null,
          toolsJson: null,
          createdAt: now,
        },
      });

      // 2. Create TaskExecution and TaskOutbox
      await TaskExecutionRepository.createTask(tx, {
        id: runId,
        kind: "ai_chat_run",
        ownerScope: `user:${principal.userId}`,
        maxAttempts: 3,
        inputPayload: {
          sessionId,
          message: body.message,
          attachmentIds: body.attachmentIds ?? [],
          clientMessageId: body.clientMessageId,
        },
      });

      // 3. Create AiRun
      await tx.aiRun.create({
        data: {
          id: runId,
          sessionId,
          userId: principal.userId,
          babyId: session.babyId,
          lastEventSeq: 1n,
          createdAt: now,
          updatedAt: now,
        },
      });

      // 4. Create initial event
      await tx.aiRunEvent.create({
        data: {
          id: randomUUID(),
          runId,
          sequence: 1n,
          eventType: "queued",
          payload: { clientMessageId: body.clientMessageId },
          createdAt: now,
        },
      });
    });

    return {
      data: {
        id: runId,
        sessionId,
        userId: principal.userId,
        babyId: session.babyId,
        status: "queued" as const,
        attempt: 1,
        lastEventSeq: "1",
        resultSummary: null,
        proposedPlan: null,
        errorCode: null,
        errorMessage: null,
        createdAt: now.toISOString(),
        startedAt: null,
        finishedAt: null,
      },
    };
  }

  async getRun(principal: UserPrincipal, runId: string) {
    const run = await this.prisma.aiRun.findUnique({
      where: { id: runId },
      include: {
        taskExecution: true,
      },
    });

    if (!run || run.userId !== principal.userId) {
      throw new RecordNotFoundError("AiRun", runId);
    }

    const task = run.taskExecution;
    return {
      data: {
        id: run.id,
        sessionId: run.sessionId,
        userId: run.userId,
        babyId: run.babyId,
        status: task.status as
          | "queued"
          | "running"
          | "awaiting_confirmation"
          | "succeeded"
          | "failed"
          | "cancelling"
          | "cancelled",
        attempt: Math.max(task.attempt, 1),
        lastEventSeq: run.lastEventSeq.toString(),
        resultSummary: run.resultSummary,
        proposedPlan: run.proposedPlan as {
          planHash: string;
          actions: Array<{
            actionId: string;
            entityType: string;
            operation: string;
            summary: string;
            payload: Record<string, unknown>;
          }>;
          expiresAt: string;
        } | null,
        errorCode: run.errorCode,
        errorMessage: run.errorMessage,
        createdAt: task.createdAt.toISOString(),
        startedAt: run.startedAt ? run.startedAt.toISOString() : null,
        finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
      },
    };
  }

  async listRunEvents(
    principal: UserPrincipal,
    runId: string,
    after: bigint = 0n,
    limit = 100,
  ) {
    const run = await this.prisma.aiRun.findUnique({
      where: { id: runId },
      include: { taskExecution: true },
    });
    if (!run || run.userId !== principal.userId) {
      throw new RecordNotFoundError("AiRun", runId);
    }

    const events = await this.prisma.aiRunEvent.findMany({
      where: { runId, sequence: { gt: after } },
      orderBy: { sequence: "asc" },
      take: Math.min(Math.max(limit, 1), 100),
    });
    return {
      status: run.taskExecution.status,
      terminal: ["succeeded", "failed", "cancelled"].includes(run.taskExecution.status),
      events: events.map((event) => {
        const storedPayload = asRecord(event.payload);
        const storedAttempt = storedPayload.attempt;
        const payload = { ...storedPayload };
        delete payload.attempt;
        const attempt = typeof storedAttempt === "number" && Number.isInteger(storedAttempt) && storedAttempt > 0
          ? storedAttempt
          : Math.max(run.taskExecution.attempt, 1);
        return {
          runId,
          seq: event.sequence.toString(),
          attempt,
          type: event.eventType,
          payload,
        };
      }),
    };
  }

  async confirmRun(principal: UserPrincipal, runId: string, body: AiRunConfirmRequest) {
    const run = await this.prisma.aiRun.findUnique({
      where: { id: runId },
      include: { taskExecution: true },
    });

    if (!run || run.userId !== principal.userId) {
      throw new RecordNotFoundError("AiRun", runId);
    }
    if (run.taskExecution.status !== "awaiting_confirmation") {
      throw new ConcurrencyConflictError(
        `Run is in '${run.taskExecution.status}', only runs in 'awaiting_confirmation' can be confirmed`,
      );
    }

    const plan = asRecord(run.proposedPlan) as unknown as ProposedPlanData;
    const actions = Array.isArray(plan.actions)
      ? plan.actions.map((action) => {
          const candidate = asRecord(action);
          return {
            actionId: String(candidate.actionId ?? ""),
            entityType: String(candidate.entityType ?? ""),
            operation: String(candidate.operation ?? ""),
            summary: String(candidate.summary ?? ""),
            payload: asRecord(candidate.payload),
          } satisfies ProposedActionData;
        })
      : [];
    if (!plan.planHash || !plan.expiresAt || actions.length === 0) {
      throw new ConcurrencyConflictError("Proposed plan is missing or malformed");
    }
    const computedPlanHash = createHash("sha256").update(JSON.stringify(actions)).digest("hex");
    if (plan.planHash !== body.planHash || computedPlanHash !== plan.planHash) {
      throw new ConcurrencyConflictError("Plan hash mismatch or proposed plan was modified");
    }
    const expiresAtMs = Date.parse(plan.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new ConcurrencyConflictError("Proposed plan has expired; create a new run");
    }

    const requested = new Set(body.actionIds);
    if (requested.size !== body.actionIds.length) {
      throw new BadRequestError("actionIds must not contain duplicates", "AI_ACTION_INVALID");
    }
    const selected = actions.filter((action) => requested.has(action.actionId));
    if (selected.length !== body.actionIds.length) {
      throw new BadRequestError("Confirmation may select only actions in the persisted plan", "AI_ACTION_INVALID");
    }
    // This release deliberately exposes one fully transactional domain action.
    // Other tool kinds are rejected before any side effect rather than reported
    // as if they had been applied.
    if (selected.length !== 1 || selected[0]!.entityType !== "feeding" || selected[0]!.operation !== "create") {
      throw new BadRequestError(
        "Only one feeding create action is currently executable; unsupported actions must be re-planned",
        "AI_ACTION_UNSUPPORTED",
      );
    }
    if (!run.babyId) {
      throw new BadRequestError("A feeding action requires a baby-scoped AI session", "AI_ACTION_INVALID");
    }

    await this.assertBabyAccess(principal, run.babyId);
    const action = selected[0]!;
    const feeding = await new FeedingService(this.prisma).createFeedingRecord(
      principal,
      run.babyId,
      asFeedingRequest(action),
      action.actionId,
    );

    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ last_event_seq: bigint }>>(
        Prisma.sql`SELECT last_event_seq FROM ai_runs WHERE id = ${runId} FOR UPDATE`,
      );
      const currentSeq = locked[0]?.last_event_seq;
      if (currentSeq === undefined) throw new RecordNotFoundError("AiRun", runId);
      const now = new Date();
      const transition = await tx.taskExecution.updateMany({
        where: { id: runId, status: "awaiting_confirmation" },
        data: {
          status: "succeeded",
          leaseOwner: null,
          leaseExpiresAt: null,
          resultRef: { actionIds: [action.actionId], feedingId: feeding.id },
          updatedAt: now,
        },
      });
      if (transition.count !== 1) {
        throw new ConcurrencyConflictError("Run was confirmed by another request");
      }

      const events = [
        { eventType: "tool_started", payload: { actionId: action.actionId } },
        {
          eventType: "tool_succeeded",
          payload: { actionId: action.actionId, result: feeding },
        },
        { eventType: "run_succeeded", payload: { actionIds: [action.actionId] } },
      ];
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index]!;
        await tx.aiRunEvent.create({
          data: {
            id: randomUUID(),
            runId,
            sequence: currentSeq + BigInt(index + 1),
            eventType: event.eventType,
            payload: event.payload,
            createdAt: now,
          },
        });
      }
      await tx.aiRun.update({
        where: { id: runId },
        data: {
          lastEventSeq: currentSeq + BigInt(events.length),
          resultSummary: `已执行：${action.summary}`,
          proposedPlan: Prisma.DbNull,
          finishedAt: now,
          updatedAt: now,
        },
      });
    });

    return {
      data: {
        runId,
        status: "succeeded" as const,
        appliedActionCount: 1,
      },
    };
  }

  async cancelRun(principal: UserPrincipal, runId: string) {
    const run = await this.prisma.aiRun.findUnique({
      where: { id: runId },
      include: { taskExecution: true },
    });

    if (!run || run.userId !== principal.userId) {
      throw new RecordNotFoundError("AiRun", runId);
    }

    if (
      run.taskExecution.status === "succeeded" ||
      run.taskExecution.status === "failed" ||
      run.taskExecution.status === "cancelled"
    ) {
      return { data: { success: true } };
    }

    await TaskExecutionRepository.requestCancel(this.pool, runId);
    return { data: { success: true } };
  }

  async retryRun(principal: UserPrincipal, runId: string) {
    const run = await this.prisma.aiRun.findUnique({
      where: { id: runId },
      include: { taskExecution: true },
    });

    if (!run || run.userId !== principal.userId) {
      throw new RecordNotFoundError("AiRun", runId);
    }

    if (run.taskExecution.status !== "failed" && run.taskExecution.status !== "cancelled") {
      throw new ConcurrencyConflictError(
        `Only failed or cancelled runs can be retried (current status: ${run.taskExecution.status})`
      );
    }

    const newAttempt = run.taskExecution.attempt + 1;

    await this.prisma.$transaction(async (tx) => {
      await tx.taskExecution.update({
        where: { id: runId },
        data: {
          status: "queued",
          attempt: newAttempt,
          leaseOwner: null,
          leaseExpiresAt: null,
          errorDetails: Prisma.JsonNull,
          updatedAt: new Date(),
        },
      });

      await tx.taskOutbox.create({
        data: {
          id: randomUUID(),
          type: "ai_chat_run",
          aggregateId: runId,
          payloadVersion: 1,
          payload: { retryAttempt: newAttempt },
          phaseKey: `retry_${newAttempt}`,
          dispatchState: "active",
        },
      });
    });

    return {
      data: {
        runId,
        newAttempt,
        status: "queued" as const,
      },
    };
  }

  async createVoiceRun(principal: UserPrincipal, body: CreateVoiceRunRequest) {
    await this.assertBabyAccess(principal, body.babyId);

    const runId = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      await TaskExecutionRepository.createTask(tx, {
        id: runId,
        kind: "voice_transcription",
        ownerScope: `baby:${body.babyId}`,
        inputPayload: {
          attachmentId: body.attachmentId,
          clientRequestId: body.clientRequestId,
          babyId: body.babyId,
        },
      });
    });

    return {
      data: {
        runId,
        status: "queued" as const,
      },
    };
  }

  async createDailySummaryRun(
    principal: UserPrincipal,
    babyId: string,
    body: CreateDailySummaryRunRequest
  ) {
    await this.assertBabyAccess(principal, babyId);

    const runId = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      await TaskExecutionRepository.createTask(tx, {
        id: runId,
        kind: "daily_summary_synthesis",
        ownerScope: `baby:${babyId}`,
        inputPayload: {
          babyId,
          targetDate: body.targetDate,
        },
      });
    });

    return {
      data: {
        runId,
        status: "queued" as const,
      },
    };
  }

  async listDailySummaries(
    principal: UserPrincipal,
    babyId: string,
    query: { limit?: number; cursor?: string }
  ) {
    await this.assertBabyAccess(principal, babyId);

    const limit = Math.min(query.limit ?? 20, 100);
    const summaries = await this.prisma.dailySummary.findMany({
      where: { babyId },
      orderBy: [{ targetDate: "desc" }, { id: "desc" }],
      take: limit + 1,
      cursor: query.cursor ? { id: query.cursor } : undefined,
      skip: query.cursor ? 1 : 0,
    });

    const hasMore = summaries.length > limit;
    const items = hasMore ? summaries.slice(0, limit) : summaries;
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]!.id : null;

    return {
      data: items.map((s) => ({
        id: s.id,
        babyId: s.babyId,
        familyId: s.familyId,
        targetDate: s.targetDate.toISOString().slice(0, 10),
        content: s.content,
        version: s.version.toString(),
        createdAt: s.createdAt.toISOString(),
      })),
      page: {
        nextCursor,
      },
    };
  }
}
