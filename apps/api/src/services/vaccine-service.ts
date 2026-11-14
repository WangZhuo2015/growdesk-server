import crypto from "node:crypto";
import { Prisma, type PrismaClient } from "@growdesk/database";
import { UserPrincipal } from "@growdesk/domain";
import {
  CreateVaccineRecordRequest,
  UpdateVaccineRecordRequest,
  VaccineRecord,
  VaccineScheduleItem,
  VaccineSelection,
  UpsertVaccineSelectionRequest,
  VaccineCatalogResponse,
} from "@growdesk/contracts";
import { BabyAccessDeniedError, BadRequestError, ConcurrencyConflictError, IdempotencyKeyReusedError, RecordNotFoundError } from "@growdesk/database";
import { referenceData } from "../knowledge/legacy-reference-data.js";
import { vaccineEngineRules } from "../knowledge/vaccine-engine-rules.js";

type StoredVaccineRecord = Prisma.VaccineRecordGetPayload<Prisma.VaccineRecordDefaultArgs>;
type VaccineInput = CreateVaccineRecordRequest | UpdateVaccineRecordRequest;

function vaccineRecordDTO(row: StoredVaccineRecord): VaccineRecord {
  return {
    id: row.id, babyId: row.babyId, familyId: row.familyId, vaccineCode: row.vaccineCode,
    vaccineId: row.vaccineId, doseNumber: row.doseNumber, legacyName: row.legacyName, legacyDose: row.legacyDose,
    administeredDate: row.administeredDate.toISOString().slice(0, 10),
    scheduledDate: row.scheduledDate?.toISOString().slice(0, 10) ?? null,
    completedDate: row.completedDate?.toISOString().slice(0, 10) ?? null,
    isCompleted: row.isCompleted, clinic: row.clinic, batchNumber: row.batchNumber,
    manufacturer: row.manufacturer, productName: row.productName,
    traceabilityCode: row.traceabilityCode, injectionSite: row.injectionSite,
    notes: row.notes, version: String(row.version),
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

function calendarDate(value: string | undefined, field: string): Date {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestError(`Enter a complete YYYY-MM-DD ${field}`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new BadRequestError(`Invalid ${field}`);
  }
  return date;
}

export function vaccineRecordDates(input: VaccineInput, existing?: Pick<StoredVaccineRecord, "administeredDate" | "scheduledDate" | "isCompleted">) {
  const isCompleted = input.isCompleted ?? existing?.isCompleted ?? true;
  if (existing && !existing.isCompleted && isCompleted && input.administeredDate === undefined) {
    throw new BadRequestError("Enter the actual administration date before completing a planned vaccination");
  }
  const day = input.administeredDate ?? existing?.administeredDate.toISOString().slice(0, 10);
  let administeredDate = calendarDate(day, "administration date");
  const scheduledDate = input.scheduledDate === undefined
    ? existing?.scheduledDate ?? null
    : input.scheduledDate === null ? null : calendarDate(input.scheduledDate, "scheduled date");
  if (!isCompleted && scheduledDate === null) {
    throw new BadRequestError("A planned vaccination requires an explicit scheduled date");
  }
  if (!isCompleted && scheduledDate) administeredDate = scheduledDate;
  if (input.completedDate !== undefined) {
    if (isCompleted && input.completedDate !== day) {
      throw new BadRequestError("Completed date must match the actual administration date");
    }
    if (!isCompleted && input.completedDate !== null) {
      throw new BadRequestError("A planned vaccination cannot have a completed date");
    }
  }
  return { administeredDate, scheduledDate, completedDate: isCompleted ? administeredDate : null, isCompleted };
}

function vaccineVersion(value: string): bigint {
  if (!/^[1-9]\d*$/.test(value) || BigInt(value) > 2147483647n) {
    throw new BadRequestError("baseVersion must be a positive integer string within the persisted version range", "INVALID_BASE_VERSION");
  }
  return BigInt(value);
}

function vaccineBookletFields(input: VaccineInput) {
  return {
    doseNumber: input.doseNumber, legacyName: input.legacyName, legacyDose: input.legacyDose,
    clinic: input.clinic, batchNumber: input.batchNumber, notes: input.notes,
    manufacturer: input.manufacturer, productName: input.productName,
    traceabilityCode: input.traceabilityCode, injectionSite: input.injectionSite,
  };
}

async function vaccineReference(tx: Prisma.TransactionClient, input: VaccineInput, existing?: StoredVaccineRecord) {
  if (input.vaccineCode !== undefined && input.vaccineCode.trim() === "") {
    throw new BadRequestError("Vaccine name or code is required");
  }
  if (existing && input.vaccineId === null) {
    return { vaccineId: null, vaccineCode: input.vaccineCode ?? existing.vaccineCode };
  }
  if (existing && input.vaccineId === undefined && input.vaccineCode === undefined) {
    return { vaccineId: existing.vaccineId, vaccineCode: existing.vaccineCode };
  }
  const vaccine = input.vaccineId
    ? await tx.vaccine.findUnique({ where: { id: input.vaccineId }, select: { id: true, vaccineCode: true } })
    : input.vaccineCode ? await tx.vaccine.findUnique({ where: { vaccineCode: input.vaccineCode }, select: { id: true, vaccineCode: true } }) : null;
  if (input.vaccineId && !vaccine) throw new RecordNotFoundError("vaccine", input.vaccineId);
  return { vaccineId: vaccine?.id ?? null, vaccineCode: vaccine?.vaccineCode ?? input.vaccineCode ?? existing?.vaccineCode ?? "" };
}

async function projectVaccineRecord(tx: Prisma.TransactionClient, row: StoredVaccineRecord) {
  const scope = { familyId: row.familyId, babyId: row.babyId, entityType: "vaccine", entityId: row.id };
  if (!row.isCompleted) {
    await tx.timelineEntry.updateMany({ where: { ...scope, deletedAt: null }, data: { deletedAt: new Date(), version: { increment: 1 } } });
    return;
  }
  const details = {
    doseNumber: row.doseNumber, clinic: row.clinic, batchNumber: row.batchNumber,
    manufacturer: row.manufacturer, productName: row.productName,
    traceabilityCode: row.traceabilityCode, injectionSite: row.injectionSite,
  };
  const summary = `接种疫苗: ${row.legacyName?.trim() ? row.legacyName : row.vaccineCode}`;
  await tx.timelineEntry.upsert({
    where: { uq_timeline_entries_entity: scope },
    create: { id: crypto.randomUUID(), ...scope, occurredAt: row.administeredDate, summary, details, source: "ui_manual", version: 1 },
    update: { occurredAt: row.administeredDate, summary, details, deletedAt: null, version: { increment: 1 } },
  });
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
    principal: UserPrincipal, babyId: string, requireWrite = false,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<{ familyId: string }> {
    const membership = await client.babyMember.findUnique({
      where: { uq_baby_members_user_baby: { userId: principal.userId, babyId } },
      include: { baby: { select: { deletedAt: true } }, family: { select: { deletedAt: true } } },
    });
    if (!membership || membership.deletedAt || membership.status !== "active" || membership.baby.deletedAt || membership.family.deletedAt || (requireWrite && membership.role === "viewer")) {
      throw new BabyAccessDeniedError(babyId);
    }
    const familyMembership = await client.familyMember.findUnique({
      where: { uq_family_members_family_user: { familyId: membership.familyId, userId: principal.userId } },
    });
    if (!familyMembership || familyMembership.deletedAt || familyMembership.status !== "active"
      || (requireWrite && familyMembership.role === "viewer")
      || !["admin", "member", "viewer"].includes(familyMembership.role)
      || !["admin", "member", "viewer"].includes(membership.role)) throw new BabyAccessDeniedError(babyId);
    return { familyId: membership.familyId };
  }

  private async lockVaccineScope(tx: Prisma.TransactionClient, principal: UserPrincipal, babyId: string) {
    const { familyId } = await this.assertBabyAccess(principal, babyId, true, tx);
    await tx.$executeRaw`
      INSERT INTO "public"."family_sync_states" ("family_id", "epoch", "cursor", "created_at", "updated_at")
      VALUES (${familyId}, ${crypto.randomUUID()}, 0, NOW(), NOW()) ON CONFLICT ("family_id") DO NOTHING
    `;
    await tx.$queryRaw`SELECT 1 FROM "public"."family_sync_states" WHERE "family_id" = ${familyId} FOR UPDATE`;
    const current = await this.assertBabyAccess(principal, babyId, true, tx);
    if (current.familyId !== familyId) throw new BabyAccessDeniedError(babyId);
    return current;
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

  async listVaccineRecords(principal: UserPrincipal, babyId: string): Promise<VaccineRecord[]> {
    const { familyId } = await this.assertBabyAccess(principal, babyId);
    const rows = await this.prisma.vaccineRecord.findMany({
      where: { familyId, babyId, deletedAt: null }, orderBy: [{ administeredDate: "desc" }, { id: "desc" }],
    });
    return rows.map(vaccineRecordDTO);
  }

  async createVaccineRecord(principal: UserPrincipal, babyId: string, input: CreateVaccineRecordRequest, idempotencyKey?: string): Promise<VaccineRecord> {
    const requestHash = crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const result = await this.prisma.$transaction(async (tx) => {
      const { familyId } = await this.lockVaccineScope(tx, principal, babyId);
      if (idempotencyKey) {
        const receipt = await tx.idempotencyReceipt.findUnique({ where: { pk_idempotency_receipts: { actorId: principal.userId, scopeId: familyId, commandId: idempotencyKey } } });
        if (receipt) {
          if (receipt.requestHash !== requestHash) throw new IdempotencyKeyReusedError(idempotencyKey);
          const body = receipt.responseBody as { id?: string } | null;
          const record = body?.id ? await tx.vaccineRecord.findUnique({ where: { id: body.id } }) : null;
          if (!record || record.deletedAt || record.familyId !== familyId || record.babyId !== babyId) throw new IdempotencyKeyReusedError(idempotencyKey);
          return record;
        }
      }
      const dates = vaccineRecordDates(input);
      const reference = await vaccineReference(tx, input);
      const row = await tx.vaccineRecord.create({ data: {
        id: crypto.randomUUID(), familyId, babyId, caregiverId: principal.userId,
        ...reference, ...vaccineBookletFields(input), ...dates, version: 1,
      } });
      await projectVaccineRecord(tx, row);
      if (idempotencyKey) {
        await tx.idempotencyReceipt.create({ data: {
          actorId: principal.userId, scopeId: familyId, commandId: idempotencyKey,
          requestHash, resultCode: 200, responseBody: { id: row.id },
        } });
      }
      await tx.familySyncState.update({ where: { familyId }, data: { cursor: { increment: 1 } } });
      return row;
    });
    return vaccineRecordDTO(result);
  }

  async updateVaccineRecord(principal: UserPrincipal, babyId: string, recordId: string, input: UpdateVaccineRecordRequest): Promise<VaccineRecord> {
    const baseVersion = vaccineVersion(input.baseVersion);
    const result = await this.prisma.$transaction(async (tx) => {
      const { familyId } = await this.lockVaccineScope(tx, principal, babyId);
      await tx.$queryRaw`SELECT id FROM "public"."vaccine_records" WHERE id=${recordId} AND family_id=${familyId} AND baby_id=${babyId} AND deleted_at IS NULL FOR UPDATE`;
      const existing = await tx.vaccineRecord.findUnique({ where: { id: recordId } });
      if (!existing || existing.deletedAt || existing.familyId !== familyId || existing.babyId !== babyId) throw new RecordNotFoundError("VaccineRecord", recordId);
      if (BigInt(existing.version) !== baseVersion || baseVersion >= 2147483647n) throw new ConcurrencyConflictError("Vaccination record changed; reload before saving");
      const dates = vaccineRecordDates(input, existing);
      const reference = await vaccineReference(tx, input, existing);
      const row = await tx.vaccineRecord.update({ where: { id: recordId }, data: {
        ...reference, ...vaccineBookletFields(input), ...dates, version: { increment: 1 },
      } });
      await projectVaccineRecord(tx, row);
      await tx.familySyncState.update({ where: { familyId }, data: { cursor: { increment: 1 } } });
      return row;
    });
    return vaccineRecordDTO(result);
  }

  async listVaccineSelections(principal: UserPrincipal, babyId: string): Promise<VaccineSelection[]> {
    return this.prisma.$transaction(async (tx) => {
      const { familyId } = await this.assertBabyAccess(principal, babyId, false, tx);
      const rows = await tx.vaccineSelection.findMany({ where: { familyId, babyId }, orderBy: [{ vaccineId: "asc" }, { doseNumber: "asc" }] });
      const records = await tx.vaccineRecord.findMany({ where: { familyId, babyId, isCompleted: true, deletedAt: null }, select: { vaccineId: true, doseNumber: true } });
      const completed = new Set(records.filter(row => row.vaccineId !== null && row.doseNumber !== null).map(row => `${row.vaccineId}:${row.doseNumber}`));
      return rows.map(row => ({ ...row, completed: completed.has(`${row.vaccineId}:${row.doseNumber}`), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }));
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async upsertVaccineSelection(principal: UserPrincipal, babyId: string, input: UpsertVaccineSelectionRequest): Promise<VaccineSelection> {
    const result = await this.prisma.$transaction(async (tx) => {
      const { familyId } = await this.lockVaccineScope(tx, principal, babyId);
      const vaccine = await tx.vaccine.findUnique({ where: { id: input.vaccineId }, select: { id: true } })
        ?? await tx.vaccine.findUnique({ where: { vaccineCode: input.vaccineId }, select: { id: true } });
      if (!vaccine) throw new RecordNotFoundError("vaccine", input.vaccineId);
      const vaccineId = vaccine.id;
      const existing = await tx.vaccineSelection.findUnique({ where: { uq_vaccine_selections_baby_vaccine_dose: { babyId, vaccineId, doseNumber: input.doseNumber } } });
      const completed = await tx.vaccineRecord.count({ where: { familyId, babyId, vaccineId, doseNumber: input.doseNumber, isCompleted: true, deletedAt: null } }) > 0;
      if (input.completed !== undefined && input.completed !== completed) {
        throw new BadRequestError("接种状态由实际记录确定，请在接种记录中填写或更正接种日期。", "VACCINE_RECORD_REQUIRED");
      }
      if (existing && ((input.baseVersion !== undefined && input.baseVersion !== existing.version) || existing.version >= 2147483647)) {
        throw new ConcurrencyConflictError("Vaccine selection changed; reload before saving");
      }
      const selected = input.selected ?? existing?.selected ?? true;
      if (existing && selected === existing.selected) return { ...existing, completed };
      const row = existing
        ? await tx.vaccineSelection.update({ where: { id: existing.id }, data: { selected, completed, version: { increment: 1 } } })
        : await tx.vaccineSelection.create({ data: { id: crypto.randomUUID(), familyId, babyId, vaccineId, doseNumber: input.doseNumber, selected, completed, version: 1 } });
      await tx.familySyncState.update({ where: { familyId }, data: { cursor: { increment: 1 } } });
      return row;
    });
    return { ...result, createdAt: result.createdAt.toISOString(), updatedAt: result.updatedAt.toISOString() };
  }

  async deleteVaccineRecord(principal: UserPrincipal, babyId: string, recordId: string, observedVersion?: string): Promise<{ data: { id: string; deleted: true } }> {
    const baseVersion = observedVersion === undefined ? undefined : vaccineVersion(observedVersion);
    await this.prisma.$transaction(async (tx) => {
      const { familyId } = await this.lockVaccineScope(tx, principal, babyId);
      await tx.$queryRaw`SELECT id FROM "public"."vaccine_records" WHERE id=${recordId} AND family_id=${familyId} AND baby_id=${babyId} AND deleted_at IS NULL FOR UPDATE`;
      const existing = await tx.vaccineRecord.findUnique({ where: { id: recordId } });
      if (!existing || existing.deletedAt || existing.babyId !== babyId || existing.familyId !== familyId) throw new RecordNotFoundError("VaccineRecord", recordId);
      if ((baseVersion !== undefined && BigInt(existing.version) !== baseVersion) || existing.version >= 2147483647) {
        throw new ConcurrencyConflictError("Vaccination record changed; reload before deleting");
      }
      const deletedAt = new Date();
      await tx.vaccineRecord.update({ where: { id: recordId }, data: { deletedAt, version: { increment: 1 } } });
      await tx.timelineEntry.updateMany({ where: { familyId, babyId, entityType: "vaccine", entityId: recordId, deletedAt: null }, data: { deletedAt, version: { increment: 1 } } });
      await tx.familySyncState.update({ where: { familyId }, data: { cursor: { increment: 1 } } });
    });
    return { data: { id: recordId, deleted: true } };
  }
}
