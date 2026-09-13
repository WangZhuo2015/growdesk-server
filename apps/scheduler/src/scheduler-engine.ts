import pg from "pg";
import {
  TaskExecutionRepository,
  OutboxBatchItem,
} from "@growdesk/database";

export interface SchedulerEngineOptions {
  readonly pool: pg.Pool;
  readonly dispatchBatchSize?: number;
  readonly onDispatch?: (item: OutboxBatchItem) => Promise<void>;
}

export class SchedulerEngine {
  private readonly pool: pg.Pool;
  private readonly dispatchBatchSize: number;
  private readonly onDispatch?: (item: OutboxBatchItem) => Promise<void>;

  constructor(options: SchedulerEngineOptions) {
    this.pool = options.pool;
    this.dispatchBatchSize = options.dispatchBatchSize ?? 10;
    this.onDispatch = options.onDispatch;
  }

  /**
   * Dispatches pending outbox entries. Claims batch with FOR UPDATE SKIP LOCKED,
   * invokes onDispatch callback (e.g. pushes to queue or executes), and closes outbox row.
   */
  async dispatchBatch(): Promise<number> {
    const batch = await TaskExecutionRepository.claimNextOutboxBatch(
      this.pool,
      this.dispatchBatchSize
    );

    for (const item of batch) {
      if (this.onDispatch) {
        await this.onDispatch(item);
      }
      await TaskExecutionRepository.closeOutbox(this.pool, item.id);
    }

    return batch.length;
  }

  /**
   * Reconciles expired running tasks and stalled outbox entries.
   */
  async reconcile(): Promise<{
    recoveredCount: number;
    failedCount: number;
    requeuedOutboxCount: number;
  }> {
    return TaskExecutionRepository.reconcile(this.pool);
  }
}
