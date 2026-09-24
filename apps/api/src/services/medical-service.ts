import crypto from "node:crypto";
import { PrismaClient, Prisma } from "@growdesk/database";
import { UserPrincipal } from "@growdesk/domain";
import {
  CreateMedicalReportRequest,
  UpdateMedicalReportRequest,
  MedicalReport,
} from "@growdesk/contracts";
import {
  BabyAccessDeniedError,
  ConcurrencyConflictError,
  RecordNotFoundError,
} from "@growdesk/database";

export function encodeMedicalKeysetCursor(reportDate: Date, id: string): string {
  const dateStr = reportDate.toISOString().slice(0, 10);
  return Buffer.from(`${dateStr}|${id}`).toString("base64url");
}

export function decodeMedicalKeysetCursor(cursor: string): { reportDate: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const [dateStr, id] = raw.split("|");
    if (!dateStr || !id) return null;
    const reportDate = new Date(`${dateStr}T00:00:00.000Z`);
    if (isNaN(reportDate.getTime())) return null;
    return { reportDate, id };
  } catch {
    return null;
  }
}

async function lockAttachmentRows(tx: Prisma.TransactionClient, attachmentIds: readonly string[]) {
  for (const attachmentId of [...new Set(attachmentIds)].sort()) {
    await tx.$queryRaw`SELECT id FROM public.attachments WHERE id = ${attachmentId} FOR UPDATE`;
  }
}

export class MedicalService {
  constructor(private readonly prisma: PrismaClient) {}

  private async assertBabyAccess(
    principal: UserPrincipal,
    babyId: string,
    requireWrite = false
  ): Promise<{ familyId: string }> {
    const membership = principal.babyMemberships?.find(
      (m) => m.babyId === babyId && m.status === "active"
    );

    if (!membership || !principal.familyMemberships.some(m => m.familyId === membership.familyId && m.status === "active" && (!requireWrite || m.role !== "viewer"))) {
      throw new BabyAccessDeniedError(babyId);
    }

    if (requireWrite && membership.role === "viewer") {
      throw new BabyAccessDeniedError(babyId);
    }

    return { familyId: membership.familyId };
  }

  async listMedicalReports(
    principal: UserPrincipal,
    babyId: string,
    options: { limit?: number; cursor?: string } = {}
  ): Promise<{ data: MedicalReport[]; page: { nextCursor: string | null } }> {
    const { familyId } = await this.assertBabyAccess(principal, babyId);
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);

    const where: Prisma.MedicalReportWhereInput = {
      familyId,
      babyId,
      deletedAt: null,
    };

    if (options.cursor) {
      const decoded = decodeMedicalKeysetCursor(options.cursor);
      if (decoded) {
        where.OR = [
          { reportDate: { lt: decoded.reportDate } },
          {
            reportDate: decoded.reportDate,
            id: { lt: decoded.id },
          },
        ];
      }
    }

    const rows = await this.prisma.medicalReport.findMany({
      where,
      orderBy: [{ reportDate: "desc" }, { id: "desc" }],
      take: limit + 1,
      include: {
        attachments: {
          select: { attachmentId: true },
        },
      },
    });

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor: string | null = null;
    const lastRow = pageRows[pageRows.length - 1];
    if (hasMore && lastRow) {
      nextCursor = encodeMedicalKeysetCursor(lastRow.reportDate, lastRow.id);
    }

    const data: MedicalReport[] = pageRows.map((r) => ({
      id: r.id,
      babyId: r.babyId,
      familyId: r.familyId,
      reportDate: r.reportDate.toISOString().slice(0, 10),
      title: r.title,
      hospital: r.hospital,
      department: r.department,
      diagnosis: r.diagnosis,
      attachmentIds: r.attachments.map((a) => a.attachmentId),
      notes: r.notes,
      items: (Array.isArray(r.items) ? r.items : []) as MedicalReport["items"],
      version: String(r.version),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));

    return { data, page: { nextCursor } };
  }

  async createMedicalReport(
    principal: UserPrincipal,
    babyId: string,
    input: CreateMedicalReportRequest,
    idempotencyKey?: string
  ): Promise<MedicalReport> {
    const { familyId } = await this.assertBabyAccess(principal, babyId, true);

    const reportId = crypto.randomUUID();
    const reportDate = new Date(`${input.reportDate}T00:00:00.000Z`);

    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Check idempotency if key provided
      if (idempotencyKey) {
        const existing = await tx.idempotencyReceipt.findUnique({
          where: {
            pk_idempotency_receipts: {
              actorId: principal.userId,
              scopeId: familyId,
              commandId: idempotencyKey,
            },
          },
        });
        if (existing) {
          const respBody = existing.responseBody as { id?: string } | null;
          if (respBody?.id) {
            const rep = await tx.medicalReport.findUnique({
              where: { id: respBody.id },
              include: { attachments: { select: { attachmentId: true } } },
            });
            if (rep && !rep.deletedAt) {
              return rep;
            }
          }
        }
      }

      // 2. Lock family sync state
      await tx.$executeRaw`
        SELECT 1 FROM "public"."family_sync_states"
        WHERE "family_id" = ${familyId}
        FOR UPDATE
      `;

      // 3. Create medical report
      const rep = await tx.medicalReport.create({
        data: {
          id: reportId,
          familyId,
          babyId,
          caregiverId: principal.userId,
          reportDate,
          title: input.title,
          hospital: input.hospital ?? null,
          department: input.department ?? null,
          diagnosis: input.diagnosis ?? null,
          notes: input.notes ?? null,
          items: (input.items ?? []) as Prisma.InputJsonValue,
          version: 1,
        },
      });

      // 4. Attach attachments
      if (input.attachmentIds && input.attachmentIds.length > 0) {
        await lockAttachmentRows(tx, input.attachmentIds);
        for (const attId of input.attachmentIds) {
          const attachment = await tx.attachment.findFirst({ where: { id: attId, familyId, babyId, status: "ready", deletedAt: null, purpose: "medical_report" } });
          if (!attachment) throw new RecordNotFoundError("Attachment", attId);
          await tx.medicalReportAttachment.create({
            data: {
              id: crypto.randomUUID(),
              reportId: rep.id,
              attachmentId: attId,
            },
          });
        }
      }

      // 5. Create atomic timeline projection
      await tx.timelineEntry.create({
        data: {
          id: crypto.randomUUID(),
          familyId,
          babyId,
          entityType: "medical",
          entityId: rep.id,
          occurredAt: reportDate,
          summary: `医疗就诊/检查: ${rep.title}`,
          details: {
            hospital: rep.hospital,
            department: rep.department,
            diagnosis: rep.diagnosis,
          },
          source: "ui_manual",
          version: 1,
        },
      });

      if (input.growthData) {
        const measurement = await tx.growthMeasurement.create({ data: {
          id: crypto.randomUUID(), familyId, babyId, measurementDate: reportDate,
          ...input.growthData, notes: `Medical report: ${reportId}`, version: 1,
        } });
        await tx.timelineEntry.create({ data: {
          id: crypto.randomUUID(), familyId, babyId, entityType: "growth", entityId: measurement.id,
          occurredAt: reportDate, summary: "生长测量", details: { medicalReportId: reportId, ...input.growthData }, source: "ui_manual", version: 1,
        } });
      }

      // 6. Record idempotency receipt
      if (idempotencyKey) {
        await tx.idempotencyReceipt.create({
          data: {
            actorId: principal.userId,
            scopeId: familyId,
            commandId: idempotencyKey,
            requestHash: crypto
              .createHash("sha256")
              .update(JSON.stringify(input))
              .digest("hex"),
            resultCode: 200,
            responseBody: { id: rep.id },
          },
        });
      }

      // 7. Advance family cursor
      await tx.familySyncState.update({
        where: { familyId },
        data: { cursor: { increment: 1 } },
      });

      return await tx.medicalReport.findUniqueOrThrow({
        where: { id: rep.id },
        include: { attachments: { select: { attachmentId: true } } },
      });
    });

    return {
      id: result.id,
      babyId: result.babyId,
      familyId: result.familyId,
      reportDate: result.reportDate.toISOString().slice(0, 10),
      title: result.title,
      hospital: result.hospital,
      department: result.department,
      diagnosis: result.diagnosis,
      attachmentIds: result.attachments.map((a) => a.attachmentId),
      notes: result.notes,
      items: (Array.isArray(result.items) ? result.items : []) as MedicalReport["items"],
      version: String(result.version),
      createdAt: result.createdAt.toISOString(),
      updatedAt: result.updatedAt.toISOString(),
    };
  }

  async getMedicalReport(
    principal: UserPrincipal,
    babyId: string,
    reportId: string
  ): Promise<MedicalReport> {
    const { familyId } = await this.assertBabyAccess(principal, babyId);

    const report = await this.prisma.medicalReport.findUnique({
      where: { id: reportId },
      include: {
        attachments: { select: { attachmentId: true } },
      },
    });

    if (!report || report.deletedAt || report.babyId !== babyId || report.familyId !== familyId) {
      throw new RecordNotFoundError("MedicalReport", reportId);
    }

    return {
      id: report.id,
      babyId: report.babyId,
      familyId: report.familyId,
      reportDate: report.reportDate.toISOString().slice(0, 10),
      title: report.title,
      hospital: report.hospital,
      department: report.department,
      diagnosis: report.diagnosis,
      attachmentIds: report.attachments.map((a) => a.attachmentId),
      notes: report.notes,
      items: (Array.isArray(report.items) ? report.items : []) as MedicalReport["items"],
      version: String(report.version),
      createdAt: report.createdAt.toISOString(),
      updatedAt: report.updatedAt.toISOString(),
    };
  }

  async updateMedicalReport(
    principal: UserPrincipal,
    babyId: string,
    reportId: string,
    input: UpdateMedicalReportRequest
  ): Promise<MedicalReport> {
    const { familyId } = await this.assertBabyAccess(principal, babyId, true);

    const expectedVersion = Number(input.baseVersion);

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM public.medical_reports WHERE id = ${reportId} AND baby_id = ${babyId} AND family_id = ${familyId} FOR UPDATE`;
      // 1. Lock report row
      const existing = await tx.medicalReport.findUnique({
        where: { id: reportId },
      });

      if (!existing || existing.deletedAt || existing.babyId !== babyId || existing.familyId !== familyId) {
        throw new RecordNotFoundError("MedicalReport", reportId);
      }

      if (existing.version !== expectedVersion) {
        throw new ConcurrencyConflictError(
          `Concurrency conflict: baseVersion ${expectedVersion} does not match current version ${existing.version}`
        );
      }

      const updateData: Prisma.MedicalReportUpdateInput = {
        version: { increment: 1 },
      };

      if (input.reportDate) {
        updateData.reportDate = new Date(`${input.reportDate}T00:00:00.000Z`);
      }
      if (input.title !== undefined) updateData.title = input.title;
      if (input.hospital !== undefined) updateData.hospital = input.hospital;
      if (input.department !== undefined) updateData.department = input.department;
      if (input.diagnosis !== undefined) updateData.diagnosis = input.diagnosis;
      if (input.notes !== undefined) updateData.notes = input.notes;
      if (input.items !== undefined) updateData.items = input.items as Prisma.InputJsonValue;

      const updated = await tx.medicalReport.update({
        where: { id: reportId },
        data: updateData,
      });

      // Update attachments if provided
      if (input.attachmentIds !== undefined) {
        const existingLinks = await tx.medicalReportAttachment.findMany({
          where: { reportId },
          select: { attachmentId: true },
        });
        await lockAttachmentRows(tx, [
          ...existingLinks.map((link) => link.attachmentId),
          ...input.attachmentIds,
        ]);
        await tx.medicalReportAttachment.deleteMany({
          where: { reportId },
        });

        for (const attId of input.attachmentIds) {
          const attachment = await tx.attachment.findFirst({ where: { id: attId, familyId, babyId, status: "ready", deletedAt: null, purpose: "medical_report" } });
          if (!attachment) throw new RecordNotFoundError("Attachment", attId);
          await tx.medicalReportAttachment.create({
            data: {
              id: crypto.randomUUID(),
              reportId,
              attachmentId: attId,
            },
          });
        }
      }

      // Update timeline projection
      const timelineOccurred = input.reportDate
        ? new Date(`${input.reportDate}T00:00:00.000Z`)
        : updated.reportDate;

      await tx.timelineEntry.updateMany({
        where: {
          familyId,
          babyId,
          entityType: "medical",
          entityId: reportId,
        },
        data: {
          occurredAt: timelineOccurred,
          summary: `医疗就诊/检查: ${updated.title}`,
          details: {
            hospital: updated.hospital,
            department: updated.department,
            diagnosis: updated.diagnosis,
          },
          version: { increment: 1 },
        },
      });

      await tx.familySyncState.update({
        where: { familyId },
        data: { cursor: { increment: 1 } },
      });

      return await tx.medicalReport.findUniqueOrThrow({
        where: { id: reportId },
        include: { attachments: { select: { attachmentId: true } } },
      });
    });

    return {
      id: result.id,
      babyId: result.babyId,
      familyId: result.familyId,
      reportDate: result.reportDate.toISOString().slice(0, 10),
      title: result.title,
      hospital: result.hospital,
      department: result.department,
      diagnosis: result.diagnosis,
      attachmentIds: result.attachments.map((a) => a.attachmentId),
      notes: result.notes,
      items: (Array.isArray(result.items) ? result.items : []) as MedicalReport["items"],
      version: String(result.version),
      createdAt: result.createdAt.toISOString(),
      updatedAt: result.updatedAt.toISOString(),
    };
  }

  async deleteMedicalReport(
    principal: UserPrincipal,
    babyId: string,
    reportId: string,
    baseVersion: number
  ): Promise<{ data: { id: string; deleted: true } }> {
    const { familyId } = await this.assertBabyAccess(principal, babyId, true);

    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM public.medical_reports WHERE id = ${reportId} AND baby_id = ${babyId} AND family_id = ${familyId} FOR UPDATE`;
      const existing = await tx.medicalReport.findUnique({
        where: { id: reportId },
      });

      if (!existing || existing.deletedAt || existing.babyId !== babyId || existing.familyId !== familyId) {
        throw new RecordNotFoundError("MedicalReport", reportId);
      }

      if (existing.version !== baseVersion) throw new ConcurrencyConflictError("Medical report changed; reload before deleting");
      await tx.timelineEntry.updateMany({ where: { familyId, babyId, entityType: "medical", entityId: reportId }, data: { deletedAt: new Date(), version: { increment: 1 } } });
      await tx.medicalReport.update({
        where: { id: reportId },
        data: { deletedAt: new Date() },
      });

      await tx.timelineEntry.updateMany({
        where: {
          familyId,
          babyId,
          entityType: "medical",
          entityId: reportId,
        },
        data: { deletedAt: new Date() },
      });

      await tx.familySyncState.update({
        where: { familyId },
        data: { cursor: { increment: 1 } },
      });
    });

    return { data: { id: reportId, deleted: true } };
  }
}
