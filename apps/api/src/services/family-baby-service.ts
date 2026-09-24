import crypto from "node:crypto";
import { PrismaClient, type Prisma } from "@growdesk/database";
import {
  type UserPrincipal,
  type FamilyRole,
  type BabyRole,
  type MembershipStatus,
  type BabyAccessContext,
  canRevokeBabyMember,
} from "@growdesk/domain";
import type {
  Family as ContractFamily,
  CreateFamilyRequest,
  UpdateFamilyRequest,
  FamilyMember as ContractFamilyMember,
  CreateFamilyInviteResponse,
  PreviewFamilyInviteResponse,
  JoinFamilyResponse,
  Baby as ContractBaby,
  CreateBabyRequest,
  UpdateBabyRequest,
  BabyMember as ContractBabyMember,
  BabyMemberRole,
} from "@growdesk/contracts";

const INVITE_SECRET = process.env.INVITE_SECRET || "growdesk-invite-pepper-v1";

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

async function verifyAvatarReference(tx: Prisma.TransactionClient, avatarUrl: string | null | undefined, familyId: string, babyId: string, userId: string) {
  if (!avatarUrl) return;
  const match = /^\/api\/attachments\/([a-f0-9-]{36})$/i.exec(avatarUrl);
  if (!match) throw new ApiError(422, "INVALID_AVATAR", "Use an uploaded avatar attachment");
  await tx.$queryRaw`SELECT id FROM public.attachments WHERE id = ${match[1]} FOR UPDATE`;
  const attachment = await tx.attachment.findFirst({ where: { id: match[1], familyId, purpose: "avatar", status: "ready", deletedAt: null, OR: [{ babyId }, { babyId: null, uploaderId: userId }] } });
  if (!attachment) throw new ApiError(403, "AVATAR_ACCESS_DENIED", "Avatar attachment is not available for this baby");
  if (!attachment.babyId) await tx.attachment.update({ where: { id: attachment.id }, data: { babyId } });
}

/** Helper to convert Prisma Family to Contract Family */
export function toContractFamily(family: {
  id: string;
  name: string;
  timezone: string;
  createdAt: Date;
  updatedAt: Date;
}): ContractFamily {
  return {
    id: family.id,
    name: family.name,
    timeZone: family.timezone,
    createdAt: family.createdAt.toISOString(),
    updatedAt: family.updatedAt.toISOString(),
  };
}

function toContractFamilyMemberRole(role: string): ContractFamilyMember["role"] {
  if (role === "admin" || role === "member" || role === "viewer") return role;
  // The database CHECK constraint should make this unreachable. Do not
  // silently turn an unknown permission into a weaker-looking member role.
  throw new ApiError(500, "INVALID_FAMILY_MEMBER_ROLE", "Family member has an unsupported role");
}

export function toDbGender(gender?: "boy" | "girl" | "other"): string {
  if (gender === "girl") return "female";
  if (gender === "boy") return "male";
  return "unspecified";
}

export function toContractGender(dbGender: string): "boy" | "girl" | "other" {
  if (dbGender === "female") return "girl";
  if (dbGender === "male") return "boy";
  return "other";
}

/** Helper to convert Prisma Baby to Contract Baby */
export function toContractBaby(baby: {
  id: string;
  familyId: string;
  nickname: string;
  birthDate: Date;
  gender: string;
  avatarUrl: string | null;
  gestationalAge: number | null;
  createdAt: Date;
  updatedAt: Date;
}): ContractBaby {
  const birthDateStr = baby.birthDate.toISOString().slice(0, 10);
  const gestationalWeeks = baby.gestationalAge != null ? Math.floor(baby.gestationalAge / 7) : null;
  const gestationalDays = baby.gestationalAge != null ? baby.gestationalAge % 7 : null;

  return {
    id: baby.id,
    familyId: baby.familyId,
    name: baby.nickname,
    birthDate: birthDateStr,
    gender: toContractGender(baby.gender),
    avatarUrl: baby.avatarUrl,
    gestationalWeeks,
    gestationalDays,
    createdAt: baby.createdAt.toISOString(),
    updatedAt: baby.updatedAt.toISOString(),
  };
}

export class FamilyBabyService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * List all families accessible to current user.
   */
  async listFamilies(principal: UserPrincipal): Promise<ContractFamily[]> {
    const memberships = await this.prisma.familyMember.findMany({
      where: {
        userId: principal.userId,
        status: "active",
        deletedAt: null,
      },
      include: {
        family: true,
      },
      orderBy: {
        createdAt: "asc",
      },
    });

    return memberships
      .filter((m) => m.family && m.family.deletedAt === null)
      .map((m) => toContractFamily(m.family));
  }

  /**
   * Create a new family with current user as admin.
   * Lock order: UserSyncState(principal.userId)
   */
  async createFamily(principal: UserPrincipal, data: CreateFamilyRequest): Promise<ContractFamily> {
    const familyId = crypto.randomUUID();
    const memberId = crypto.randomUUID();
    const epoch = crypto.randomUUID();
    const now = new Date();
    const timeZone = data.timeZone || "Asia/Shanghai";

    const family = await this.prisma.$transaction(async (tx) => {
      // 1. Lock UserSyncState
      await tx.$executeRaw`
        SELECT cursor FROM user_sync_states WHERE user_id = ${principal.userId} FOR UPDATE
      `;

      // 2. Create Family
      const createdFamily = await tx.family.create({
        data: {
          id: familyId,
          name: data.name,
          timezone: timeZone,
          createdAt: now,
          updatedAt: now,
        },
      });

      // 3. Create Admin FamilyMember
      await tx.familyMember.create({
        data: {
          id: memberId,
          familyId,
          userId: principal.userId,
          role: "admin",
          relation: "parent",
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      });

      // 4. Create FamilySyncState
      await tx.familySyncState.create({
        data: {
          familyId,
          epoch,
          cursor: 0n,
          permissionVersion: 1,
          createdAt: now,
          updatedAt: now,
        },
      });

      return createdFamily;
    });

    return toContractFamily(family);
  }

  /**
   * Get family details by ID.
   * Verifies caller has active membership in this family.
   */
  async getFamily(principal: UserPrincipal, familyId: string): Promise<ContractFamily> {
    const membership = await this.prisma.familyMember.findUnique({
      where: {
        uq_family_members_family_user: {
          familyId,
          userId: principal.userId,
        },
      },
      include: {
        family: true,
      },
    });

    if (!membership || membership.status !== "active" || membership.deletedAt !== null) {
      throw new ApiError(404, "FAMILY_NOT_FOUND", `Family '${familyId}' not found or access denied`);
    }

    if (!membership.family || membership.family.deletedAt !== null) {
      throw new ApiError(404, "FAMILY_NOT_FOUND", `Family '${familyId}' not found`);
    }

    return toContractFamily(membership.family);
  }

  /**
   * Update family settings (admin only).
   */
  async updateFamily(principal: UserPrincipal, familyId: string, data: UpdateFamilyRequest): Promise<ContractFamily> {
    const now = new Date();

    const family = await this.prisma.$transaction(async (tx) => {
      // 1. Lock FamilySyncState
      await tx.$executeRaw`
        INSERT INTO family_sync_states (family_id, epoch, cursor, permission_version, created_at, updated_at)
        VALUES (${familyId}, ${crypto.randomUUID()}, 0, 1, NOW(), NOW())
        ON CONFLICT (family_id) DO NOTHING
      `;
      await tx.$executeRaw`
        SELECT cursor FROM family_sync_states WHERE family_id = ${familyId} FOR UPDATE
      `;

      // 2. Check admin authorization
      const member = await tx.familyMember.findUnique({
        where: {
          uq_family_members_family_user: {
            familyId,
            userId: principal.userId,
          },
        },
      });

      if (!member || member.status !== "active" || member.deletedAt !== null) {
        throw new ApiError(404, "FAMILY_NOT_FOUND", `Family '${familyId}' not found or access denied`);
      }

      if (member.role !== "admin") {
        throw new ApiError(403, "FORBIDDEN", "Only family administrators can update family settings");
      }

      const existingFamily = await tx.family.findUnique({
        where: { id: familyId },
      });
      if (!existingFamily || existingFamily.deletedAt !== null) {
        throw new ApiError(404, "FAMILY_NOT_FOUND", `Family '${familyId}' not found`);
      }

      const updated = await tx.family.update({
        where: { id: familyId },
        data: {
          name: data.name ?? undefined,
          timezone: data.timeZone ?? undefined,
          version: existingFamily.version + 1,
          updatedAt: now,
        },
      });

      // Increment permissionVersion
      await tx.familySyncState.update({
        where: { familyId },
        data: {
          permissionVersion: { increment: 1 },
          updatedAt: now,
        },
      });

      return updated;
    });

    return toContractFamily(family);
  }

  /**
   * Create an invitation code for a family (admin only).
   */
  async createFamilyInvite(
    principal: UserPrincipal,
    familyId: string,
    expiresInDays: number = 7,
  ): Promise<CreateFamilyInviteResponse["data"]> {
    const callerMember = await this.prisma.familyMember.findUnique({
      where: {
        uq_family_members_family_user: {
          familyId,
          userId: principal.userId,
        },
      },
    });

    if (!callerMember || callerMember.status !== "active" || callerMember.deletedAt !== null) {
      throw new ApiError(404, "FAMILY_NOT_FOUND", `Family '${familyId}' not found or access denied`);
    }

    if (callerMember.role !== "admin") {
      throw new ApiError(403, "FORBIDDEN", "Only family administrators can generate invite codes");
    }

    const inviteCode = crypto.randomBytes(6).toString("hex").toUpperCase();
    const codeHmac = crypto.createHmac("sha256", INVITE_SECRET).update(inviteCode).digest("hex");
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
    const now = new Date();

    await this.prisma.legacyInviteCodeMapping.create({
      data: {
        codeHmac,
        familyId,
        keyId: "v1",
        usageCount: 0,
        maxUses: 1,
        expiresAt,
        createdAt: now,
      },
    });

    return {
      inviteCode,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Public preview of family invite without revealing members.
   */
  async previewFamilyInvite(code: string): Promise<PreviewFamilyInviteResponse["data"]> {
    const codeHmac = crypto.createHmac("sha256", INVITE_SECRET).update(code.trim()).digest("hex");
    const now = new Date();

    const invite = await this.prisma.legacyInviteCodeMapping.findUnique({
      where: { codeHmac },
      include: {
        family: {
          include: {
            members: {
              where: { role: "admin", status: "active", deletedAt: null },
              include: { user: true },
              orderBy: { createdAt: "asc" },
              take: 1,
            },
          },
        },
      },
    });

    if (!invite || invite.revokedAt !== null || invite.expiresAt <= now || invite.usageCount >= invite.maxUses) {
      throw new ApiError(404, "INVITE_NOT_FOUND", "Invitation code is invalid or has expired");
    }

    if (!invite.family || invite.family.deletedAt !== null) {
      throw new ApiError(404, "INVITE_NOT_FOUND", "Associated family no longer exists");
    }

    const inviterName = invite.family.members[0]?.user.displayName || "Family Administrator";

    return {
      familyName: invite.family.name,
      inviterName,
      expiresAt: invite.expiresAt.toISOString(),
    };
  }

  /**
   * Join a family using an invitation code.
   * Atomic join with lock on FamilySyncState.
   */
  async joinFamily(principal: UserPrincipal, inviteCode: string): Promise<JoinFamilyResponse["data"]> {
    const codeHmac = crypto.createHmac("sha256", INVITE_SECRET).update(inviteCode.trim()).digest("hex");
    const now = new Date();

    return await this.prisma.$transaction(async (tx) => {
      // 1. Validate invite code
      const invite = await tx.legacyInviteCodeMapping.findUnique({
        where: { codeHmac },
      });

      if (!invite || invite.revokedAt !== null || invite.expiresAt <= now || invite.usageCount >= invite.maxUses) {
        throw new ApiError(404, "INVITE_NOT_FOUND", "Invitation code is invalid or has expired");
      }

      const familyId = invite.familyId;

      // 2. Lock FamilySyncState
      await tx.$executeRaw`
        INSERT INTO family_sync_states (family_id, epoch, cursor, permission_version, created_at, updated_at)
        VALUES (${familyId}, ${crypto.randomUUID()}, 0, 1, NOW(), NOW())
        ON CONFLICT (family_id) DO NOTHING
      `;
      await tx.$executeRaw`
        SELECT cursor FROM family_sync_states WHERE family_id = ${familyId} FOR UPDATE
      `;

      // 3. Re-check invite under lock
      const lockedInvite = await tx.legacyInviteCodeMapping.findUnique({
        where: { codeHmac },
      });
      if (!lockedInvite || lockedInvite.revokedAt !== null || lockedInvite.expiresAt <= now || lockedInvite.usageCount >= lockedInvite.maxUses) {
        throw new ApiError(404, "INVITE_NOT_FOUND", "Invitation code is invalid or has expired");
      }

      const family = await tx.family.findUnique({
        where: { id: familyId },
      });
      if (!family || family.deletedAt !== null) {
        throw new ApiError(404, "FAMILY_NOT_FOUND", "Family not found");
      }

      // 4. Check existing membership (idempotent join)
      const existingMember = await tx.familyMember.findUnique({
        where: {
          uq_family_members_family_user: {
            familyId,
            userId: principal.userId,
          },
        },
      });

      let role: "admin" | "member";

      if (existingMember) {
        if (existingMember.status === "active" && existingMember.deletedAt === null) {
          // Already active member
          role = existingMember.role === "admin" ? "admin" : "member";
        } else {
          // Reactivate revoked member
          await tx.familyMember.update({
            where: { id: existingMember.id },
            data: {
              status: "active",
              role: "member",
              deletedAt: null,
              updatedAt: now,
            },
          });
          role = "member";
        }
      } else {
        await tx.familyMember.create({
          data: {
            id: crypto.randomUUID(),
            familyId,
            userId: principal.userId,
            role: "member",
            relation: "parent",
            status: "active",
            createdAt: now,
            updatedAt: now,
          },
        });
        role = "member";
      }

      // Increment usage count and permissionVersion
      await tx.legacyInviteCodeMapping.update({
        where: { codeHmac },
        data: {
          usageCount: { increment: 1 },
        },
      });

      await tx.familySyncState.update({
        where: { familyId },
        data: {
          permissionVersion: { increment: 1 },
          updatedAt: now,
        },
      });

      return {
        family: toContractFamily(family),
        role,
      };
    });
  }

  /**
   * List all members in a family.
   */
  async listFamilyMembers(principal: UserPrincipal, familyId: string): Promise<ContractFamilyMember[]> {
    const callerMember = await this.prisma.familyMember.findUnique({
      where: {
        uq_family_members_family_user: {
          familyId,
          userId: principal.userId,
        },
      },
    });

    if (!callerMember || callerMember.status !== "active" || callerMember.deletedAt !== null) {
      throw new ApiError(403, "FORBIDDEN", `Access denied to family '${familyId}'`);
    }

    const members = await this.prisma.familyMember.findMany({
      where: {
        familyId,
        status: "active",
        deletedAt: null,
      },
      include: {
        user: true,
      },
      orderBy: {
        createdAt: "asc",
      },
    });

    return members.map((m) => ({
      id: m.id,
      userId: m.userId,
      familyId: m.familyId,
      role: toContractFamilyMemberRole(m.role),
      username: m.user.username,
      displayName: m.user.displayName,
      relation: m.relation,
      joinedAt: m.createdAt.toISOString(),
    }));
  }

  /**
   * Update family member role (admin only).
   * Safeguard: cannot demote the last active family admin.
   */
  async updateFamilyMember(
    principal: UserPrincipal,
    familyId: string,
    targetUserId: string,
    newRole: "admin" | "member",
  ): Promise<{ success: true }> {
    const now = new Date();

    return await this.prisma.$transaction(async (tx) => {
      // 1. Lock FamilySyncState
      await tx.$executeRaw`
        INSERT INTO family_sync_states (family_id, epoch, cursor, permission_version, created_at, updated_at)
        VALUES (${familyId}, ${crypto.randomUUID()}, 0, 1, NOW(), NOW())
        ON CONFLICT (family_id) DO NOTHING
      `;
      await tx.$executeRaw`
        SELECT cursor FROM family_sync_states WHERE family_id = ${familyId} FOR UPDATE
      `;

      // 2. Caller must be admin
      const caller = await tx.familyMember.findUnique({
        where: {
          uq_family_members_family_user: {
            familyId,
            userId: principal.userId,
          },
        },
      });

      if (!caller || caller.status !== "active" || caller.deletedAt !== null || caller.role !== "admin") {
        throw new ApiError(403, "FORBIDDEN", "Only family administrators can update member roles");
      }

      // 3. Target must exist and be active
      const target = await tx.familyMember.findUnique({
        where: {
          uq_family_members_family_user: {
            familyId,
            userId: targetUserId,
          },
        },
      });

      if (!target || target.status !== "active" || target.deletedAt !== null) {
        throw new ApiError(404, "MEMBER_NOT_FOUND", "Target family member not found");
      }

      // 4. Last family admin protection
      if (target.role === "admin" && newRole !== "admin") {
        const otherAdmins = await tx.familyMember.count({
          where: {
            familyId,
            status: "active",
            deletedAt: null,
            role: "admin",
            userId: { not: targetUserId },
          },
        });

        if (otherAdmins === 0) {
          throw new ApiError(409, "LAST_FAMILY_ADMIN_PROTECTION", "Cannot demote the last active family administrator");
        }
      }

      // 5. Update role
      await tx.familyMember.update({
        where: { id: target.id },
        data: {
          role: newRole,
          updatedAt: now,
          version: target.version + 1,
        },
      });

      // Increment permissionVersion
      await tx.familySyncState.update({
        where: { familyId },
        data: {
          permissionVersion: { increment: 1 },
          updatedAt: now,
        },
      });

      return { success: true };
    });
  }

  /**
   * Remove member from family (or leave family).
   * Safeguards:
   * 1. Cannot remove last active family admin.
   * 2. Cannot remove caregiver who is the last active baby admin for any baby in this family.
   */
  async removeFamilyMember(
    principal: UserPrincipal,
    familyId: string,
    targetUserId: string,
  ): Promise<{ removed: true }> {
    const now = new Date();

    return await this.prisma.$transaction(async (tx) => {
      // 1. Lock FamilySyncState
      await tx.$executeRaw`
        INSERT INTO family_sync_states (family_id, epoch, cursor, permission_version, created_at, updated_at)
        VALUES (${familyId}, ${crypto.randomUUID()}, 0, 1, NOW(), NOW())
        ON CONFLICT (family_id) DO NOTHING
      `;
      await tx.$executeRaw`
        SELECT cursor FROM family_sync_states WHERE family_id = ${familyId} FOR UPDATE
      `;

      // 2. Authorization: either target themselves (leaving) OR active family admin
      const isSelf = principal.userId === targetUserId;
      const caller = await tx.familyMember.findUnique({
        where: {
          uq_family_members_family_user: {
            familyId,
            userId: principal.userId,
          },
        },
      });

      if (!caller || caller.status !== "active" || caller.deletedAt !== null) {
        throw new ApiError(403, "FORBIDDEN", "Access denied to family");
      }

      if (!isSelf && caller.role !== "admin") {
        throw new ApiError(403, "FORBIDDEN", "Only family administrators can remove other members");
      }

      const target = await tx.familyMember.findUnique({
        where: {
          uq_family_members_family_user: {
            familyId,
            userId: targetUserId,
          },
        },
      });

      if (!target || target.status !== "active" || target.deletedAt !== null) {
        throw new ApiError(404, "MEMBER_NOT_FOUND", "Target family member not found");
      }

      // 3. Safeguard: Last family admin protection
      if (target.role === "admin") {
        const otherAdmins = await tx.familyMember.count({
          where: {
            familyId,
            status: "active",
            deletedAt: null,
            role: "admin",
            userId: { not: targetUserId },
          },
        });

        if (otherAdmins === 0) {
          throw new ApiError(409, "LAST_FAMILY_ADMIN_PROTECTION", "Cannot remove the last active family administrator");
        }
      }

      // 4. Safeguard: Last baby admin protection across all babies in this family
      const familyBabies = await tx.baby.findMany({
        where: { familyId, deletedAt: null },
      });

      const allFamilyMembers = await tx.familyMember.findMany({
        where: { familyId, deletedAt: null },
      });

      for (const baby of familyBabies) {
        const targetBabyMember = await tx.babyMember.findUnique({
          where: {
            uq_baby_members_user_baby: {
              userId: targetUserId,
              babyId: baby.id,
            },
          },
        });

        if (targetBabyMember && targetBabyMember.status === "active" && targetBabyMember.role === "admin") {
          const allBabyMembers = await tx.babyMember.findMany({
            where: { babyId: baby.id, deletedAt: null },
          });

          const domainContext: BabyAccessContext = {
            familyId,
            babyId: baby.id,
            loadedBaby: { id: baby.id, familyId: baby.familyId },
          };

          const domainCallerPrincipal: UserPrincipal = {
            userId: principal.userId,
            username: principal.username,
            sessionId: principal.sessionId,
            familyMemberships: allFamilyMembers
              .filter((fm) => fm.status === "active")
              .map((fm) => ({ familyId: fm.familyId, role: fm.role as FamilyRole, status: fm.status as MembershipStatus })),
            babyMemberships: allBabyMembers
              .filter((bm) => bm.status === "active")
              .map((bm) => ({ userId: bm.userId, babyId: bm.babyId, familyId: bm.familyId, role: bm.role as BabyRole, status: bm.status as MembershipStatus })),
          };

          const allowed = canRevokeBabyMember(
            domainCallerPrincipal,
            domainContext,
            {
              userId: targetBabyMember.userId,
              babyId: targetBabyMember.babyId,
              familyId: targetBabyMember.familyId,
              role: targetBabyMember.role as BabyRole,
              status: targetBabyMember.status as MembershipStatus,
            },
            allBabyMembers.map((bm) => ({
              userId: bm.userId,
              babyId: bm.babyId,
              familyId: bm.familyId,
              role: bm.role as BabyRole,
              status: bm.status as MembershipStatus,
            })),
            allFamilyMembers.map((fm) => ({
              userId: fm.userId,
              familyId: fm.familyId,
              role: fm.role as FamilyRole,
              status: fm.status as MembershipStatus,
            })),
          );

          if (!allowed && !isSelf) {
            throw new ApiError(
              409,
              "LAST_BABY_ADMIN_PROTECTION",
              `Cannot remove caregiver who is the last active admin for baby '${baby.nickname}'. Transfer baby admin role first.`,
            );
          } else if (!allowed && isSelf) {
            // Self leaving but is last baby admin
            throw new ApiError(
              409,
              "LAST_BABY_ADMIN_PROTECTION",
              `Cannot leave family while being the last active admin for baby '${baby.nickname}'. Transfer baby admin role first.`,
            );
          }
        }
      }

      // 5. Revoke FamilyMember and cascade revoke BabyMember rows in this family
      await tx.familyMember.update({
        where: { id: target.id },
        data: {
          status: "revoked",
          deletedAt: now,
          updatedAt: now,
          version: target.version + 1,
        },
      });

      await tx.babyMember.updateMany({
        where: {
          familyId,
          userId: targetUserId,
          status: "active",
        },
        data: {
          status: "revoked",
          deletedAt: now,
          updatedAt: now,
        },
      });

      // Increment permissionVersion
      await tx.familySyncState.update({
        where: { familyId },
        data: {
          permissionVersion: { increment: 1 },
          updatedAt: now,
        },
      });

      return { removed: true };
    });
  }

  // ==========================================
  // Baby Management & Authorization
  // ==========================================

  /**
   * List babies in family visible to current user.
   * CRITICAL SECURITY INVARIANT (08 & 09):
   * Users only see babies they have an explicit active BabyMember row for!
   */
  async listFamilyBabies(principal: UserPrincipal, familyId: string): Promise<ContractBaby[]> {
    const callerMember = await this.prisma.familyMember.findUnique({
      where: {
        uq_family_members_family_user: {
          familyId,
          userId: principal.userId,
        },
      },
    });

    if (!callerMember || callerMember.status !== "active" || callerMember.deletedAt !== null) {
      throw new ApiError(403, "FORBIDDEN", `Access denied to family '${familyId}'`);
    }

    const babies = await this.prisma.baby.findMany({
      where: {
        familyId,
        deletedAt: null,
        members: {
          some: {
            userId: principal.userId,
            status: "active",
            deletedAt: null,
          },
        },
      },
      orderBy: {
        createdAt: "asc",
      },
    });

    return babies.map(toContractBaby);
  }

  /**
   * Create a new baby profile in a family.
   * Caller must be family admin or member (viewer cannot create baby).
   * Atomically creates Baby and creator's BabyMember(admin) row.
   */
  async createFamilyBaby(principal: UserPrincipal, familyId: string, data: CreateBabyRequest): Promise<ContractBaby> {
    const now = new Date();
    const babyId = crypto.randomUUID();
    const babyMemberId = crypto.randomUUID();

    const gestationalWeeks = data.gestationalWeeks ?? null;
    const gestationalDays = data.gestationalDays ?? null;
    const gestationalAge = (gestationalWeeks != null)
      ? gestationalWeeks * 7 + (gestationalDays ?? 0)
      : null;

    const baby = await this.prisma.$transaction(async (tx) => {
      // 1. Lock FamilySyncState
      await tx.$executeRaw`
        INSERT INTO family_sync_states (family_id, epoch, cursor, permission_version, created_at, updated_at)
        VALUES (${familyId}, ${crypto.randomUUID()}, 0, 1, NOW(), NOW())
        ON CONFLICT (family_id) DO NOTHING
      `;
      await tx.$executeRaw`
        SELECT cursor FROM family_sync_states WHERE family_id = ${familyId} FOR UPDATE
      `;

      // 2. Caller must have active FamilyMember with role admin or member
      const caller = await tx.familyMember.findUnique({
        where: {
          uq_family_members_family_user: {
            familyId,
            userId: principal.userId,
          },
        },
      });

      if (!caller || caller.status !== "active" || caller.deletedAt !== null) {
        throw new ApiError(403, "FORBIDDEN", `Access denied to family '${familyId}'`);
      }

      if (caller.role === "viewer") {
        throw new ApiError(403, "FORBIDDEN", "Viewer role cannot create babies in family");
      }

      // 3. Create Baby
      const createdBaby = await tx.baby.create({
        data: {
          id: babyId,
          familyId,
          nickname: data.name,
          birthDate: new Date(data.birthDate),
          gender: toDbGender(data.gender),
          avatarUrl: data.avatarUrl ?? null,
          gestationalAge,
          createdAt: now,
          updatedAt: now,
        },
      });

      await verifyAvatarReference(tx, data.avatarUrl, familyId, babyId, principal.userId);

      // 4. Create Creator's BabyMember (admin)
      await tx.babyMember.create({
        data: {
          id: babyMemberId,
          familyId,
          babyId,
          userId: principal.userId,
          role: "admin",
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      });

      // 5. Increment permissionVersion
      await tx.familySyncState.update({
        where: { familyId },
        data: {
          permissionVersion: { increment: 1 },
          updatedAt: now,
        },
      });

      return createdBaby;
    });

    return toContractBaby(baby);
  }

  /**
   * Get baby profile by ID.
   * Authorization: active FamilyMember AND active BabyMember.
   * Fails closed with 404 to avoid leaking baby existence across families.
   */
  async getBaby(principal: UserPrincipal, babyId: string): Promise<ContractBaby> {
    const baby = await this.prisma.baby.findUnique({
      where: { id: babyId },
    });

    if (!baby || baby.deletedAt !== null) {
      throw new ApiError(404, "BABY_NOT_FOUND", `Baby '${babyId}' not found`);
    }

    const familyMember = await this.prisma.familyMember.findUnique({
      where: {
        uq_family_members_family_user: {
          familyId: baby.familyId,
          userId: principal.userId,
        },
      },
    });

    if (!familyMember || familyMember.status !== "active" || familyMember.deletedAt !== null) {
      throw new ApiError(404, "BABY_NOT_FOUND", `Baby '${babyId}' not found`);
    }

    const babyMember = await this.prisma.babyMember.findUnique({
      where: {
        uq_baby_members_user_baby: {
          userId: principal.userId,
          babyId: baby.id,
        },
      },
    });

    if (!babyMember || babyMember.status !== "active" || babyMember.deletedAt !== null) {
      throw new ApiError(404, "BABY_NOT_FOUND", `Baby '${babyId}' not found`);
    }

    return toContractBaby(baby);
  }

  /**
   * Update baby profile details.
   * Authorization: active FamilyMember (not viewer) AND active BabyMember (admin or member).
   */
  async updateBaby(principal: UserPrincipal, babyId: string, data: UpdateBabyRequest): Promise<ContractBaby> {
    const now = new Date();

    return await this.prisma.$transaction(async (tx) => {
      const baby = await tx.baby.findUnique({
        where: { id: babyId },
      });

      if (!baby || baby.deletedAt !== null) {
        throw new ApiError(404, "BABY_NOT_FOUND", `Baby '${babyId}' not found`);
      }

      // 1. Lock FamilySyncState
      await tx.$executeRaw`
        SELECT cursor FROM family_sync_states WHERE family_id = ${baby.familyId} FOR UPDATE
      `;

      // 2. Authorization check
      const familyMember = await tx.familyMember.findUnique({
        where: {
          uq_family_members_family_user: {
            familyId: baby.familyId,
            userId: principal.userId,
          },
        },
      });

      if (!familyMember || familyMember.status !== "active" || familyMember.deletedAt !== null) {
        throw new ApiError(404, "BABY_NOT_FOUND", `Baby '${babyId}' not found`);
      }

      if (familyMember.role === "viewer") {
        throw new ApiError(403, "FORBIDDEN", "Family viewers cannot modify baby details");
      }

      const babyMember = await tx.babyMember.findUnique({
        where: {
          uq_baby_members_user_baby: {
            userId: principal.userId,
            babyId: baby.id,
          },
        },
      });

      if (!babyMember || babyMember.status !== "active" || babyMember.deletedAt !== null) {
        throw new ApiError(404, "BABY_NOT_FOUND", `Baby '${babyId}' not found`);
      }

      if (babyMember.role !== "admin" && babyMember.role !== "member") {
        throw new ApiError(403, "FORBIDDEN", "Baby viewers cannot modify baby details");
      }

      if (data.avatarUrl !== undefined && data.avatarUrl !== baby.avatarUrl) await verifyAvatarReference(tx, data.avatarUrl, baby.familyId, baby.id, principal.userId);

      // Calculate gestational age if updated
      let gestationalAge = baby.gestationalAge;
      if (data.gestationalWeeks !== undefined || data.gestationalDays !== undefined) {
        const weeks = data.gestationalWeeks !== undefined ? data.gestationalWeeks : (baby.gestationalAge != null ? Math.floor(baby.gestationalAge / 7) : null);
        const days = data.gestationalDays !== undefined ? data.gestationalDays : (baby.gestationalAge != null ? baby.gestationalAge % 7 : null);
        gestationalAge = weeks != null ? weeks * 7 + (days ?? 0) : null;
      }

      const updatedBaby = await tx.baby.update({
        where: { id: babyId },
        data: {
          nickname: data.name ?? undefined,
          birthDate: data.birthDate ? new Date(data.birthDate) : undefined,
          gender: data.gender ? toDbGender(data.gender) : undefined,
          avatarUrl: data.avatarUrl !== undefined ? data.avatarUrl : undefined,
          gestationalAge,
          version: baby.version + 1,
          updatedAt: now,
        },
      });

      // Increment permissionVersion
      await tx.familySyncState.update({
        where: { familyId: baby.familyId },
        data: {
          permissionVersion: { increment: 1 },
          updatedAt: now,
        },
      });

      return toContractBaby(updatedBaby);
    });
  }

  /**
   * List caregivers assigned to baby.
   * Authorization: active FamilyMember AND active BabyMember.
   */
  async listBabyMembers(principal: UserPrincipal, babyId: string): Promise<ContractBabyMember[]> {
    const baby = await this.prisma.baby.findUnique({
      where: { id: babyId },
    });

    if (!baby || baby.deletedAt !== null) {
      throw new ApiError(404, "BABY_NOT_FOUND", `Baby '${babyId}' not found`);
    }

    const familyMember = await this.prisma.familyMember.findUnique({
      where: {
        uq_family_members_family_user: {
          familyId: baby.familyId,
          userId: principal.userId,
        },
      },
    });

    if (!familyMember || familyMember.status !== "active" || familyMember.deletedAt !== null) {
      throw new ApiError(404, "BABY_NOT_FOUND", `Baby '${babyId}' not found`);
    }

    const babyMember = await this.prisma.babyMember.findUnique({
      where: {
        uq_baby_members_user_baby: {
          userId: principal.userId,
          babyId: baby.id,
        },
      },
    });

    if (!babyMember || babyMember.status !== "active" || babyMember.deletedAt !== null) {
      throw new ApiError(404, "BABY_NOT_FOUND", `Baby '${babyId}' not found`);
    }

    const members = await this.prisma.babyMember.findMany({
      where: {
        babyId,
        status: "active",
        deletedAt: null,
      },
      include: {
        user: true,
      },
      orderBy: {
        createdAt: "asc",
      },
    });

    return members.map((m) => ({
      userId: m.userId,
      babyId: m.babyId,
      familyId: m.familyId,
      role: (m.role === "admin" || m.role === "viewer" ? m.role : "member") as BabyMemberRole,
      displayName: m.user.displayName,
      joinedAt: m.createdAt.toISOString(),
    }));
  }

  /**
   * Add a caregiver to a baby.
   * Caller must be baby admin and non-viewer family member.
   * Target must already be an active family member.
   */
  async addBabyMember(
    principal: UserPrincipal,
    babyId: string,
    targetUserId: string,
    role: BabyMemberRole = "member",
  ): Promise<{ success: true }> {
    const now = new Date();

    return await this.prisma.$transaction(async (tx) => {
      const baby = await tx.baby.findUnique({
        where: { id: babyId },
      });

      if (!baby || baby.deletedAt !== null) {
        throw new ApiError(404, "BABY_NOT_FOUND", `Baby '${babyId}' not found`);
      }

      // 1. Lock FamilySyncState
      await tx.$executeRaw`
        SELECT cursor FROM family_sync_states WHERE family_id = ${baby.familyId} FOR UPDATE
      `;

      // 2. Caller must be active family member (not viewer) and baby admin
      const callerFamilyMember = await tx.familyMember.findUnique({
        where: {
          uq_family_members_family_user: {
            familyId: baby.familyId,
            userId: principal.userId,
          },
        },
      });

      if (!callerFamilyMember || callerFamilyMember.status !== "active" || callerFamilyMember.deletedAt !== null) {
        throw new ApiError(403, "FORBIDDEN", "Access denied to family");
      }

      if (callerFamilyMember.role === "viewer") {
        throw new ApiError(403, "FORBIDDEN", "Family viewers cannot manage baby caregivers");
      }

      const callerBabyMember = await tx.babyMember.findUnique({
        where: {
          uq_baby_members_user_baby: {
            userId: principal.userId,
            babyId: baby.id,
          },
        },
      });

      if (!callerBabyMember || callerBabyMember.status !== "active" || callerBabyMember.deletedAt !== null || callerBabyMember.role !== "admin") {
        throw new ApiError(403, "FORBIDDEN", "Only baby administrators can add caregivers to this baby");
      }

      // 3. Target must be an active family member
      const targetFamilyMember = await tx.familyMember.findUnique({
        where: {
          uq_family_members_family_user: {
            familyId: baby.familyId,
            userId: targetUserId,
          },
        },
      });

      if (!targetFamilyMember || targetFamilyMember.status !== "active" || targetFamilyMember.deletedAt !== null) {
        throw new ApiError(400, "TARGET_NOT_IN_FAMILY", "Caregiver must be an active member of this family before being assigned to baby");
      }

      // 4. Upsert BabyMember
      const existingBabyMember = await tx.babyMember.findUnique({
        where: {
          uq_baby_members_user_baby: {
            userId: targetUserId,
            babyId: baby.id,
          },
        },
      });

      if (existingBabyMember) {
        await tx.babyMember.update({
          where: { id: existingBabyMember.id },
          data: {
            role,
            status: "active",
            deletedAt: null,
            updatedAt: now,
            version: existingBabyMember.version + 1,
          },
        });
      } else {
        await tx.babyMember.create({
          data: {
            id: crypto.randomUUID(),
            familyId: baby.familyId,
            babyId: baby.id,
            userId: targetUserId,
            role,
            status: "active",
            createdAt: now,
            updatedAt: now,
          },
        });
      }

      // Increment permissionVersion
      await tx.familySyncState.update({
        where: { familyId: baby.familyId },
        data: {
          permissionVersion: { increment: 1 },
          updatedAt: now,
        },
      });

      return { success: true };
    });
  }

  /**
   * Revoke caregiver from baby.
   * Safeguard: cannot revoke the last active baby admin! (enforced by domain canRevokeBabyMember).
   */
  async removeBabyMember(
    principal: UserPrincipal,
    babyId: string,
    targetUserId: string,
  ): Promise<{ removed: true }> {
    const now = new Date();

    return await this.prisma.$transaction(async (tx) => {
      const baby = await tx.baby.findUnique({
        where: { id: babyId },
      });

      if (!baby || baby.deletedAt !== null) {
        throw new ApiError(404, "BABY_NOT_FOUND", `Baby '${babyId}' not found`);
      }

      // 1. Lock FamilySyncState
      await tx.$executeRaw`
        SELECT cursor FROM family_sync_states WHERE family_id = ${baby.familyId} FOR UPDATE
      `;

      // 2. Authorization: either target themselves (leaving care) OR baby admin
      const isSelf = principal.userId === targetUserId;

      const callerFamilyMember = await tx.familyMember.findUnique({
        where: {
          uq_family_members_family_user: {
            familyId: baby.familyId,
            userId: principal.userId,
          },
        },
      });

      if (!callerFamilyMember || callerFamilyMember.status !== "active" || callerFamilyMember.deletedAt !== null) {
        throw new ApiError(403, "FORBIDDEN", "Access denied to family");
      }

      const callerBabyMember = await tx.babyMember.findUnique({
        where: {
          uq_baby_members_user_baby: {
            userId: principal.userId,
            babyId: baby.id,
          },
        },
      });

      if (!callerBabyMember || callerBabyMember.status !== "active" || callerBabyMember.deletedAt !== null) {
        throw new ApiError(403, "FORBIDDEN", "Access denied to baby");
      }

      if (!isSelf && callerBabyMember.role !== "admin") {
        throw new ApiError(403, "FORBIDDEN", "Only baby administrators can revoke other caregivers");
      }

      // 3. Target BabyMember check
      const targetBabyMember = await tx.babyMember.findUnique({
        where: {
          uq_baby_members_user_baby: {
            userId: targetUserId,
            babyId: baby.id,
          },
        },
      });

      if (!targetBabyMember || targetBabyMember.status !== "active" || targetBabyMember.deletedAt !== null) {
        throw new ApiError(404, "MEMBER_NOT_FOUND", "Caregiver is not actively assigned to this baby");
      }

      // 4. Last active baby admin safeguard
      const allBabyMembers = await tx.babyMember.findMany({
        where: { babyId: baby.id, deletedAt: null },
      });

      const allFamilyMembers = await tx.familyMember.findMany({
        where: { familyId: baby.familyId, deletedAt: null },
      });

      const domainContext: BabyAccessContext = {
        familyId: baby.familyId,
        babyId: baby.id,
        loadedBaby: { id: baby.id, familyId: baby.familyId },
      };

      const domainCallerPrincipal: UserPrincipal = {
        userId: principal.userId,
        username: principal.username,
        sessionId: principal.sessionId,
        familyMemberships: allFamilyMembers
          .filter((fm) => fm.status === "active")
          .map((fm) => ({ familyId: fm.familyId, role: fm.role as FamilyRole, status: fm.status as MembershipStatus })),
        babyMemberships: allBabyMembers
          .filter((bm) => bm.status === "active")
          .map((bm) => ({ userId: bm.userId, babyId: bm.babyId, familyId: bm.familyId, role: bm.role as BabyRole, status: bm.status as MembershipStatus })),
      };

      const allowed = canRevokeBabyMember(
        domainCallerPrincipal,
        domainContext,
        {
          userId: targetBabyMember.userId,
          babyId: targetBabyMember.babyId,
          familyId: targetBabyMember.familyId,
          role: targetBabyMember.role as BabyRole,
          status: targetBabyMember.status as MembershipStatus,
        },
        allBabyMembers.map((bm) => ({
          userId: bm.userId,
          babyId: bm.babyId,
          familyId: bm.familyId,
          role: bm.role as BabyRole,
          status: bm.status as MembershipStatus,
        })),
        allFamilyMembers.map((fm) => ({
          userId: fm.userId,
          familyId: fm.familyId,
          role: fm.role as FamilyRole,
          status: fm.status as MembershipStatus,
        })),
      );

      if (!allowed) {
        throw new ApiError(
          409,
          "LAST_BABY_ADMIN_PROTECTION",
          `Cannot revoke the last active administrator for baby '${baby.nickname}'. Transfer admin role first.`,
        );
      }

      // 5. Revoke BabyMember
      await tx.babyMember.update({
        where: { id: targetBabyMember.id },
        data: {
          status: "revoked",
          deletedAt: now,
          updatedAt: now,
          version: targetBabyMember.version + 1,
        },
      });

      // Increment permissionVersion
      await tx.familySyncState.update({
        where: { familyId: baby.familyId },
        data: {
          permissionVersion: { increment: 1 },
          updatedAt: now,
        },
      });

      return { removed: true };
    });
  }
}
