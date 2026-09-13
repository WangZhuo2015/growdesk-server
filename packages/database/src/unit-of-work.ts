import { randomUUID } from "node:crypto";
import { PrismaClient, Prisma } from "./generated/client.js";
import { UserPrincipal } from "@growdesk/domain";
import {
  IdempotencyKeyReusedError,
  ConcurrencyConflictError,
  RecordNotFoundError,
  FamilyAccessDeniedError,
  BabyAccessDeniedError,
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
  readonly outboxEvents?: ReadonlyArray<OutboxMessage>;
}

export interface CommandExecutionResult<T> {
  readonly replayed: boolean;
  readonly result: T;
  readonly version: number;
  readonly familyCursor: string;
}

/**
 * Executes a family-scoped mutation within a strictly ordered transaction:
 * 1. Checks IdempotencyReceipt; returns cached result if matching hash, throws 409 if reused with different hash.
 * 2. Locks FamilySyncState FOR UPDATE to serialize commits in strict cursor order.
 * 3. Re-verifies principal authorization (FamilyMember and BabyMember) inside the held lock.
 * 4. Verifies version consistency (optimistic concurrency).
 * 5. Executes business mutation callback.
 * 6. Synchronously maintains TimelineEntry if baby-scoped.
 * 7. Increments FamilySyncState cursor and writes FamilyChange.
 * 8. Writes IdempotencyReceipt and TaskOutbox events.
 * 9. Atomically commits or rolls back completely on any failure.
 */
export async function executeFamilyUnitOfWork<T>(
  prisma: PrismaClient,
  command: FamilyCommandContext<T>
): Promise<CommandExecutionResult<T>> {
  const { principal, familyId, babyId } = command;

  return await prisma.$transaction(async (tx) => {
    // 1. Check IdempotencyReceipt
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
      // Re-verify authorization for replay
      const hasAccess = principal.familyMemberships.some(
        (m) => m.familyId === familyId && m.status === "active" && m.role !== "viewer"
      );
      if (!hasAccess) {
        throw new FamilyAccessDeniedError(familyId);
      }
      const summaryObj = existingReceipt.resultSummary as {
        familyCursor?: string;
        version?: number;
      } | null;
      return {
        replayed: true,
        result: existingReceipt.responseBody as T,
        version: summaryObj?.version ?? command.baseVersion ?? 1,
        familyCursor: summaryObj?.familyCursor ?? "0",
      };
    }

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

    // 3. Re-verify permissions with locked state
    const familyMember = await tx.familyMember.findUnique({
      where: {
        uq_family_members_family_user: {
          familyId,
          userId: principal.userId,
        },
      },
    });
    if (!familyMember || familyMember.status !== "active" || familyMember.role === "viewer") {
      throw new FamilyAccessDeniedError(familyId);
    }

    if (babyId) {
      const loadedBaby = await tx.baby.findUnique({
        where: {
          uq_babies_family_id_id: {
            familyId,
            id: babyId,
          },
        },
      });
      if (!loadedBaby || loadedBaby.deletedAt !== null) {
        throw new BabyAccessDeniedError(babyId, "BABY_SCOPE_MISMATCH");
      }

      const loadedBabyMember = await tx.babyMember.findUnique({
        where: {
          uq_baby_members_user_baby: {
            userId: principal.userId,
            babyId,
          },
        },
      });
      if (!loadedBabyMember || loadedBabyMember.status !== "active" || loadedBabyMember.familyId !== familyId) {
        throw new BabyAccessDeniedError(babyId, "BABY_ACCESS_DENIED");
      }
      if (loadedBabyMember.role !== "admin" && loadedBabyMember.role !== "member") {
        throw new BabyAccessDeniedError(babyId, "BABY_WRITE_DENIED");
      }
    }

    // 4. Concurrency and version check
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

    // 5. Execute business mutation callback
    const nextCursor = currentCursor + 1n;
    const mutation = await command.execute(tx, {
      familyId,
      babyId,
      nextCursor,
      nextVersion,
    });

    // 6. Maintain TimelineEntry if baby-scoped
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

    // 7. Advance FamilySyncState cursor and record FamilyChange
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

    // 8. Write IdempotencyReceipt
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

    // 9. Write TaskOutbox events
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
