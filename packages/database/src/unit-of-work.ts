import { randomUUID } from "node:crypto";
import { PrismaClient, Prisma } from "./generated/client.js";
import { UserPrincipal } from "@growdesk/domain";
import {
  IdempotencyKeyReusedError,
  ConcurrencyConflictError,
  RecordNotFoundError,
  FamilyAccessDeniedError,
  BabyAccessDeniedError,
  DatabaseError,
} from "./errors.js";

export type TransactionClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export interface OutboxMessage {
  readonly type: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
  readonly phaseKey?: string;
}

export interface MutationResult<T> {
  readonly result: T;
  readonly payload: Record<string, unknown>;
  readonly summary: string;
  readonly occurredAt: Date;
}

/**
 * A legacy client id may identify a row materialized before the current
 * IdempotencyReceipt protocol existed.  The lookup runs after the family
 * lock and current database authorization checks, so a compatibility replay
 * cannot bypass a permission revocation or advance sync state.
 */
export interface LegacyReplayResult<T> {
  readonly result: T;
  readonly version: number;
}

export class LegacyIdempotencyGoneError extends DatabaseError {
  constructor(commandId: string) {
    super(
      `The legacy idempotency key refers to a deleted record: ${commandId}`,
      "LEGACY_IDEMPOTENCY_GONE",
      409
    );
  }
}

export interface FamilyCommandContext<T> {
  readonly principal: UserPrincipal;
  readonly familyId: string;
  readonly babyId?: string;
  readonly commandId: string;
  readonly requestHash: string;
  readonly operation: "create" | "update" | "delete" | "restore";
  readonly entityType: string;
  readonly entityId: string;
  readonly baseVersion: number | null;
  readonly getExistingVersion?: (tx: TransactionClient) => Promise<number | null>;
  readonly execute: (
    tx: TransactionClient,
    meta: {
      familyId: string;
      babyId?: string;
      nextCursor: bigint;
      nextVersion: number;
    }
  ) => Promise<MutationResult<T>>;
  /**
   * Optional create-only compatibility lookup for rows materialized from the
   * old PWA.  The callback may throw IdempotencyKeyReusedError for a payload
   * mismatch, or LegacyIdempotencyGoneError when the imported row was
   * soft-deleted.  A non-null result is returned without a new mutation,
   * timeline entry, family change, cursor advance, or receipt.
   */
  readonly findLegacyReplay?: (
    tx: TransactionClient
  ) => Promise<LegacyReplayResult<T> | null>;
  readonly outboxEvents?: ReadonlyArray<OutboxMessage>;
}

export interface CommandExecutionResult<T> {
  readonly replayed: boolean;
  readonly result: T;
  readonly version: number;
  readonly familyCursor: string;
}

interface AuthorizationScope {
  readonly principal: UserPrincipal;
  readonly familyId: string;
  readonly babyId?: string;
}

async function assertCurrentAuthorization(
  tx: TransactionClient,
  scope: AuthorizationScope
): Promise<void> {
  const family = await tx.family.findUnique({
    where: { id: scope.familyId },
    select: { deletedAt: true },
  });
  if (!family || family.deletedAt !== null) {
    throw new FamilyAccessDeniedError(scope.familyId);
  }

  const familyMember = await tx.familyMember.findUnique({
    where: {
      uq_family_members_family_user: {
        familyId: scope.familyId,
        userId: scope.principal.userId,
      },
    },
  });
  if (
    !familyMember ||
    familyMember.status !== "active" ||
    familyMember.role === "viewer" ||
    familyMember.deletedAt !== null
  ) {
    throw new FamilyAccessDeniedError(scope.familyId);
  }

  if (!scope.babyId) return;

  const loadedBaby = await tx.baby.findUnique({
    where: {
      uq_babies_family_id_id: {
        familyId: scope.familyId,
        id: scope.babyId,
      },
    },
  });
  if (!loadedBaby || loadedBaby.deletedAt !== null) {
    throw new BabyAccessDeniedError(scope.babyId, "BABY_SCOPE_MISMATCH");
  }

  const loadedBabyMember = await tx.babyMember.findUnique({
    where: {
      uq_baby_members_user_baby: {
        userId: scope.principal.userId,
        babyId: scope.babyId,
      },
    },
  });
  if (
    !loadedBabyMember ||
    loadedBabyMember.status !== "active" ||
    loadedBabyMember.deletedAt !== null ||
    loadedBabyMember.familyId !== scope.familyId
  ) {
    throw new BabyAccessDeniedError(scope.babyId, "BABY_ACCESS_DENIED");
  }
  if (loadedBabyMember.role !== "admin" && loadedBabyMember.role !== "member") {
    throw new BabyAccessDeniedError(scope.babyId, "BABY_WRITE_DENIED");
  }
}

/**
 * Executes a family-scoped mutation within a strictly ordered transaction:
 * 1. Verifies current DB authorization before taking a family lock.
 * 2. Locks FamilySyncState FOR UPDATE to serialize commits in strict cursor order.
 * 3. Re-verifies current DB authorization inside the held lock.
 * 4. Checks an optional legacy client-id replay under the same lock and authorization.
 * 5. Checks IdempotencyReceipt; returns cached result if matching hash, throws 409 if reused with different hash.
 * 6. Verifies version consistency (optimistic concurrency).
 * 7. Executes business mutation callback.
 * 8. Synchronously maintains TimelineEntry if baby-scoped.
 * 9. Increments FamilySyncState cursor and writes FamilyChange.
 * 10. Writes IdempotencyReceipt and TaskOutbox events.
 * 11. Atomically commits or rolls back completely on any failure.
 */
export async function executeFamilyUnitOfWork<T>(
  prisma: PrismaClient,
  command: FamilyCommandContext<T>
): Promise<CommandExecutionResult<T>> {
  const { principal, familyId, babyId } = command;

  return await prisma.$transaction(async (tx) => {
    // 1. Reject missing/deleted or currently unauthorized scopes before any
    // FamilySyncState insert/lock.  This prevents an invalid family id from
    // surfacing a foreign-key 500 and prevents an unauthorized caller from
    // holding the family serialization lock.
    await assertCurrentAuthorization(tx, { principal, familyId, babyId });

    // 2. Lock FamilySyncState FOR UPDATE (lock ordering: FamilySyncState row lock)
    await tx.$executeRaw`
      INSERT INTO family_sync_states (family_id, epoch, cursor, created_at, updated_at)
      VALUES (${familyId}, ${randomUUID()}, 0, NOW(), NOW())
      ON CONFLICT (family_id) DO NOTHING
    `;

    const syncStateRows = await tx.$queryRaw<Array<{ cursor: bigint; epoch: string }>>`
      SELECT cursor, epoch FROM family_sync_states WHERE family_id = ${familyId} FOR UPDATE
    `;
    const currentCursor = syncStateRows[0]?.cursor ?? 0n;

    // 3. Re-verify permissions with locked state.  All replay paths must use
    // current database rows rather than the principal's login-time snapshot.
    await assertCurrentAuthorization(tx, { principal, familyId, babyId });

    // 4. A pre-cutover legacy client id has no IdempotencyReceipt.  Let the
    // care repository return the imported row here, after auth and locking,
    // without touching cursor/change/timeline/receipt state.  This precedes
    // the family-scoped receipt lookup so a receipt created for another baby
    // cannot strengthen the old per-baby client-id scope.
    if (command.operation === "create" && command.findLegacyReplay) {
      const legacyReplay = await command.findLegacyReplay(tx);
      if (legacyReplay) {
        return {
          replayed: true,
          result: legacyReplay.result,
          version: legacyReplay.version,
          familyCursor: currentCursor.toString(),
        };
      }
    }

    // 5. Check IdempotencyReceipt only after the state lock and current DB
    // authorization.  The lock makes same-key concurrent transactions see
    // the committed winner instead of both racing to insert the receipt.
    const existingReceipt = await tx.idempotencyReceipt.findUnique({
      where: {
        pk_idempotency_receipts: {
          actorId: principal.userId,
          scopeId: familyId,
          commandId: command.commandId,
        },
      },
    });

    if (existingReceipt) {
      if (existingReceipt.requestHash.trim() !== command.requestHash.trim()) {
        throw new IdempotencyKeyReusedError(command.commandId);
      }
      const summaryObj = existingReceipt.resultSummary as {
        familyCursor?: string;
        version?: number;
      } | null;
      return {
        replayed: true,
        result: existingReceipt.responseBody as T,
        version: summaryObj?.version ?? command.baseVersion ?? 1,
        familyCursor: summaryObj?.familyCursor ?? currentCursor.toString(),
      };
    }

    // 6. Concurrency and version check
    let nextVersion = 1;
    if (command.getExistingVersion) {
      const existingVersion = await command.getExistingVersion(tx);
      if (command.operation === "create") {
        if (existingVersion !== null) {
          throw new ConcurrencyConflictError(
            `Entity ${command.entityType} with ID ${command.entityId} already exists`
          );
        }
        nextVersion = 1;
      } else {
        if (command.baseVersion === null) {
          throw new ConcurrencyConflictError(
            `baseVersion is required for ${command.operation} on ${command.entityType}`
          );
        }
        if (existingVersion === null) {
          throw new RecordNotFoundError(command.entityType, command.entityId);
        }
        if (existingVersion !== command.baseVersion) {
          throw new ConcurrencyConflictError(
            `Version conflict on ${command.entityType}:${command.entityId} - baseVersion ${command.baseVersion} != current ${existingVersion}`
          );
        }
        nextVersion = existingVersion + 1;
      }
    } else if (command.baseVersion !== null) {
      nextVersion = command.baseVersion + 1;
    }

    // 7. Execute business mutation callback
    const nextCursor = currentCursor + 1n;
    const mutation = await command.execute(tx, {
      familyId,
      babyId,
      nextCursor,
      nextVersion,
    });

    // 8. Maintain TimelineEntry if baby-scoped
    if (babyId) {
      await tx.timelineEntry.upsert({
        where: {
          uq_timeline_entries_entity: {
            familyId,
            babyId,
            entityType: command.entityType,
            entityId: command.entityId,
          },
        },
        create: {
          id: randomUUID(),
          familyId,
          babyId,
          entityType: command.entityType,
          entityId: command.entityId,
          occurredAt: mutation.occurredAt,
          summary: mutation.summary,
          details: mutation.payload as Prisma.InputJsonValue,
          version: nextVersion,
          deletedAt: command.operation === "delete" ? new Date() : null,
        },
        update: {
          occurredAt: mutation.occurredAt,
          summary: mutation.summary,
          details: mutation.payload as Prisma.InputJsonValue,
          version: nextVersion,
          deletedAt: command.operation === "delete" ? new Date() : null,
          updatedAt: new Date(),
        },
      });
    }

    // 9. Advance FamilySyncState cursor and record FamilyChange
    await tx.familySyncState.update({
      where: { familyId },
      data: {
        cursor: nextCursor,
        updatedAt: new Date(),
      },
    });

    const changePayload: Record<string, unknown> = {
      ...(mutation.payload && typeof mutation.payload === "object"
        ? (mutation.payload as Record<string, unknown>)
        : {}),
      ...(command.babyId ? { babyId: command.babyId } : {}),
    };

    await tx.familyChange.create({
      data: {
        familyId,
        cursor: nextCursor,
        entityType: command.entityType,
        entityId: command.entityId,
        version: nextVersion,
        op: command.operation === "delete" ? "delete" : "upsert",
        payload: changePayload as Prisma.InputJsonValue,
        schemaVersion: 1,
        createdAt: new Date(),
      },
    });

    // 10. Write IdempotencyReceipt
    await tx.idempotencyReceipt.create({
      data: {
        actorId: principal.userId,
        scopeId: familyId,
        commandId: command.commandId,
        requestHash: command.requestHash,
        resultCode: 200,
        resultSummary: {
          summary: mutation.summary,
          familyCursor: nextCursor.toString(),
          version: nextVersion,
        } as Prisma.InputJsonValue,
        responseBody: mutation.result as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
    });

    // 11. Write TaskOutbox events
    if (command.outboxEvents && command.outboxEvents.length > 0) {
      for (const event of command.outboxEvents) {
        await tx.taskOutbox.create({
          data: {
            id: randomUUID(),
            type: event.type,
            aggregateId: event.aggregateId,
            payloadVersion: 1,
            payload: event.payload as Prisma.InputJsonValue,
            phaseKey: event.phaseKey ?? "initial",
            dispatchState: "active",
            nextDispatchAt: new Date(),
            createdAt: new Date(),
          },
        });
      }
    }

    return {
      replayed: false,
      result: mutation.result,
      version: nextVersion,
      familyCursor: nextCursor.toString(),
    };
  });
}
