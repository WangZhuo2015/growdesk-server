import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  TaskExecutionRepository,
  TaskClaimResult,
  FencingTokenMismatchError,
} from "@growdesk/database";

export interface TaskExecutionContext {
  readonly taskId: string;
  readonly kind: string;
  readonly ownerScope: string;
  readonly attempt: number;
  readonly fenceToken: bigint;
  readonly workerId: string;
  readonly payload: Record<string, unknown>;
  readonly isCancelled: () => boolean;
}

export interface TaskProcessorResult {
  readonly result?: Record<string, unknown>;
  readonly parkPlan?: Record<string, unknown>;
}

export interface TaskProcessor {
  readonly kind: string;
  execute(
    ctx: TaskExecutionContext
  ): Promise<TaskProcessorResult | Record<string, unknown> | null | void>;
}

export interface WorkerEngineOptions {
  readonly pool: pg.Pool;
  readonly workerId?: string;
  readonly leaseSeconds?: number;
  readonly heartbeatIntervalMs?: number;
}

export class WorkerEngine {
  readonly workerId: string;
  private readonly pool: pg.Pool;
  private readonly leaseSeconds: number;
  private readonly heartbeatIntervalMs: number;
  private readonly processors = new Map<string, TaskProcessor>();
  private running = false;

  constructor(options: WorkerEngineOptions) {
    this.pool = options.pool;
    this.workerId = options.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.leaseSeconds = options.leaseSeconds ?? 60;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;

    // Register built-in mock_noop processor
    this.registerProcessor({
      kind: "mock_noop",
      async execute(ctx) {
        return {
          ok: true,
          processedBy: ctx.workerId,
          executedAt: new Date().toISOString(),
        };
      },
    });
  }

  registerProcessor(processor: TaskProcessor): void {
    this.processors.set(processor.kind, processor);
  }

  /**
   * Directly processes a specific task by claiming it, running the processor,
   * sending periodic heartbeats, and completing/failing atomically.
   */
  async processTask(
    taskId: string,
    payload: Record<string, unknown> = {}
  ): Promise<{
    status: "succeeded" | "failed" | "awaiting_confirmation" | "cancelled" | "unclaimed";
    claim?: TaskClaimResult;
    result?: unknown;
    error?: string;
  }> {
    const claim = await TaskExecutionRepository.claimTask(
      this.pool,
      taskId,
      this.workerId,
      this.leaseSeconds
    );

    if (!claim) {
      return { status: "unclaimed" };
    }

    let isCancelRequested = claim.cancelRequested;
    let abortDueToFenceMismatch = false;

    // Start heartbeat interval
    const heartbeatTimer = setInterval(async () => {
      try {
        const res = await TaskExecutionRepository.heartbeat(
          this.pool,
          claim.id,
          this.workerId,
          claim.fenceToken,
          this.leaseSeconds
        );
        if (res.cancelRequested) {
          isCancelRequested = true;
        }
      } catch (err) {
        if (err instanceof FencingTokenMismatchError) {
          abortDueToFenceMismatch = true;
          if (heartbeatTimer) clearInterval(heartbeatTimer);
        }
      }
    }, this.heartbeatIntervalMs);

    try {
      if (isCancelRequested) {
        await TaskExecutionRepository.cancelTask(
          this.pool,
          claim.id,
          this.workerId,
          claim.fenceToken
        );
        return { status: "cancelled", claim };
      }

      const processor = this.processors.get(claim.kind);
      if (!processor) {
        await TaskExecutionRepository.failTask(
          this.pool,
          claim.id,
          this.workerId,
          claim.fenceToken,
          {
            code: "UNREGISTERED_PROCESSOR",
            message: `No processor registered for task kind: ${claim.kind}`,
          }
        );
        return {
          status: "failed",
          claim,
          error: `No processor registered for task kind: ${claim.kind}`,
        };
      }

      const ctx: TaskExecutionContext = {
        taskId: claim.id,
        kind: claim.kind,
        ownerScope: claim.ownerScope,
        attempt: claim.attempt,
        fenceToken: claim.fenceToken,
        workerId: this.workerId,
        payload,
        isCancelled: () => isCancelRequested || abortDueToFenceMismatch,
      };

      const outcome = await processor.execute(ctx);

      if (abortDueToFenceMismatch) {
        throw new FencingTokenMismatchError();
      }

      if (isCancelRequested) {
        await TaskExecutionRepository.cancelTask(
          this.pool,
          claim.id,
          this.workerId,
          claim.fenceToken
        );
        return { status: "cancelled", claim };
      }

      // Check if outcome requested parking for confirmation
      if (
        outcome &&
        typeof outcome === "object" &&
        "parkPlan" in outcome &&
        outcome.parkPlan
      ) {
        await TaskExecutionRepository.parkTask(
          this.pool,
          claim.id,
          this.workerId,
          claim.fenceToken,
          outcome.parkPlan as Record<string, unknown>
        );
        return {
          status: "awaiting_confirmation",
          claim,
          result: outcome.parkPlan,
        };
      }

      const resultObj =
        outcome && typeof outcome === "object" && "result" in outcome
          ? (outcome.result as Record<string, unknown>)
          : (outcome as Record<string, unknown> | null);

      await TaskExecutionRepository.completeTask(
        this.pool,
        claim.id,
        this.workerId,
        claim.fenceToken,
        resultObj ?? null
      );

      return { status: "succeeded", claim, result: resultObj };
    } catch (error) {
      if (error instanceof FencingTokenMismatchError) {
        return {
          status: "failed",
          claim,
          error: "Fencing token mismatch: task lost to another worker or lease expired",
        };
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);

      try {
        await TaskExecutionRepository.failTask(
          this.pool,
          claim.id,
          this.workerId,
          claim.fenceToken,
          {
            code: "EXECUTION_FAILED",
            message: errorMessage,
          }
        );
      } catch {
        // Ignore failure reporting error if fence already expired
      }

      return { status: "failed", claim, error: errorMessage };
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
  }
}
