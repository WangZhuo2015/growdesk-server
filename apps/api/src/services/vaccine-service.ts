import crypto from "node:crypto";
import { PrismaClient } from "@growdesk/database";
import { UserPrincipal } from "@growdesk/domain";
import {
  CreateVaccineRecordRequest,
  VaccineRecord,
  VaccineScheduleItem,
  VaccineSelection,
  UpsertVaccineSelectionRequest,
  VaccineCatalogResponse,
} from "@growdesk/contracts";
import { BabyAccessDeniedError, ConcurrencyConflictError, RecordNotFoundError } from "@growdesk/database";
import { referenceData } from "../knowledge/legacy-reference-data.js";
import { vaccineEngineRules } from "../knowledge/vaccine-engine-rules.js";

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

  /** Return the promoted vaccine graph used by the legacy Web knowledge view. */
  async getVaccineCatalog(): Promise<VaccineCatalogResponse> {
    const vaccines = await this.prisma.vaccine.findMany({
      include: { doses: { orderBy: { doseNumber: "asc" } } },
      orderBy: { vaccineCode: "asc" },
    });
    const items = vaccines.map((row) => ({
      id: row.id,
      vaccineCode: row.vaccineCode,
      name: row.name,
      shortName: row.shortName,
      englishName: row.englishName,
      programType: row.programType,
      legacyLabel: row.legacyLabel,
      sexRestriction: row.sexRestriction,
      chinaNational: row.chinaNational,
      diseases: row.diseases,
      targetPopulation: row.targetPopulation,
      policyEffectiveDate: row.policyEffectiveDate,
      policyVersion: row.policyVersion,
      routineHealthyChildOption: row.routineHealthyChildOption,
      manualReviewRequired: row.manualReviewRequired,
      marketStatus: row.marketStatus,
      productBrandName: row.productBrandName,
      productManufacturer: row.productManufacturer,
      productApprovalNumber: row.productApprovalNumber,
      jiangsuNotes: row.jiangsuNotes,
      suzhouNotes: row.suzhouNotes,
      catchUpSupported: row.catchUpSupported,
      catchUpRules: row.catchUpRules,
      simultaneousVaccination: row.simultaneousVaccination,
      substitutionRules: row.substitutionRules,
      contraindications: row.contraindications,
      precautions: row.precautions,
      specialPopulations: row.specialPopulations,
      regionalOverrides: row.regionalOverrides,
      regimenOptions: row.regimenOptions,
      sourceRefsJson: row.sourceRefsJson,
      doses: row.doses.map((dose) => ({
        id: dose.id,
        vaccineId: dose.vaccineId,
        doseNumber: dose.doseNumber,
        doseLabel: dose.doseLabel,
        recommendedAgeMonths: dose.recommendedAgeMonths,
        minimumAgeDays: dose.minimumAgeDays,
        maximumAgeDays: dose.maximumAgeDays,
        recommendedAgeMaxMonths: dose.recommendedAgeMaxMonths,
        minimumIntervalDaysFromPrevious: dose.minimumIntervalDaysFromPrevious,
        maximumIntervalDaysFromPrevious: dose.maximumIntervalDaysFromPrevious,
        route: dose.route,
        site: dose.site,
        doseVolumeMl: dose.doseVolumeMl?.toString() ?? null,
        notes: dose.notes,
        sourceRefsJson: dose.sourceRefsJson,
      })),
    }));
    const [strategyGroups, schedule] = await Promise.all([
      this.prisma.vaccineStrategyGroup.findMany({ orderBy: { strategyId: "asc" } }),
      this.prisma.vaccineScheduleEntry.findMany({ orderBy: [{ ageMonths: "asc" }, { doseNumber: "asc" }, { id: "asc" }] }),
    ]);
    const groups = strategyGroups.map((row) => ({
      id: row.id,
      strategyId: row.strategyId,
      vaccineId: row.vaccineId,
      name: row.name,
      scope: row.scope,
      baseProgram: row.baseProgram,
      optionsJson: row.optionsJson,
      sourceRefsJson: row.sourceRefsJson,
    }));
    const entries = schedule.map((row) => ({
      id: row.id,
      vaccineId: row.vaccineId,
      ageMonths: row.ageMonths,
      ageDays: row.ageDays,
      ageLabel: row.ageLabel,
      doseNumber: row.doseNumber,
      priority: row.priority,
      isOptional: row.isOptional,
      action: row.action,
      selectionGroup: row.selectionGroup,
      notes: row.notes,
      sourceRefsJson: row.sourceRefsJson,
    }));
    return {
      national: items.filter((row) => row.programType === "national_immunization_program"),
      nonProgram: items.filter((row) => row.programType === "non_program"),
      provincial: items.filter((row) => row.programType === "provincial_immunization_program"),
      strategyGroups: groups,
      schedule: entries,
      engineRules: vaccineEngineRules,
      dataRelease: referenceData.dataRelease,
    };
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
      vaccineId: r.vaccineId,
      doseNumber: r.doseNumber,
      legacyName: r.legacyName,
      legacyDose: r.legacyDose,
      administeredDate: r.administeredDate.toISOString().slice(0, 10),
      scheduledDate: r.scheduledDate?.toISOString().slice(0, 10) ?? r.administeredDate.toISOString().slice(0, 10),
      completedDate: r.completedDate?.toISOString().slice(0, 10) ?? null,
      isCompleted: r.isCompleted,
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
    const isCompleted = input.isCompleted ?? true;
    const scheduledDate = input.scheduledDate
      ? new Date(`${input.scheduledDate}T00:00:00.000Z`)
      : administeredDate;
    const completedDate = isCompleted
      ? (input.completedDate ? new Date(`${input.completedDate}T00:00:00.000Z`) : administeredDate)
      : null;

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

      const vaccine = input.vaccineId
        ? await tx.vaccine.findUnique({ where: { id: input.vaccineId }, select: { id: true, vaccineCode: true } })
        : await tx.vaccine.findUnique({ where: { vaccineCode: input.vaccineCode }, select: { id: true, vaccineCode: true } });
      if (input.vaccineId && !vaccine) {
        throw new RecordNotFoundError("vaccine", input.vaccineId);
      }

      // 3. Create record. `administeredDate` stays required for the old
      // schema, while the explicit completion fields preserve pending rows.
      const rec = await tx.vaccineRecord.create({
        data: {
          id: recordId,
          familyId,
          babyId,
          caregiverId: principal.userId,
          vaccineCode: vaccine?.vaccineCode ?? input.vaccineCode,
          vaccineId: vaccine?.id ?? null,
          doseNumber: input.doseNumber ?? null,
          legacyName: input.legacyName ?? null,
          legacyDose: input.legacyDose ?? null,
          administeredDate,
          scheduledDate,
          completedDate,
          isCompleted,
          clinic: input.clinic ?? null,
          batchNumber: input.batchNumber ?? null,
          notes: input.notes ?? null,
          version: 1,
        },
      });

      // Pending/scheduled rows are not historical events. Keep them in the
      // record graph, but do not project them into the completion timeline.
      if (isCompleted) {
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
      }

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
      vaccineId: result.vaccineId,
      doseNumber: result.doseNumber,
      legacyName: result.legacyName,
      legacyDose: result.legacyDose,
      administeredDate: result.administeredDate.toISOString().slice(0, 10),
      scheduledDate: result.scheduledDate?.toISOString().slice(0, 10) ?? result.administeredDate.toISOString().slice(0, 10),
      completedDate: result.completedDate?.toISOString().slice(0, 10) ?? null,
      isCompleted: result.isCompleted,
      clinic: result.clinic,
      batchNumber: result.batchNumber,
      notes: result.notes,
      version: String(result.version),
      createdAt: result.createdAt.toISOString(),
      updatedAt: result.updatedAt.toISOString(),
    };
  }

  async listVaccineSelections(principal: UserPrincipal, babyId: string): Promise<VaccineSelection[]> {
    const { familyId } = await this.assertBabyAccess(principal, babyId);
    const rows = await this.prisma.vaccineSelection.findMany({
      where: { familyId, babyId },
      orderBy: [{ vaccineId: "asc" }, { doseNumber: "asc" }],
    });
    return rows.map((row) => ({
      id: row.id,
      familyId: row.familyId,
      babyId: row.babyId,
      vaccineId: row.vaccineId,
      doseNumber: row.doseNumber,
      selected: row.selected,
      completed: row.completed,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async upsertVaccineSelection(
    principal: UserPrincipal,
    babyId: string,
    input: UpsertVaccineSelectionRequest,
  ): Promise<VaccineSelection> {
    const { familyId } = await this.assertBabyAccess(principal, babyId, true);
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "public"."family_sync_states" ("family_id", "epoch", "cursor", "created_at", "updated_at")
        VALUES (${familyId}, ${crypto.randomUUID()}, 0, NOW(), NOW())
        ON CONFLICT ("family_id") DO NOTHING
      `;
      await tx.$executeRaw`
        SELECT 1 FROM "public"."family_sync_states" WHERE "family_id" = ${familyId} FOR UPDATE
      `;
      const vaccine = await tx.vaccine.findUnique({ where: { id: input.vaccineId }, select: { id: true, vaccineCode: true, name: true } })
        ?? await tx.vaccine.findUnique({ where: { vaccineCode: input.vaccineId }, select: { id: true, vaccineCode: true, name: true } });
      if (!vaccine) throw new RecordNotFoundError("vaccine", input.vaccineId);
      const vaccineId = vaccine.id;
      const existing = await tx.vaccineSelection.findUnique({
        where: { uq_vaccine_selections_baby_vaccine_dose: { babyId, vaccineId, doseNumber: input.doseNumber } },
      });
      if (existing && input.baseVersion !== undefined && input.baseVersion !== existing.version) {
        throw new ConcurrencyConflictError("Vaccine selection changed; reload before saving");
      }
      const selected = input.selected ?? existing?.selected ?? true;
      const completed = input.completed ?? existing?.completed ?? false;
      const selection = existing
        ? await tx.vaccineSelection.update({
            where: { id: existing.id },
            data: { selected, completed, version: { increment: 1 } },
          })
        : await tx.vaccineSelection.create({
            data: {
              id: crypto.randomUUID(), familyId, babyId, vaccineId,
              doseNumber: input.doseNumber, selected, completed, version: 1,
            },
          });

      const doseLabel = `第${input.doseNumber}剂`;
      const existingRecord = await tx.vaccineRecord.findFirst({
        where: { familyId, babyId, vaccineId, doseNumber: input.doseNumber, deletedAt: null },
      });
      if (completed) {
        const today = new Date();
        if (existingRecord) {
          await tx.vaccineRecord.update({
            where: { id: existingRecord.id },
            data: {
              administeredDate: today,
              scheduledDate: existingRecord.scheduledDate ?? today,
              completedDate: today,
              isCompleted: true,
              legacyName: existingRecord.legacyName ?? vaccine.name,
              legacyDose: existingRecord.legacyDose ?? doseLabel,
              version: { increment: 1 },
            },
          });
          const timeline = await tx.timelineEntry.findUnique({
            where: { uq_timeline_entries_entity: { familyId, babyId, entityType: "vaccine", entityId: existingRecord.id } },
          });
          if (timeline) {
            await tx.timelineEntry.update({
              where: { id: timeline.id },
              data: {
                deletedAt: null,
                occurredAt: today,
                summary: `接种疫苗: ${vaccine.vaccineCode}`,
                details: { doseNumber: input.doseNumber },
                version: { increment: 1 },
              },
            });
          } else {
            await tx.timelineEntry.create({
              data: {
                id: crypto.randomUUID(), familyId, babyId, entityType: "vaccine", entityId: existingRecord.id,
                occurredAt: today, summary: `接种疫苗: ${vaccine.vaccineCode}`,
                details: { doseNumber: input.doseNumber }, source: "ui_manual", version: 1,
              },
            });
          }
        } else {
          const record = await tx.vaccineRecord.create({
            data: {
              id: crypto.randomUUID(), familyId, babyId, caregiverId: principal.userId,
              vaccineCode: vaccine.vaccineCode, vaccineId: vaccine.id, doseNumber: input.doseNumber,
              legacyName: vaccine.name, legacyDose: doseLabel, administeredDate: today,
              scheduledDate: today, completedDate: today, isCompleted: true, version: 1,
            },
          });
          await tx.timelineEntry.create({
            data: {
              id: crypto.randomUUID(), familyId, babyId, entityType: "vaccine", entityId: record.id,
              occurredAt: today, summary: `接种疫苗: ${vaccine.vaccineCode}`,
              details: { doseNumber: input.doseNumber }, source: "ui_manual", version: 1,
            },
          });
        }
      } else if (existingRecord && existingRecord.isCompleted) {
        const deletedAt = new Date();
        await tx.vaccineRecord.update({
          where: { id: existingRecord.id },
          data: { deletedAt, version: { increment: 1 } },
        });
        await tx.timelineEntry.updateMany({
          where: { familyId, babyId, entityType: "vaccine", entityId: existingRecord.id, deletedAt: null },
          data: { deletedAt, version: { increment: 1 } },
        });
      }
      await tx.familySyncState.update({ where: { familyId }, data: { cursor: { increment: 1 } } });
      return selection;
    });
    return {
      id: result.id,
      familyId: result.familyId,
      babyId: result.babyId,
      vaccineId: result.vaccineId,
      doseNumber: result.doseNumber,
      selected: result.selected,
      completed: result.completed,
      version: result.version,
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
