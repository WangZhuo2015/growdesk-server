import crypto from "node:crypto";
import type { PrismaClient } from "@growdesk/database";
import {
  ScopedFeedingRepository,
  ScopedDiaperRepository,
  ScopedSleepRepository,
  ScopedFoodRepository,
  ScopedSupplementRepository,
  ScopedGrowthRepository,
  FamilyAccessDeniedError,
  RecordNotFoundError,
  ConcurrencyConflictError,
  SyncResetRequiredError,
  encodeSyncCursor,
  decodeSyncCursor,
} from "@growdesk/database";
import type { UserPrincipal } from "@growdesk/domain";
import type {
  SyncCommandBatchRequest,
  SyncCommandBatchResponse,
  SyncCommandResultItem,
  FamilyChangesResponse,
  UserChangesResponse,
  CreateSyncSnapshotResponse,
  SyncSnapshotResponse,
} from "@growdesk/contracts";

export interface SyncServiceOptions {
  readonly signingSecret?: string;
}

export class SyncService {
  private readonly feedingRepo: ScopedFeedingRepository;
  private readonly diaperRepo: ScopedDiaperRepository;
  private readonly sleepRepo: ScopedSleepRepository;
  private readonly foodRepo: ScopedFoodRepository;
  private readonly supplementRepo: ScopedSupplementRepository;
  private readonly growthRepo: ScopedGrowthRepository;
  private readonly signingSecret: string;

  constructor(
    private readonly prisma: PrismaClient,
    options: SyncServiceOptions = {}
  ) {
    this.feedingRepo = new ScopedFeedingRepository(prisma);
    this.diaperRepo = new ScopedDiaperRepository(prisma);
    this.sleepRepo = new ScopedSleepRepository(prisma);
    this.foodRepo = new ScopedFoodRepository(prisma);
    this.supplementRepo = new ScopedSupplementRepository(prisma);
    this.growthRepo = new ScopedGrowthRepository(prisma);
    this.signingSecret =
      options.signingSecret ||
      process.env.SESSION_SECRET ||
      "growdesk-default-sync-cursor-hmac-secret-32ch";
  }

  /**
   * Execute batch of offline mutation commands with per-command isolation.
   * Rejects entire batch with 422 if multiple commands target the same entity.
   */
  async executeSyncCommands(
    principal: UserPrincipal,
    request: SyncCommandBatchRequest
  ): Promise<SyncCommandBatchResponse> {
    const commands = request.commands;

    // 1. Check intra-batch dependencies: multiple commands for same entity in single wire batch are forbidden
    const seenEntities = new Set<string>();
    for (const cmd of commands) {
      if (seenEntities.has(cmd.entityId)) {
        const error = new Error(
          `Multiple commands targeting entity '${cmd.entityId}' in single batch are not allowed (BATCH_DEPENDENCY_UNRESOLVED)`
        );
        (error as { statusCode?: number; code?: string }).statusCode = 422;
        (error as { statusCode?: number; code?: string }).code =
          "BATCH_DEPENDENCY_UNRESOLVED";
        throw error;
      }
      seenEntities.add(cmd.entityId);
    }

    const results: SyncCommandResultItem[] = [];

    // 2. Process each command independently
    for (const cmd of commands) {
      try {
        const itemResult = await this.executeSingleCommand(principal, cmd);
        results.push(itemResult);
      } catch (err) {
        if (err instanceof ConcurrencyConflictError) {
          const currentVersion = await this.getCurrentEntityVersion(
            cmd.entityType,
            cmd.entityId
          );
          results.push({
            commandId: cmd.commandId,
            status: "conflict",
            entityId: cmd.entityId,
            version: null,
            familyCursor: null,
            conflict: {
              currentVersion: currentVersion !== null ? currentVersion.toString() : "0",
              currentEntity: {},
              reason: err.message,
            },
          });
        } else {
          const code =
            (err as { code?: string }).code ||
            (err as Error).name ||
            "COMMAND_ERROR";
          results.push({
            commandId: cmd.commandId,
            status: "error",
            entityId: cmd.entityId,
            version: null,
            familyCursor: null,
            error: {
              code,
              message: (err as Error).message,
            },
          });
        }
      }
    }

    return {
      data: {
        results,
      },
    };
  }

  private async executeSingleCommand(
    principal: UserPrincipal,
    cmd: SyncCommandBatchRequest["commands"][number]
  ): Promise<SyncCommandResultItem> {
    const {
      commandId,
      familyId,
      babyId,
      entityType,
      entityId,
      operation,
      baseVersion,
      payload,
    } = cmd;

    const requestHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          operation,
          entityType,
          id: entityId,
          familyId,
          babyId,
          baseVersion: baseVersion ? parseInt(baseVersion, 10) : null,
          payload,
        })
      )
      .digest("hex");

    const parsedBaseVersion = baseVersion ? parseInt(baseVersion, 10) : 1;

    let res: { replayed: boolean; version: number; familyCursor: string };

    switch (entityType) {
      case "feeding": {
        if (operation === "create") {
          res = await this.feedingRepo.create(principal, {
            commandId,
            requestHash,
            id: entityId,
            familyId,
            babyId,
            feedingType: String(payload.type || payload.feedingType || "formula"),
            occurredAt: new Date(
              String(payload.occurredAt || payload.timestamp || cmd.clientCreatedAt)
            ),
            amountMl: payload.amountMl !== undefined ? String(payload.amountMl) : null,
            leftMinutes: payload.leftMinutes !== undefined ? Number(payload.leftMinutes) : null,
            rightMinutes: payload.rightMinutes !== undefined ? Number(payload.rightMinutes) : null,
            spitUp: payload.spitUp ? "true" : "false",
            formulaProductId: payload.formulaProductId ? String(payload.formulaProductId) : null,
            notes: payload.notes ? String(payload.notes) : null,
          });
        } else if (operation === "update") {
          res = await this.feedingRepo.update(principal, {
            commandId,
            requestHash,
            id: entityId,
            familyId,
            babyId,
            baseVersion: parsedBaseVersion,
            feedingType: payload.type || payload.feedingType ? String(payload.type || payload.feedingType) : undefined,
            occurredAt: payload.occurredAt || payload.timestamp ? new Date(String(payload.occurredAt || payload.timestamp)) : undefined,
            amountMl: payload.amountMl !== undefined ? String(payload.amountMl) : undefined,
            leftMinutes: payload.leftMinutes !== undefined ? Number(payload.leftMinutes) : undefined,
            rightMinutes: payload.rightMinutes !== undefined ? Number(payload.rightMinutes) : undefined,
            spitUp: payload.spitUp !== undefined ? (payload.spitUp ? "true" : "false") : undefined,
            formulaProductId: payload.formulaProductId !== undefined ? (payload.formulaProductId ? String(payload.formulaProductId) : null) : undefined,
            notes: payload.notes !== undefined ? (payload.notes ? String(payload.notes) : null) : undefined,
          });
        } else {
          const delRes = await this.feedingRepo.delete(principal, {
            commandId,
            requestHash,
            id: entityId,
            familyId,
            babyId,
            baseVersion: parsedBaseVersion,
          });
          res = { replayed: false, version: delRes.version, familyCursor: delRes.familyCursor };
        }
        break;
      }

      case "diaper": {
        if (operation === "create") {
          res = await this.diaperRepo.create(principal, {
            commandId,
            requestHash,
            id: entityId,
            familyId,
            babyId,
            diaperType: String(payload.diaperType || payload.type || "pee"),
            occurredAt: new Date(
              String(payload.occurredAt || payload.timestamp || cmd.clientCreatedAt)
            ),
            poopColor: payload.poopColor ? String(payload.poopColor) : null,
            poopConsistency: payload.poopConsistency ? String(payload.poopConsistency) : null,
            notes: payload.notes ? String(payload.notes) : null,
          });
        } else if (operation === "update") {
          res = await this.diaperRepo.update(principal, {
            commandId,
            requestHash,
            id: entityId,
            familyId,
            babyId,
            baseVersion: parsedBaseVersion,
            diaperType: payload.diaperType || payload.type ? String(payload.diaperType || payload.type) : undefined,
            occurredAt: payload.occurredAt || payload.timestamp ? new Date(String(payload.occurredAt || payload.timestamp)) : undefined,
            poopColor: payload.poopColor !== undefined ? (payload.poopColor ? String(payload.poopColor) : null) : undefined,
            poopConsistency: payload.poopConsistency !== undefined ? (payload.poopConsistency ? String(payload.poopConsistency) : null) : undefined,
            notes: payload.notes !== undefined ? (payload.notes ? String(payload.notes) : null) : undefined,
          });
        } else {
          const delRes = await this.diaperRepo.delete(principal, {
            commandId,
            requestHash,
            id: entityId,
            familyId,
            babyId,
            baseVersion: parsedBaseVersion,
          });
          res = { replayed: false, version: delRes.version, familyCursor: delRes.familyCursor };
        }
        break;
      }

      case "sleep": {
        if (operation === "create") {
          res = await this.sleepRepo.create(principal, {
            commandId,
            requestHash,
            id: entityId,
            familyId,
            babyId,
            sleepType: String(payload.sleepType || payload.type || "nap"),
            startedAt: new Date(
              String(payload.startedAt || payload.startTime || cmd.clientCreatedAt)
            ),
            endedAt: payload.endedAt || payload.endTime ? new Date(String(payload.endedAt || payload.endTime)) : null,
            nightWakingCount: Number(payload.nightWakingCount ?? 0),
            notes: payload.notes ? String(payload.notes) : null,
          });
        } else if (operation === "update") {
          res = await this.sleepRepo.update(principal, {
            commandId,
            requestHash,
            id: entityId,
            familyId,
            babyId,
            baseVersion: parsedBaseVersion,
            sleepType: payload.sleepType || payload.type ? String(payload.sleepType || payload.type) : undefined,
            startedAt: payload.startedAt || payload.startTime ? new Date(String(payload.startedAt || payload.startTime)) : undefined,
            endedAt: payload.endedAt !== undefined ? (payload.endedAt ? new Date(String(payload.endedAt)) : null) : undefined,
            nightWakingCount: payload.nightWakingCount !== undefined ? Number(payload.nightWakingCount) : undefined,
            notes: payload.notes !== undefined ? (payload.notes ? String(payload.notes) : null) : undefined,
          });
        } else {
          const delRes = await this.sleepRepo.delete(principal, {
            commandId,
            requestHash,
            id: entityId,
            familyId,
            babyId,
            baseVersion: parsedBaseVersion,
          });
          res = { replayed: false, version: delRes.version, familyCursor: delRes.familyCursor };
        }
        break;
      }

      case "foodLog": {
        if (operation === "create") {
          res = await this.foodRepo.create(principal, {
            commandId,
            requestHash,
            id: entityId,
            familyId,
            babyId,
            recordDate: String(payload.recordDate || payload.date || cmd.clientCreatedAt.slice(0, 10)),
            mealType: String(payload.mealType || "lunch"),
            occurredAt: payload.occurredAt ? new Date(String(payload.occurredAt)) : null,
            foodItemIds: Array.isArray(payload.foodItemIds) ? payload.foodItemIds.map(String) : [],
            portionDescription: payload.portionDescription ? String(payload.portionDescription) : null,
            reaction: payload.reaction ? String(payload.reaction) : null,
            notes: payload.notes ? String(payload.notes) : null,
          });
        } else if (operation === "update") {
          res = await this.foodRepo.update(principal, {
            commandId,
            requestHash,
            id: entityId,
            familyId,
            babyId,
            baseVersion: parsedBaseVersion,
            recordDate: payload.recordDate || payload.date ? String(payload.recordDate || payload.date) : undefined,
            mealType: payload.mealType ? String(payload.mealType) : undefined,
            occurredAt: payload.occurredAt !== undefined ? (payload.occurredAt ? new Date(String(payload.occurredAt)) : null) : undefined,
            foodItemIds: Array.isArray(payload.foodItemIds) ? payload.foodItemIds.map(String) : undefined,
            portionDescription: payload.portionDescription !== undefined ? (payload.portionDescription ? String(payload.portionDescription) : null) : undefined,
            reaction: payload.reaction !== undefined ? (payload.reaction ? String(payload.reaction) : null) : undefined,
            notes: payload.notes !== undefined ? (payload.notes ? String(payload.notes) : null) : undefined,
          });
        } else {
          const delRes = await this.foodRepo.delete(principal, {
            commandId,
            requestHash,
            id: entityId,
            familyId,
            babyId,
            baseVersion: parsedBaseVersion,
          });
          res = { replayed: false, version: delRes.version, familyCursor: delRes.familyCursor };
        }
        break;
      }

      case "supplementRecord": {
        if (operation === "create") {
          res = await this.supplementRepo.create(principal, {
            commandId,
            requestHash,
            id: entityId,
            familyId,
            babyId,
            supplementName: String(payload.supplementName || payload.name || "Supplement"),
            occurredAt: new Date(String(payload.occurredAt || payload.timestamp || cmd.clientCreatedAt)),
            amount: payload.amount !== undefined && payload.amount !== null ? String(payload.amount) : null,
            notes: payload.notes ? String(payload.notes) : null,
          });
        } else if (operation === "update") {
          res = await this.supplementRepo.update(principal, {
            commandId,
            requestHash,
            id: entityId,
            familyId,
            babyId,
            baseVersion: parsedBaseVersion,
            supplementName: payload.supplementName || payload.name ? String(payload.supplementName || payload.name) : undefined,
            occurredAt: payload.occurredAt || payload.timestamp ? new Date(String(payload.occurredAt || payload.timestamp)) : undefined,
            amount: payload.amount !== undefined ? (payload.amount ? String(payload.amount) : null) : undefined,
            notes: payload.notes !== undefined ? (payload.notes ? String(payload.notes) : null) : undefined,
          });
        } else {
          const delRes = await this.supplementRepo.delete(principal, {
            commandId,
            requestHash,
            id: entityId,
            familyId,
            babyId,
            baseVersion: parsedBaseVersion,
          });
          res = { replayed: false, version: delRes.version, familyCursor: delRes.familyCursor };
        }
        break;
      }

      case "growthMeasurement": {
        if (operation === "create") {
          res = await this.growthRepo.create(principal, {
            commandId,
            requestHash,
            id: entityId,
            familyId,
            babyId,
            measurementDate: String(payload.measurementDate || payload.date || cmd.clientCreatedAt.slice(0, 10)),
            weightKg: payload.weightKg !== undefined && payload.weightKg !== null ? String(payload.weightKg) : null,
            heightCm: payload.heightCm !== undefined && payload.heightCm !== null ? String(payload.heightCm) : null,
            headCircumferenceCm: payload.headCircumferenceCm !== undefined && payload.headCircumferenceCm !== null ? String(payload.headCircumferenceCm) : null,
            attachmentId: payload.attachmentId ? String(payload.attachmentId) : null,
            notes: payload.notes ? String(payload.notes) : null,
          });
        } else if (operation === "update") {
          res = await this.growthRepo.update(principal, {
            commandId,
            requestHash,
            id: entityId,
            familyId,
            babyId,
            baseVersion: parsedBaseVersion,
            measurementDate: payload.measurementDate || payload.date ? String(payload.measurementDate || payload.date) : undefined,
            weightKg: payload.weightKg !== undefined ? (payload.weightKg ? String(payload.weightKg) : null) : undefined,
            heightCm: payload.heightCm !== undefined ? (payload.heightCm ? String(payload.heightCm) : null) : undefined,
            headCircumferenceCm: payload.headCircumferenceCm !== undefined ? (payload.headCircumferenceCm ? String(payload.headCircumferenceCm) : null) : undefined,
            attachmentId: payload.attachmentId !== undefined ? (payload.attachmentId ? String(payload.attachmentId) : null) : undefined,
            notes: payload.notes !== undefined ? (payload.notes ? String(payload.notes) : null) : undefined,
          });
        } else {
          const delRes = await this.growthRepo.delete(principal, {
            commandId,
            requestHash,
            id: entityId,
            familyId,
            babyId,
            baseVersion: parsedBaseVersion,
          });
          res = { replayed: false, version: delRes.version, familyCursor: delRes.familyCursor };
        }
        break;
      }

      default: {
        throw new Error(`Unsupported entityType: ${entityType}`);
      }
    }

    return {
      commandId,
      status: res.replayed ? "replayed" : "applied",
      entityId,
      version: res.version.toString(),
      familyCursor: res.familyCursor,
    };
  }

  private async getCurrentEntityVersion(
    entityType: string,
    entityId: string
  ): Promise<number | null> {
    switch (entityType) {
      case "feeding": {
        const row = await this.prisma.feedingRecord.findUnique({
          where: { id: entityId },
          select: { version: true },
        });
        return row ? row.version : null;
      }
      case "diaper": {
        const row = await this.prisma.diaperRecord.findUnique({
          where: { id: entityId },
          select: { version: true },
        });
        return row ? row.version : null;
      }
      case "sleep": {
        const row = await this.prisma.sleepRecord.findUnique({
          where: { id: entityId },
          select: { version: true },
        });
        return row ? row.version : null;
      }
      case "foodLog": {
        const row = await this.prisma.foodRecord.findUnique({
          where: { id: entityId },
          select: { version: true },
        });
        return row ? row.version : null;
      }
      case "supplementRecord": {
        const row = await this.prisma.supplementRecord.findUnique({
          where: { id: entityId },
          select: { version: true },
        });
        return row ? row.version : null;
      }
      case "growthMeasurement": {
        const row = await this.prisma.growthMeasurement.findUnique({
          where: { id: entityId },
          select: { version: true },
        });
        return row ? row.version : null;
      }
      default:
        return null;
    }
  }

  /**
   * Incremental change feed for family scope with signed cursor and BabyMember security filtering.
   */
  async getFamilyChanges(
    principal: UserPrincipal,
    familyId: string,
    query: { cursor?: string; limit?: number } = {}
  ): Promise<FamilyChangesResponse> {
    // 1. Verify family membership
    const hasMembership = principal.familyMemberships.some(
      (m) => m.familyId === familyId && m.status === "active"
    );
    if (!hasMembership) {
      throw new FamilyAccessDeniedError(familyId);
    }

    // 2. Fetch or create FamilySyncState
    let syncState = await this.prisma.familySyncState.findUnique({
      where: { familyId },
    });
    if (!syncState) {
      syncState = await this.prisma.familySyncState.create({
        data: {
          familyId,
          epoch: crypto.randomUUID(),
          cursor: 0n,
        },
      });
    }

    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    let position = 0n;
    let highWater = syncState.cursor;

    if (query.cursor && query.cursor !== "0") {
      const decoded = decodeSyncCursor(
        query.cursor,
        this.signingSecret,
        "family",
        familyId
      );

      if (decoded.epoch !== syncState.epoch) {
        throw new SyncResetRequiredError(
          `Sync epoch mismatch: client has '${decoded.epoch}', server is at '${syncState.epoch}'`
        );
      }

      position = BigInt(decoded.position);
      if (decoded.mode === "tail") {
        // Discovered tail: advance highWater to server's current cursor
        highWater = syncState.cursor;
      } else {
        // Page mode: keep fixed highWater
        highWater = BigInt(decoded.highWater);
      }
    }

    // 3. Query family_changes in bounded (position, highWater] range
    const rawChanges = await this.prisma.familyChange.findMany({
      where: {
        familyId,
        cursor: {
          gt: position,
          lte: highWater,
        },
      },
      orderBy: { cursor: "asc" },
      take: limit + 1,
    });

    const hasMore = rawChanges.length > limit;
    const pageChanges = hasMore ? rawChanges.slice(0, limit) : rawChanges;

    // 4. Filter changes by active BabyMember permission (prevent metadata leakage)
    const accessibleBabyMembers = await this.prisma.babyMember.findMany({
      where: {
        userId: principal.userId,
        familyId,
        status: "active",
      },
      select: { babyId: true },
    });
    const accessibleBabyIds = new Set(accessibleBabyMembers.map((b) => b.babyId));

    const filteredChanges = pageChanges.filter((c) => {
      const p = c.payload as Record<string, unknown> | null;
      if (p && typeof p === "object" && "babyId" in p && p.babyId) {
        return accessibleBabyIds.has(String(p.babyId));
      }
      return true;
    });

    // 5. Calculate next cursor mode and position
    let nextPosition: bigint;
    let nextMode: "page" | "tail";

    if (pageChanges.length > 0) {
      const lastItem = pageChanges[pageChanges.length - 1]!;
      nextPosition = lastItem.cursor;
      if (hasMore && lastItem.cursor < highWater) {
        nextMode = "page";
      } else {
        nextMode = "tail";
        nextPosition = highWater;
      }
    } else {
      nextPosition = highWater;
      nextMode = "tail";
    }

    const nextCursor = encodeSyncCursor(
      {
        scope: "family",
        scopeId: familyId,
        epoch: syncState.epoch,
        position: nextPosition.toString(),
        highWater: highWater.toString(),
        mode: nextMode,
        schemaVersion: 1,
      },
      this.signingSecret
    );

    return {
      scope: "family",
      epoch: syncState.epoch,
      changes: filteredChanges.map((c) => ({
        cursor: c.cursor.toString(),
        entityType: c.entityType,
        entityId: c.entityId,
        version: c.version.toString(),
        operation: (c.op === "delete" ? "delete" : "upsert") as "upsert" | "delete",
        payload: (c.payload as Record<string, unknown>) || {},
      })),
      nextCursor,
      highWater: highWater.toString(),
      hasMore,
    };
  }

  /**
   * Incremental change feed for current user scope.
   */
  async getUserChanges(
    principal: UserPrincipal,
    query: { cursor?: string; limit?: number } = {}
  ): Promise<UserChangesResponse> {
    const userId = principal.userId;

    let syncState = await this.prisma.userSyncState.findUnique({
      where: { userId },
    });
    if (!syncState) {
      syncState = await this.prisma.userSyncState.create({
        data: {
          userId,
          epoch: crypto.randomUUID(),
          cursor: 0n,
        },
      });
    }

    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    let position = 0n;
    let highWater = syncState.cursor;

    if (query.cursor && query.cursor !== "0") {
      const decoded = decodeSyncCursor(
        query.cursor,
        this.signingSecret,
        "user",
        userId
      );

      if (decoded.epoch !== syncState.epoch) {
        throw new SyncResetRequiredError(
          `Sync epoch mismatch: client has '${decoded.epoch}', server is at '${syncState.epoch}'`
        );
      }

      position = BigInt(decoded.position);
      if (decoded.mode === "tail") {
        highWater = syncState.cursor;
      } else {
        highWater = BigInt(decoded.highWater);
      }
    }

    const rawChanges = await this.prisma.userChange.findMany({
      where: {
        userId,
        cursor: {
          gt: position,
          lte: highWater,
        },
      },
      orderBy: { cursor: "asc" },
      take: limit + 1,
    });

    const hasMore = rawChanges.length > limit;
    const pageChanges = hasMore ? rawChanges.slice(0, limit) : rawChanges;

    let nextPosition: bigint;
    let nextMode: "page" | "tail";

    if (pageChanges.length > 0) {
      const lastItem = pageChanges[pageChanges.length - 1]!;
      nextPosition = lastItem.cursor;
      if (hasMore && lastItem.cursor < highWater) {
        nextMode = "page";
      } else {
        nextMode = "tail";
        nextPosition = highWater;
      }
    } else {
      nextPosition = highWater;
      nextMode = "tail";
    }

    const nextCursor = encodeSyncCursor(
      {
        scope: "user",
        scopeId: userId,
        epoch: syncState.epoch,
        position: nextPosition.toString(),
        highWater: highWater.toString(),
        mode: nextMode,
        schemaVersion: 1,
      },
      this.signingSecret
    );

    return {
      scope: "user",
      epoch: syncState.epoch,
      changes: pageChanges.map((c) => ({
        cursor: c.cursor.toString(),
        entityType: c.entityType,
        entityId: c.entityId,
        version: c.version.toString(),
        operation: (c.op === "delete" ? "delete" : "upsert") as "upsert" | "delete",
        payload: (c.payload as Record<string, unknown>) || {},
      })),
      nextCursor,
      highWater: highWater.toString(),
      hasMore,
    };
  }

  /**
   * Queue bootstrap snapshot creation for a family.
   */
  async createFamilySnapshot(
    principal: UserPrincipal,
    familyId: string
  ): Promise<CreateSyncSnapshotResponse> {
    const hasMembership = principal.familyMemberships.some(
      (m) => m.familyId === familyId && m.status === "active"
    );
    if (!hasMembership) {
      throw new FamilyAccessDeniedError(familyId);
    }

    let syncState = await this.prisma.familySyncState.findUnique({
      where: { familyId },
    });
    if (!syncState) {
      syncState = await this.prisma.familySyncState.create({
        data: {
          familyId,
          epoch: crypto.randomUUID(),
          cursor: 0n,
        },
      });
    }

    const snapshotId = crypto.randomUUID();

    await this.prisma.syncSnapshot.create({
      data: {
        id: snapshotId,
        scope: "family",
        scopeId: familyId,
        epoch: syncState.epoch,
        highWater: syncState.cursor,
        status: "queued",
        pageCount: 0,
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      },
    });

    await this.prisma.taskExecution.create({
      data: {
        id: crypto.randomUUID(),
        kind: "sync_snapshot_family",
        ownerScope: familyId,
        status: "queued",
        attempt: 0,
        maxAttempts: 3,
      },
    });

    return {
      data: {
        snapshotId,
        status: "queued",
      },
    };
  }

  /**
   * Retrieve status and manifest of a family snapshot.
   */
  async getFamilySnapshot(
    principal: UserPrincipal,
    familyId: string,
    snapshotId: string
  ): Promise<SyncSnapshotResponse> {
    const hasMembership = principal.familyMemberships.some(
      (m) => m.familyId === familyId && m.status === "active"
    );
    if (!hasMembership) {
      throw new FamilyAccessDeniedError(familyId);
    }

    const snapshot = await this.prisma.syncSnapshot.findFirst({
      where: {
        id: snapshotId,
        scope: "family",
        scopeId: familyId,
      },
    });

    if (!snapshot) {
      throw new RecordNotFoundError("sync_snapshot", snapshotId);
    }

    return {
      data: {
        id: snapshot.id,
        scope: snapshot.scope,
        epoch: snapshot.epoch,
        highWater: snapshot.highWater.toString(),
        status: snapshot.status as "queued" | "processing" | "ready" | "failed",
        pageCount: snapshot.pageCount,
        expiresAt: snapshot.expiresAt.toISOString(),
      },
    };
  }
}
