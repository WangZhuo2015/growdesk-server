import crypto from "node:crypto";
import {
  BabyAccessDeniedError,
  PrismaClient,
  RecordNotFoundError,
} from "@growdesk/database";
import type { UserPrincipal } from "@growdesk/domain";
import type {
  CreateVoiceLogRequest,
  VoiceLog,
  VoiceLogListQuery,
} from "@growdesk/contracts";

const UNREAD_WINDOW_MS = 24 * 60 * 60 * 1000;

type VoiceLogRow = {
  id: string;
  userId: string;
  familyId: string;
  babyId: string;
  prompt: string;
  reply: string;
  isAsync: boolean;
  isFastPath: boolean;
  acknowledged: boolean;
  createdAt: Date;
  baby: { id: string; nickname: string; gender: string } | null;
};

export class VoiceLogService {
  constructor(private readonly prisma: PrismaClient) {}

  private async assertBabyAccess(principal: UserPrincipal, babyId: string): Promise<{ id: string; familyId: string }> {
    const baby = await this.prisma.baby.findFirst({
      where: {
        id: babyId,
        deletedAt: null,
        family: {
          deletedAt: null,
          members: {
            some: {
              userId: principal.userId,
              status: "active",
              deletedAt: null,
            },
          },
        },
        members: {
          some: {
            userId: principal.userId,
            status: "active",
            deletedAt: null,
          },
        },
      },
      select: { id: true, familyId: true },
    });

    if (!baby) throw new BabyAccessDeniedError(babyId, "NOT_A_MEMBER");
    return baby;
  }

  private map(row: VoiceLogRow): VoiceLog {
    return {
      id: row.id,
      userId: row.userId,
      familyId: row.familyId,
      babyId: row.babyId,
      prompt: row.prompt,
      reply: row.reply,
      isAsync: row.isAsync,
      isFastPath: row.isFastPath,
      acknowledged: row.acknowledged,
      createdAt: row.createdAt.toISOString(),
      baby: row.baby
        ? { id: row.baby.id, nickname: row.baby.nickname, gender: row.baby.gender }
        : null,
    };
  }

  private readonly includeBaby = {
    baby: { select: { id: true, nickname: true, gender: true } },
  } as const;

  private scope(principal: UserPrincipal) {
    return {
      userId: principal.userId,
      baby: {
        members: {
          some: {
            userId: principal.userId,
            status: "active",
            deletedAt: null,
          },
        },
        family: {
          deletedAt: null,
          members: {
            some: {
              userId: principal.userId,
              status: "active",
              deletedAt: null,
            },
          },
        },
      },
    };
  }

  async create(principal: UserPrincipal, input: CreateVoiceLogRequest): Promise<{ data: VoiceLog }> {
    const baby = await this.assertBabyAccess(principal, input.babyId);
    const row = await this.prisma.agentVoiceLog.create({
      data: {
        id: crypto.randomUUID(),
        userId: principal.userId,
        familyId: baby.familyId,
        babyId: baby.id,
        prompt: input.prompt,
        reply: input.reply,
        isAsync: input.isAsync ?? false,
        isFastPath: input.isFastPath ?? false,
        acknowledged: input.acknowledged ?? false,
      },
      include: this.includeBaby,
    });
    return { data: this.map(row as VoiceLogRow) };
  }

  async list(principal: UserPrincipal, query: VoiceLogListQuery): Promise<
    { data: VoiceLog[]; page: { nextCursor: null } } | { data: VoiceLog | null }
  > {
    if (query.unreadAsync) {
      const row = await this.prisma.agentVoiceLog.findFirst({
        where: {
          ...this.scope(principal),
          isAsync: true,
          acknowledged: false,
          createdAt: { gte: new Date(Date.now() - UNREAD_WINDOW_MS) },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        include: this.includeBaby,
      });
      return { data: row ? this.map(row as VoiceLogRow) : null };
    }

    const limit = Math.min(query.limit ?? 20, 50);
    const rows = await this.prisma.agentVoiceLog.findMany({
      where: this.scope(principal),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      include: this.includeBaby,
    });
    return { data: rows.map((row) => this.map(row as VoiceLogRow)), page: { nextCursor: null } };
  }

  async get(principal: UserPrincipal, id: string): Promise<{ data: VoiceLog }> {
    const row = await this.prisma.agentVoiceLog.findFirst({
      where: { ...this.scope(principal), id },
      include: this.includeBaby,
    });
    if (!row) throw new RecordNotFoundError("AgentVoiceLog", id);
    return { data: this.map(row as VoiceLogRow) };
  }

  async acknowledge(principal: UserPrincipal, id: string, acknowledged: boolean): Promise<{ data: { success: true } }> {
    const result = await this.prisma.agentVoiceLog.updateMany({
      where: { ...this.scope(principal), id },
      data: { acknowledged },
    });
    if (result.count !== 1) throw new RecordNotFoundError("AgentVoiceLog", id);
    return { data: { success: true } };
  }
}
