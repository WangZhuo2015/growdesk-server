import type { PrismaClient } from "@growdesk/database";
import type {
  UserPrincipal,
  FamilyMembership,
  BabyMember,
  FamilyRole,
  BabyRole,
  MembershipStatus,
} from "@growdesk/domain";
import crypto from "node:crypto";
import { generateRefreshToken } from "./tokens.js";

export interface CreateSessionResult {
  readonly sessionId: string;
  readonly rawRefreshToken: string;
  readonly tokenHash: string;
  readonly rotationId: string;
  readonly expiresAt: Date;
}

export type DevicePlatform = "ios" | "web" | "macos" | "android" | "unknown";

export function inferPlatform(deviceLabel?: string | null): DevicePlatform {
  if (!deviceLabel) return "unknown";
  const label = deviceLabel.toLowerCase();
  if (label.includes("ios") || label.includes("iphone") || label.includes("ipad")) return "ios";
  if (label.includes("web") || label.includes("chrome") || label.includes("safari") || label.includes("firefox")) return "web";
  if (label.includes("mac")) return "macos";
  if (label.includes("android")) return "android";
  return "unknown";
}

/**
 * Create a new DeviceSession and initial RefreshCredential in PostgreSQL 18.
 */
export async function createSession(
  prisma: PrismaClient,
  userId: string,
  deviceLabel?: string | null,
  platformOverride?: DevicePlatform,
): Promise<CreateSessionResult> {
  const sessionId = crypto.randomUUID();
  const rotationId = crypto.randomUUID();
  const now = new Date();
  const absoluteExpiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days
  const refreshExpiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days idle
  const platform = platformOverride || inferPlatform(deviceLabel);

  const { rawToken, tokenHash } = generateRefreshToken();

  await prisma.deviceSession.create({
    data: {
      id: sessionId,
      userId,
      deviceLabel: deviceLabel || "Web/Default",
      platform,
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt,
      refreshCredentials: {
        create: {
          tokenHash,
          userId,
          rotationId,
          createdAt: now,
          expiresAt: refreshExpiresAt,
        },
      },
    },
  });

  return {
    sessionId,
    rawRefreshToken: rawToken,
    tokenHash,
    rotationId,
    expiresAt: refreshExpiresAt,
  };
}

/**
 * Resolve active UserPrincipal from a validated session.
 * Re-reads User, DeviceSession, FamilyMembers, and BabyMembers from the database.
 */
export async function resolvePrincipalFromSession(
  prisma: PrismaClient,
  userId: string,
  sessionId: string,
): Promise<UserPrincipal | null> {
  const now = new Date();

  const session = await prisma.deviceSession.findUnique({
    where: { id: sessionId },
    include: {
      user: {
        include: {
          familyMemberships: true,
          babyMemberships: true,
        },
      },
    },
  });

  if (!session || session.userId !== userId || session.revokedAt !== null || session.absoluteExpiresAt <= now) {
    return null;
  }

  const user = session.user;
  if (!user || user.deletedAt !== null) {
    return null;
  }

  const familyMemberships: FamilyMembership[] = user.familyMemberships
    .filter((fm) => fm.status === "active" && fm.deletedAt === null)
    .map((fm) => ({
      familyId: fm.familyId,
      role: fm.role as FamilyRole,
      status: fm.status as MembershipStatus,
    }));

  const babyMemberships: BabyMember[] = user.babyMemberships
    .filter((bm) => bm.status === "active" && bm.deletedAt === null)
    .map((bm) => ({
      userId: bm.userId,
      babyId: bm.babyId,
      familyId: bm.familyId,
      role: bm.role as BabyRole,
      status: bm.status as MembershipStatus,
    }));

  return {
    userId: user.id,
    username: user.username,
    sessionId: session.id,
    deviceLabel: session.deviceLabel,
    familyMemberships,
    babyMemberships,
  };
}

/**
 * Revoke a specific session for a user.
 */
export async function revokeSession(
  prisma: PrismaClient,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const session = await prisma.deviceSession.findUnique({
    where: { id: sessionId },
  });

  if (!session || session.userId !== userId) {
    return false;
  }

  const now = new Date();
  await prisma.$transaction([
    prisma.deviceSession.update({
      where: { id: sessionId },
      data: { revokedAt: now },
    }),
    prisma.refreshCredential.updateMany({
      where: { sessionId, revokedAt: null },
      data: { revokedAt: now },
    }),
  ]);

  return true;
}
