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
import { BabyAccessDeniedError, BadRequestError, ConcurrencyConflictError, RecordNotFoundError } from "@growdesk/database";
import { referenceData } from "../knowledge/legacy-reference-data.js";
import { vaccineEngineRules } from "../knowledge/vaccine-engine-rules.js";

function vaccineDateOnly(value: Date | null): string | null {
  return value?.toISOString().slice(0, 10) ?? null;
}

function vaccineTodayShanghai(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}

function vaccineDateFromInput(value: string | null | undefined, field: string): Date | null {
  if (value == null) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new BadRequestError(`Invalid ${field} date`, "INVALID_VACCINE_RECORD");
  }
  return date;
}

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
        recordStatus: { in: ["completed", "planned"] },
      },
      orderBy: [{ administeredDate: "desc" }, { scheduledDate: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
    });

    const today = vaccineTodayShanghai();
    return rows.filter((r) => {
      if (r.recordStatus === "completed") {
        return r.administeredDate !== null && vaccineDateOnly(r.administeredDate)! <= today;
      }
      return r.recordStatus === "planned";
    }).map((r) => {
      const completed = r.recordStatus === "completed" && r.administeredDate !== null
        && vaccineDateOnly(r.administeredDate)! <= today;
      const actualDate = vaccineDateOnly(r.administeredDate);
      const scheduledDate = vaccineDateOnly(r.scheduledDate) ?? (completed ? actualDate : null);
      // Preserve the pinned non-null iOS wire contract for the default API
      // representation. The Go ledger endpoint is the nullable opt-in surface.
      const administeredDate = completed ? actualDate : scheduledDate;
      if (administeredDate === null) {
        throw new BadRequestError("Legacy vaccine representation cannot expose an undated record", "VACCINE_LEDGER_REQUIRED");
      }
      return {
        id: r.id,
        babyId: r.babyId,
        familyId: r.familyId,
        vaccineCode: r.vaccineCode,
        vaccineId: r.vaccineId,
        doseNumber: r.doseNumber,
        legacyName: r.legacyName,
        legacyDose: r.legacyDose,
        recordStatus: completed ? "completed" as const : "planned" as const,
        administeredDate,
        scheduledDate,
        completedDate: completed ? actualDate : null,
        isCompleted: completed,
        manufacturer: r.manufacturer,
        clinic: r.clinic,
        batchNumber: r.batchNumber,
        traceCode: r.traceCode,
        administrationRoute: r.administrationRoute,
        injectionSite: r.injectionSite,
        notes: r.notes,
        sourceText: r.sourceText,
        version: String(r.version),
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      };
    });
  }

  async createVaccineRecord(
    principal: UserPrincipal,
    babyId: string,
    input: CreateVaccineRecordRequest,
    idempotencyKey?: string
  ): Promise<VaccineRecord> {
    const { familyId } = await this.assertBabyAccess(principal, babyId, true);

    const recordId = crypto.randomUUID();
    const explicitStatus = input.recordStatus !== undefined;
    const recordStatus = input.recordStatus
      ?? (input.isCompleted === false
        ? "planned"
        : input.scheduledDate != null && input.administeredDate == null && input.completedDate == null
          ? "planned"
          : "completed");
    if (input.recordStatus && input.isCompleted !== undefined && input.isCompleted !== (recordStatus === "completed")) {
      throw new BadRequestError("recordStatus conflicts with isCompleted", "INVALID_VACCINE_RECORD");
    }
    if (recordStatus === "needs_review") {
      throw new BadRequestError("needs_review records require the ledger API representation", "VACCINE_LEDGER_REQUIRED");
    }
    if (recordStatus !== "completed" && input.completedDate != null) {
      throw new BadRequestError("completedDate is only valid for a completed record", "INVALID_VACCINE_RECORD");
    }
    if (input.administeredDate != null && input.completedDate != null && input.administeredDate !== input.completedDate) {
      throw new BadRequestError("completedDate must match administeredDate", "INVALID_VACCINE_RECORD");
    }
    const legacyActualDate = input.administeredDate ?? input.completedDate ?? null;
    const legacyAppointmentAlias = !explicitStatus && input.isCompleted === false
      && input.administeredDate != null;
    if (recordStatus === "planned" && input.administeredDate != null && !legacyAppointmentAlias) {
      throw new BadRequestError("planned records cannot contain administeredDate; provide scheduledDate", "INVALID_VACCINE_RECORD");
    }
    const scheduledDateText = input.scheduledDate ?? (legacyAppointmentAlias ? legacyActualDate : null);
    const actualDateText = recordStatus === "completed" ? legacyActualDate : null;
    if (recordStatus === "planned" && !scheduledDateText) {
      throw new BadRequestError("scheduledDate is required for a planned record", "INVALID_VACCINE_RECORD");
    }
    if (recordStatus === "completed" && !actualDateText) {
      throw new BadRequestError("administeredDate is required for a completed record", "INVALID_VACCINE_RECORD");
    }
    const administeredDate = vaccineDateFromInput(actualDateText, "administeredDate");
    const scheduledDate = vaccineDateFromInput(scheduledDateText, "scheduledDate");
    const completedDate = recordStatus === "completed" ? administeredDate : null;
    if (administeredDate && actualDateText! > vaccineTodayShanghai()) {
      throw new BadRequestError("administeredDate cannot be in the future in Asia/Shanghai", "INVALID_VACCINE_RECORD");
    }

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

      const explicitlyUnlinked = input.vaccineId === null;
      const vaccine = input.vaccineId != null
        ? await tx.vaccine.findUnique({ where: { id: input.vaccineId }, select: { id: true, vaccineCode: true, name: true } })
          ?? await tx.vaccine.findUnique({ where: { vaccineCode: input.vaccineId }, select: { id: true, vaccineCode: true, name: true } })
        : !explicitlyUnlinked && input.vaccineCode
          ? await tx.vaccine.findUnique({ where: { vaccineCode: input.vaccineCode.trim() }, select: { id: true, vaccineCode: true, name: true } })
          : null;
      if (input.vaccineId && !vaccine) throw new RecordNotFoundError("vaccine", input.vaccineId);
      const vaccineCode = vaccine?.vaccineCode ?? input.vaccineCode?.trim();
      if (!vaccineCode) throw new BadRequestError("vaccineId or vaccineCode is required", "INVALID_VACCINE_RECORD");
      if (vaccine && input.vaccineCode && input.vaccineCode.trim() !== vaccine.vaccineCode
        && input.vaccineCode.trim() !== input.vaccineId) {
        throw new BadRequestError("vaccineCode does not match vaccineId", "INVALID_VACCINE_RECORD");
      }
      const legacyName = input.legacyName?.trim() || vaccine?.name || vaccineCode;

      // 3. Store actual administration and appointment dates separately.
      const rec = await tx.vaccineRecord.create({
        data: {
          id: recordId,
          familyId,
          babyId,
          caregiverId: principal.userId,
          vaccineCode,
          vaccineId: vaccine?.id ?? null,
          doseNumber: input.doseNumber ?? null,
          legacyName,
          legacyDose: input.legacyDose ?? null,
          recordStatus,
          administeredDate,
          scheduledDate,
          completedDate,
          isCompleted: recordStatus === "completed",
          manufacturer: input.manufacturer ?? null,
          clinic: input.clinic ?? null,
          batchNumber: input.batchNumber ?? null,
          traceCode: input.traceCode ?? null,
          administrationRoute: input.administrationRoute ?? null,
          injectionSite: input.injectionSite ?? null,
          notes: input.notes ?? null,
          sourceText: input.sourceText ?? null,
          version: 1,
        },
      });

      // Pending/scheduled rows are not historical events. Keep them in the
      // record graph, but do not project them into the completion timeline.
      if (recordStatus === "completed" && administeredDate) {
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
      recordStatus: result.isCompleted ? "completed" : "planned",
      administeredDate: (result.recordStatus === "completed" ? vaccineDateOnly(result.administeredDate) : vaccineDateOnly(result.scheduledDate))!,
      scheduledDate: vaccineDateOnly(result.scheduledDate) ?? (result.recordStatus === "completed" ? vaccineDateOnly(result.administeredDate) : null),
      completedDate: result.recordStatus === "completed" ? vaccineDateOnly(result.administeredDate) : null,
      isCompleted: result.recordStatus === "completed" && result.administeredDate !== null,
      manufacturer: result.manufacturer,
      clinic: result.clinic,
      batchNumber: result.batchNumber,
      traceCode: result.traceCode,
      administrationRoute: result.administrationRoute,
      injectionSite: result.injectionSite,
      notes: result.notes,
      sourceText: result.sourceText,
      version: String(result.version),
      createdAt: result.createdAt.toISOString(),
      updatedAt: result.updatedAt.toISOString(),
    };
  }

  async listVaccineSelections(principal: UserPrincipal, babyId: string): Promise<VaccineSelection[]> {
    const { familyId } = await this.assertBabyAccess(principal, babyId);
    const today = new Date(`${vaccineTodayShanghai()}T00:00:00.000Z`);
    const [rows, completedRecords] = await this.prisma.$transaction([
      this.prisma.vaccineSelection.findMany({
        where: { familyId, babyId },
        orderBy: [{ vaccineId: "asc" }, { doseNumber: "asc" }],
      }),
      this.prisma.vaccineRecord.findMany({
        where: { familyId, babyId, deletedAt: null, recordStatus: "completed", isCompleted: true, administeredDate: { not: null, lte: today } },
        select: { vaccineId: true, doseNumber: true },
      }),
    ]);
    const completedKeys = new Set(completedRecords.map((row) => `${row.vaccineId ?? ""}:${row.doseNumber ?? ""}`));
    return rows.map((row) => ({
      id: row.id,
      familyId: row.familyId,
      babyId: row.babyId,
      vaccineId: row.vaccineId,
      doseNumber: row.doseNumber,
      selected: row.selected,
      completed: completedKeys.has(`${row.vaccineId}:${row.doseNumber}`),
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
    if (input.completed !== undefined) {
      throw new BadRequestError(
        "Vaccine completion is derived from records; use vaccine records to change it",
        "READ_ONLY_VACCINE_COMPLETION"
      );
    }
    const { familyId } = await this.assertBabyAccess(principal, babyId, true);
    const today = new Date(`${vaccineTodayShanghai()}T00:00:00.000Z`);
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
      const selection = existing
        ? await tx.vaccineSelection.update({
            where: { id: existing.id },
            data: { selected, version: { increment: 1 } },
          })
        : await tx.vaccineSelection.create({
            data: {
              id: crypto.randomUUID(), familyId, babyId, vaccineId,
              doseNumber: input.doseNumber, selected, completed: false, version: 1,
            },
          });
      const completedRecord = await tx.vaccineRecord.findFirst({
        where: { familyId, babyId, vaccineId, doseNumber: input.doseNumber, recordStatus: "completed", isCompleted: true, administeredDate: { not: null, lte: today }, deletedAt: null },
        select: { id: true },
      });
      await tx.familySyncState.update({ where: { familyId }, data: { cursor: { increment: 1 } } });
      return { ...selection, completed: completedRecord !== null };
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
