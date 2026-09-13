import crypto from "node:crypto";
import { PrismaClient } from "@growdesk/database";
import { UserPrincipal } from "@growdesk/domain";
import {
  CreateVaccineRecordRequest,
  VaccineRecord,
  VaccineScheduleItem,
} from "@growdesk/contracts";
import { BabyAccessDeniedError, RecordNotFoundError } from "@growdesk/database";

const DEFAULT_VACCINE_SCHEDULES: VaccineScheduleItem[] = [
  {
    id: "sched-bcg-1",
    vaccineCode: "BCG",
    name: "卡介苗",
    recommendedAgeMonths: 0,
    doseNumber: 1,
    mandatory: true,
  },
  {
    id: "sched-hepb-1",
    vaccineCode: "HepB",
    name: "乙肝疫苗 (第1剂)",
    recommendedAgeMonths: 0,
    doseNumber: 1,
    mandatory: true,
  },
  {
    id: "sched-hepb-2",
    vaccineCode: "HepB",
    name: "乙肝疫苗 (第2剂)",
    recommendedAgeMonths: 1,
    doseNumber: 2,
    mandatory: true,
  },
  {
    id: "sched-ipv-1",
    vaccineCode: "IPV",
    name: "脊灰灭活疫苗 (第1剂)",
    recommendedAgeMonths: 2,
    doseNumber: 1,
    mandatory: true,
  },
  {
    id: "sched-dtap-1",
    vaccineCode: "DTaP",
    name: "百白破疫苗 (第1剂)",
    recommendedAgeMonths: 3,
    doseNumber: 1,
    mandatory: true,
  },
  {
    id: "sched-dtap-2",
    vaccineCode: "DTaP",
    name: "百白破疫苗 (第2剂)",
    recommendedAgeMonths: 4,
    doseNumber: 2,
    mandatory: true,
  },
  {
    id: "sched-dtap-3",
    vaccineCode: "DTaP",
    name: "百白破疫苗 (第3剂)",
    recommendedAgeMonths: 5,
    doseNumber: 3,
    mandatory: true,
  },
  {
    id: "sched-hepb-3",
    vaccineCode: "HepB",
    name: "乙肝疫苗 (第3剂)",
    recommendedAgeMonths: 6,
    doseNumber: 3,
    mandatory: true,
  },
  {
    id: "sched-mmr-1",
    vaccineCode: "MMR",
    name: "麻腮风疫苗 (第1剂)",
    recommendedAgeMonths: 8,
    doseNumber: 1,
    mandatory: true,
  },
];

export class VaccineService {
  constructor(private readonly prisma: PrismaClient) {}

  private async assertBabyAccess(
    principal: UserPrincipal,
    babyId: string,
    requireWrite = false
  ): Promise<{ familyId: string }> {
    const membership = principal.babyMemberships?.find(
      (m) => m.babyId === babyId && m.status === "active"
    );

    if (!membership) {
      throw new BabyAccessDeniedError(babyId);
    }

    if (requireWrite && membership.role === "viewer") {
      throw new BabyAccessDeniedError(babyId);
    }

    return { familyId: membership.familyId };
  }

  async getVaccineSchedule(): Promise<VaccineScheduleItem[]> {
    const rows = await this.prisma.vaccineSchedule.findMany({
      orderBy: [{ recommendedAgeMonths: "asc" }, { doseNumber: "asc" }],
    });

    if (rows.length === 0) {
      return DEFAULT_VACCINE_SCHEDULES;
    }

    return rows.map((r) => ({
      id: r.id,
      vaccineCode: r.vaccineCode,
      name: r.name,
      recommendedAgeMonths: r.recommendedAgeMonths,
      doseNumber: r.doseNumber,
      mandatory: r.mandatory,
    }));
  }

  async listVaccineRecords(
    principal: UserPrincipal,
    babyId: string
  ): Promise<VaccineRecord[]> {
    const { familyId } = await this.assertBabyAccess(principal, babyId);

    const rows = await this.prisma.vaccineRecord.findMany({
      where: {
        familyId,
        babyId,
        deletedAt: null,
      },
      orderBy: [{ administeredDate: "desc" }, { id: "desc" }],
    });

    return rows.map((r) => ({
      id: r.id,
      babyId: r.babyId,
      familyId: r.familyId,
      vaccineCode: r.vaccineCode,
      administeredDate: r.administeredDate.toISOString().slice(0, 10),
      clinic: r.clinic,
      batchNumber: r.batchNumber,
      notes: r.notes,
      version: String(r.version),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async createVaccineRecord(
    principal: UserPrincipal,
    babyId: string,
    input: CreateVaccineRecordRequest,
    idempotencyKey?: string
  ): Promise<VaccineRecord> {
    const { familyId } = await this.assertBabyAccess(principal, babyId, true);

    const recordId = crypto.randomUUID();
    const administeredDate = new Date(`${input.administeredDate}T00:00:00.000Z`);

    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Idempotency check if key provided
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
            const rec = await tx.vaccineRecord.findUnique({
              where: { id: respBody.id },
            });
            if (rec && !rec.deletedAt) {
              return rec;
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

      // 3. Create record
      const rec = await tx.vaccineRecord.create({
        data: {
          id: recordId,
          familyId,
          babyId,
          caregiverId: principal.userId,
          vaccineCode: input.vaccineCode,
          administeredDate,
          clinic: input.clinic ?? null,
          batchNumber: input.batchNumber ?? null,
          notes: input.notes ?? null,
          version: 1,
        },
      });

      // 4. Create timeline projection
      await tx.timelineEntry.create({
        data: {
          id: crypto.randomUUID(),
          familyId,
          babyId,
          entityType: "vaccine",
          entityId: rec.id,
          occurredAt: administeredDate,
          summary: `接种疫苗: ${rec.vaccineCode}`,
          details: {
            clinic: rec.clinic,
            batchNumber: rec.batchNumber,
          },
          source: "ui_manual",
          version: 1,
        },
      });

      // 5. Idempotency receipt
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
            responseBody: { id: rec.id },
          },
        });
      }

      // 6. Advance cursor
      await tx.familySyncState.update({
        where: { familyId },
        data: { cursor: { increment: 1 } },
      });

      return rec;
    });

    return {
      id: result.id,
      babyId: result.babyId,
      familyId: result.familyId,
      vaccineCode: result.vaccineCode,
      administeredDate: result.administeredDate.toISOString().slice(0, 10),
      clinic: result.clinic,
      batchNumber: result.batchNumber,
      notes: result.notes,
      version: String(result.version),
      createdAt: result.createdAt.toISOString(),
      updatedAt: result.updatedAt.toISOString(),
    };
  }

  async deleteVaccineRecord(
    principal: UserPrincipal,
    babyId: string,
    recordId: string
  ): Promise<{ data: { id: string; deleted: true } }> {
    const { familyId } = await this.assertBabyAccess(principal, babyId, true);

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.vaccineRecord.findUnique({
        where: { id: recordId },
      });

      if (!existing || existing.deletedAt || existing.babyId !== babyId || existing.familyId !== familyId) {
        throw new RecordNotFoundError("VaccineRecord", recordId);
      }

      await tx.vaccineRecord.update({
        where: { id: recordId },
        data: { deletedAt: new Date() },
      });

      await tx.timelineEntry.updateMany({
        where: {
          familyId,
          babyId,
          entityType: "vaccine",
          entityId: recordId,
        },
        data: { deletedAt: new Date() },
      });

      await tx.familySyncState.update({
        where: { familyId },
        data: { cursor: { increment: 1 } },
      });
    });

    return { data: { id: recordId, deleted: true } };
  }
}
