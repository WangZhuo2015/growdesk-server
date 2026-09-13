import crypto from "node:crypto";
import { PrismaClient } from "@growdesk/database";
import { UserPrincipal } from "@growdesk/domain";
import {
  RegisterPushDeviceRequest,
  NotificationItem,
} from "@growdesk/contracts";
import { RecordNotFoundError } from "@growdesk/database";

export class NotificationService {
  constructor(private readonly prisma: PrismaClient) {}

  async registerPushDevice(
    principal: UserPrincipal,
    installationId: string,
    input: RegisterPushDeviceRequest
  ): Promise<{ data: { success: true } }> {
    await this.prisma.pushDevice.upsert({
      where: {
        uq_push_devices_user_installation: {
          userId: principal.userId,
          installationId,
        },
      },
      create: {
        id: crypto.randomUUID(),
        userId: principal.userId,
        installationId,
        platform: input.platform,
        environment: input.environment,
        token: input.token,
        deviceLabel: input.deviceLabel ?? null,
      },
      update: {
        platform: input.platform,
        environment: input.environment,
        token: input.token,
        deviceLabel: input.deviceLabel ?? null,
      },
    });

    return { data: { success: true } };
  }

  async unregisterPushDevice(
    principal: UserPrincipal,
    installationId: string
  ): Promise<{ data: { success: true } }> {
    await this.prisma.pushDevice.deleteMany({
      where: {
        userId: principal.userId,
        installationId,
      },
    });

    return { data: { success: true } };
  }

  async listNotifications(
    principal: UserPrincipal,
    options: { limit?: number; cursor?: string } = {}
  ): Promise<{ data: NotificationItem[]; page: { nextCursor: string | null } }> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);

    const rows = await this.prisma.notification.findMany({
      where: {
        userId: principal.userId,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor: string | null = null;
    const lastRow = pageRows[pageRows.length - 1];
    if (hasMore && lastRow) {
      nextCursor = Buffer.from(`${lastRow.createdAt.toISOString()}|${lastRow.id}`).toString("base64url");
    }

    const data: NotificationItem[] = pageRows.map((r) => ({
      id: r.id,
      userId: r.userId,
      eventKey: r.eventKey,
      title: r.title,
      body: r.body,
      data: (r.data as Record<string, unknown>) ?? undefined,
      readAt: r.readAt ? r.readAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    }));

    return { data, page: { nextCursor } };
  }

  async markNotificationAsRead(
    principal: UserPrincipal,
    notificationId: string
  ): Promise<{ data: { success: true } }> {
    const notif = await this.prisma.notification.findUnique({
      where: { id: notificationId },
    });

    if (!notif || notif.userId !== principal.userId) {
      throw new RecordNotFoundError("Notification", notificationId);
    }

    if (!notif.readAt) {
      await this.prisma.notification.update({
        where: { id: notificationId },
        data: { readAt: new Date() },
      });
    }

    return { data: { success: true } };
  }
}
