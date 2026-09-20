/**
 * Backfill references from promoted legacy attachments into canonical records.
 *
 * The attachment promotion worker deliberately stops at a verified, private
 * `Attachment` row.  This module is the separate business-reference boundary:
 * it proves the immutable import row and the attachment promotion receipt,
 * locks the canonical target, then links only the fields that the canonical
 * schema actually supports.  It never copies an object and never writes a
 * legacy/public URL into a business record.
 */

import { createHash } from "node:crypto";
import {
  ATTACHMENT_PROMOTION_MAPPING_VERSION,
  type PlannedAttachmentReport,
  type PlannedAttachmentReceipt,
} from "./attachment-promotion-runtime.js";
import { Prisma, type PrismaClient } from "@growdesk/database";

export const ATTACHMENT_REFERENCE_BACKFILL_MAPPING_VERSION = "attachment-reference-backfill-v1";
export const ATTACHMENT_REFERENCE_ENTITY_TYPE = "attachment_reference";

const SHA256 = /^[0-9a-f]{64}$/;
const PRIVATE_AVATAR_PATH = /^\/api\/attachments\/[a-f0-9-]{36}$/i;

type SupportedReferenceKind = "baby_avatar" | "growth_photo" | "medical_report" | "ai_message_image";
type SupportedSourceTable = "Baby" | "GrowthMeasurement" | "MedicalReport" | "AiChatMessage";

interface ReferenceRule {
  readonly table: SupportedSourceTable;
  readonly field: string;
  readonly kind: SupportedReferenceKind;
  readonly purpose: string;
}

const REFERENCE_RULES: readonly ReferenceRule[] = [
  { table: "Baby", field: "avatarUrl", kind: "baby_avatar", purpose: "avatar" },
  { table: "GrowthMeasurement", field: "imageUrl", kind: "growth_photo", purpose: "growth_photo" },
  { table: "MedicalReport", field: "imageUrl", kind: "medical_report", purpose: "medical_report" },
  { table: "AiChatMessage", field: "image", kind: "ai_message_image", purpose: "ai_input" },
];

export interface PlannedBusinessAttachmentReference {
  readonly sourceSystem: string;
  readonly sourceBatchId: string;
  readonly sourceTable: SupportedSourceTable;
  readonly sourceId: string;
  readonly sourceField: string;
  readonly sourcePath: string;
  readonly sourceHash: string;
  readonly sourceKey: string;
  readonly targetAttachmentId: string;
  readonly kind: SupportedReferenceKind;
  readonly purpose: string;
  /** The Baby ID is known directly for avatar rows; other targets resolve via their legacy receipt. */
  readonly targetBabyId: string | null;
}

export interface ReferenceBackfillQuarantine {
  readonly code: string;
  readonly message: string;
  readonly sourceKey?: string;
  readonly sourceTable?: string;
  readonly sourceId?: string;
  readonly sourceField?: string;
  readonly sourcePath?: string;
  readonly targetAttachmentId?: string;
}

export interface AttachmentReferenceBackfillPlan {
  readonly mappingVersion: string;
  readonly sourceMappingVersion: string;
  readonly status: "planned" | "quarantined";
  readonly references: readonly PlannedBusinessAttachmentReference[];
  readonly quarantine: readonly ReferenceBackfillQuarantine[];
}

export type ReferenceBackfillReceiptStatus = "committed" | "replayed" | "reconciled";

export interface ReferenceBackfillReceipt {
  readonly sourceKey: string;
  readonly targetEntityType: "baby" | "growth" | "medical" | "ai_message";
  readonly targetEntityId: string;
  readonly targetAttachmentId: string;
  readonly status: ReferenceBackfillReceiptStatus;
}

export interface AttachmentReferenceBackfillExecutionReport {
  readonly mappingVersion: string;
  readonly status: "completed" | "quarantined";
  readonly receipts: readonly ReferenceBackfillReceipt[];
  readonly quarantine: readonly ReferenceBackfillQuarantine[];
  readonly counts: {
    readonly planned: number;
    readonly committed: number;
    readonly replayed: number;
    readonly reconciled: number;
    readonly quarantined: number;
  };
  readonly storage: {
    readonly database: "ready" | "not_written";
    readonly objectStore: "not_written";
  };
}

type Db = PrismaClient;
type Tx = Prisma.TransactionClient;

class ReferenceBackfillFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Partial<ReferenceBackfillQuarantine>,
  ) {
    super(message);
    this.name = "ReferenceBackfillFailure";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1000) {
    throw new ReferenceBackfillFailure("INVALID_RECEIPT", `${field} must be a non-empty string`);
  }
  if ([...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  })) {
    throw new ReferenceBackfillFailure("INVALID_RECEIPT", `${field} contains a control character`);
  }
  return value;
}

function hash(value: unknown, field: string): string {
  const result = nonEmpty(value, field);
  if (!SHA256.test(result)) throw new ReferenceBackfillFailure("INVALID_HASH", `${field} must be a lowercase SHA-256`);
  return result;
}

function normalizedSourcePath(value: unknown): string {
  const result = nonEmpty(value, "sourcePath");
  if (result.includes("\\") || result.includes("%") || result.startsWith("/") || result.includes("?") || result.includes("#")) {
    throw new ReferenceBackfillFailure("INVALID_SOURCE_PATH", "sourcePath must be a normalized archive-relative path");
  }
  const parts = result.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new ReferenceBackfillFailure("INVALID_SOURCE_PATH", "sourcePath contains an unsafe segment");
  }
  if (!result.startsWith("public/uploads/") && !result.startsWith("data/archive/")) {
    throw new ReferenceBackfillFailure("INVALID_SOURCE_PATH", "sourcePath is outside the captured attachment roots");
  }
  return result;
}

function sourceKeyOf(receipt: Pick<PlannedAttachmentReceipt, "sourceBatchId" | "sourceTable" | "sourceId" | "sourceField" | "sourcePath">): string {
  return [receipt.sourceBatchId, receipt.sourceTable, receipt.sourceId, receipt.sourceField, receipt.sourcePath].join("/");
}

function businessSourceKey(reference: PlannedBusinessAttachmentReference): string {
  return reference.sourceKey;
}

function ruleFor(table: string, field: string): ReferenceRule | undefined {
  return REFERENCE_RULES.find((rule) => rule.table === table && rule.field === field);
}

function quarantineFromReceipt(error: unknown, receipt: unknown): ReferenceBackfillQuarantine {
  const failure = error instanceof ReferenceBackfillFailure
    ? error
    : new ReferenceBackfillFailure("INVALID_RECEIPT", "attachment reference receipt is invalid");
  const details = isRecord(receipt)
    ? {
        ...(typeof receipt.sourceTable === "string" ? { sourceTable: receipt.sourceTable } : {}),
        ...(typeof receipt.sourceId === "string" ? { sourceId: receipt.sourceId } : {}),
        ...(typeof receipt.sourceField === "string" ? { sourceField: receipt.sourceField } : {}),
        ...(typeof receipt.sourcePath === "string" ? { sourcePath: receipt.sourcePath } : {}),
        ...(typeof receipt.targetAttachmentId === "string" ? { targetAttachmentId: receipt.targetAttachmentId } : {}),
      }
    : {};
  return { code: failure.code, message: failure.message, ...details, ...failure.details };
}

function validateReceipt(raw: unknown): PlannedBusinessAttachmentReference | null {
  if (!isRecord(raw)) throw new ReferenceBackfillFailure("INVALID_RECEIPT", "attachment receipt must be an object");
  const sourceSystem = nonEmpty(raw.sourceSystem, "sourceSystem");
  const sourceBatchId = hash(raw.sourceBatchId, "sourceBatchId");
  const sourceTable = nonEmpty(raw.sourceTable, "sourceTable");
  const sourceId = nonEmpty(raw.sourceId, "sourceId");
  const sourceField = nonEmpty(raw.sourceField, "sourceField");
  const sourcePath = normalizedSourcePath(raw.sourcePath);
  const sourceHash = hash(raw.sourceHash, "sourceHash");
  const targetAttachmentId = nonEmpty(raw.targetAttachmentId, "targetAttachmentId");
  const attachment = raw.attachment;
  if (!isRecord(attachment)) throw new ReferenceBackfillFailure("INVALID_RECEIPT", "attachment metadata is missing");
  if (attachment.id !== targetAttachmentId) throw new ReferenceBackfillFailure("TARGET_ID_MISMATCH", "target attachment does not match receipt");
  if (attachment.status !== "pending" && attachment.status !== "ready") {
    throw new ReferenceBackfillFailure("INVALID_STATUS", "attachment receipt is not pending/ready");
  }
  if (attachment.purpose !== "avatar" && attachment.purpose !== "growth_photo" && attachment.purpose !== "medical_report" && attachment.purpose !== "voice_note" && attachment.purpose !== "ai_input") {
    throw new ReferenceBackfillFailure("INVALID_PURPOSE", "attachment purpose is not supported");
  }
  if (raw.targetSha256 !== attachment.sha256 || raw.targetByteSize !== attachment.byteSize || raw.targetObjectKey !== attachment.objectKey) {
    throw new ReferenceBackfillFailure("TARGET_METADATA_MISMATCH", "attachment receipt metadata does not match its target");
  }
  // AiArchive materialization consumes this receipt directly into
  // ai_archive_entries.attachment_id. It is not a second business reference.
  if (sourceTable === "AiArchive" && sourceField === "filePath") return null;
  const rule = ruleFor(sourceTable, sourceField);
  if (!rule) {
    throw new ReferenceBackfillFailure(
      "UNSUPPORTED_REFERENCE",
      "canonical schema has no approved reference field for this legacy attachment source",
    );
  }
  if (attachment.purpose !== rule.purpose) {
    throw new ReferenceBackfillFailure("PURPOSE_MISMATCH", "attachment purpose does not match the legacy reference field");
  }
  const babyId = attachment.babyId === null ? null : nonEmpty(attachment.babyId, "attachment.babyId");
  if (rule.kind !== "baby_avatar" && rule.kind !== "ai_message_image" && babyId === null) {
    throw new ReferenceBackfillFailure("MISSING_BABY_SCOPE", "growth and medical attachments must carry a baby scope");
  }
  const candidate = {
    sourceSystem,
    sourceBatchId,
    sourceTable: rule.table,
    sourceId,
    sourceField: rule.field,
    sourcePath,
    sourceHash,
    sourceKey: sourceKeyOf({ sourceBatchId, sourceTable: rule.table, sourceId, sourceField: rule.field, sourcePath }),
    targetAttachmentId,
    kind: rule.kind,
    purpose: rule.purpose,
    targetBabyId: rule.kind === "baby_avatar" ? sourceId : babyId,
  } satisfies PlannedBusinessAttachmentReference;
  if (candidate.sourceKey.length > 1000) throw new ReferenceBackfillFailure("INVALID_RECEIPT", "source key is too long");
  return candidate;
}

/**
 * Pure planning boundary.  Unknown AI/voice references are intentionally
 * quarantined; a caller must not turn them into guessed canonical fields.
 */
export function planAttachmentReferenceBackfill(report: PlannedAttachmentReport): AttachmentReferenceBackfillPlan {
  const quarantine: ReferenceBackfillQuarantine[] = [];
  const references: PlannedBusinessAttachmentReference[] = [];
  if (!report || report.mappingVersion !== ATTACHMENT_PROMOTION_MAPPING_VERSION || !Array.isArray(report.receipts)) {
    quarantine.push({ code: "MAPPING_VERSION_MISMATCH", message: "attachment promotion report is missing or uses an unsupported mapping version" });
    return {
      mappingVersion: ATTACHMENT_REFERENCE_BACKFILL_MAPPING_VERSION,
      sourceMappingVersion: ATTACHMENT_PROMOTION_MAPPING_VERSION,
      status: "quarantined",
      references,
      quarantine,
    };
  }
  const seen = new Set<string>();
  for (const receipt of report.receipts) {
    try {
      const reference = validateReceipt(receipt);
      if (reference === null) continue;
      if (seen.has(reference.sourceKey)) throw new ReferenceBackfillFailure("DUPLICATE_SOURCE_REFERENCE", "source reference appears more than once");
      seen.add(reference.sourceKey);
      references.push(reference);
    } catch (error) {
      quarantine.push(quarantineFromReceipt(error, receipt));
    }
  }
  return {
    mappingVersion: ATTACHMENT_REFERENCE_BACKFILL_MAPPING_VERSION,
    sourceMappingVersion: ATTACHMENT_PROMOTION_MAPPING_VERSION,
    status: quarantine.length ? "quarantined" : "planned",
    references,
    quarantine,
  };
}

function metadataObject(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function privateAvatarPath(attachmentId: string): string {
  const value = `/api/attachments/${attachmentId}`;
  if (!PRIVATE_AVATAR_PATH.test(value)) throw new ReferenceBackfillFailure("INVALID_ATTACHMENT_ID", "avatar attachment ID cannot form a protected path");
  return value;
}

function normalizedLegacyPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new ReferenceBackfillFailure("SOURCE_REFERENCE_MISMATCH", "legacy source reference is missing");
  if (value.includes("\\") || value.includes("%") || value.includes("?") || value.includes("#")) {
    throw new ReferenceBackfillFailure("SOURCE_REFERENCE_MISMATCH", "legacy source reference is encoded or has a query/fragment");
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("//")) {
    throw new ReferenceBackfillFailure("PUBLIC_URL_REJECTED", "legacy public/external URL cannot become a canonical reference");
  }
  const normalized = value.replace(/^\/+/, "").replace(/^uploads\//, "public/uploads/");
  const parts = normalized.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new ReferenceBackfillFailure("SOURCE_REFERENCE_MISMATCH", "legacy source reference contains an unsafe path segment");
  }
  if (!normalized.startsWith("public/uploads/") && !normalized.startsWith("data/archive/")) {
    throw new ReferenceBackfillFailure("SOURCE_REFERENCE_MISMATCH", "legacy source reference is outside the captured archive roots");
  }
  return normalized;
}

function jsonField(payload: Prisma.JsonValue, field: string): unknown {
  if (!isRecord(payload)) throw new ReferenceBackfillFailure("SOURCE_ROW_INVALID", "legacy import payload is not an object");
  return payload[field];
}

function expectedBusinessMappingType(kind: SupportedReferenceKind): "growth" | "medical" | "ai_message" {
  if (kind === "growth_photo") return "growth";
  if (kind === "medical_report") return "medical";
  if (kind === "ai_message_image") return "ai_message";
  throw new ReferenceBackfillFailure("INTERNAL_REFERENCE_ERROR", "baby avatars do not have a business idempotency mapping");
}

function referenceMappingId(sourceKey: string): string {
  return `attachment-reference:${createHash("sha256").update(`${ATTACHMENT_REFERENCE_BACKFILL_MAPPING_VERSION}/${sourceKey}`).digest("hex").slice(0, 48)}`;
}

function metadataFor(reference: PlannedBusinessAttachmentReference, targetEntityId: string): Prisma.InputJsonValue {
  return {
    kind: reference.kind,
    targetEntityType: reference.kind === "baby_avatar" ? "baby" : reference.kind === "growth_photo" ? "growth" : reference.kind === "medical_report" ? "medical" : "ai_message",
    targetEntityId,
    targetField: reference.kind === "baby_avatar" ? "avatarUrl" : reference.kind === "growth_photo" ? "attachmentId" : reference.kind === "medical_report" ? "attachments" : "image",
    attachmentId: reference.targetAttachmentId,
    sourceBatchId: reference.sourceBatchId,
    sourceTable: reference.sourceTable,
    sourceId: reference.sourceId,
    sourceField: reference.sourceField,
    sourcePath: reference.sourcePath,
    sourceHash: reference.sourceHash,
    storageState: "ready",
  };
}

function jsonEqual(left: Prisma.JsonValue | null, right: Prisma.InputJsonValue): boolean {
  const canonical = (value: unknown): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  };
  return canonical(left) === canonical(right);
}

async function verifyImportProof(tx: Tx, reference: PlannedBusinessAttachmentReference): Promise<Prisma.JsonValue> {
  const batch = await tx.legacyImportBatch.findUnique({
    where: { id: reference.sourceBatchId },
    select: { id: true, sourceSystem: true, checksum: true, mappingVersion: true },
  });
  if (!batch || batch.checksum !== reference.sourceBatchId || batch.sourceSystem !== reference.sourceSystem || batch.mappingVersion !== "identity-v1") {
    throw new ReferenceBackfillFailure("SOURCE_BATCH_MISMATCH", "legacy attachment source batch proof is missing or conflicts", { sourceKey: reference.sourceKey });
  }
  const sourceRow = await tx.legacyImportRow.findUnique({
    where: { pk_legacy_import_rows: { batchId: reference.sourceBatchId, sourceTable: reference.sourceTable, sourceId: reference.sourceId } },
    select: { batchId: true, sourceTable: true, sourceId: true, familyId: true, babyId: true, payload: true, payloadHash: true },
  });
  if (!sourceRow || sourceRow.payloadHash !== reference.sourceHash) {
    throw new ReferenceBackfillFailure("SOURCE_HASH_MISMATCH", "legacy attachment source row hash does not match the promotion receipt", { sourceKey: reference.sourceKey });
  }
  if (sourceRow.batchId !== reference.sourceBatchId || sourceRow.sourceTable !== reference.sourceTable || sourceRow.sourceId !== reference.sourceId) {
    throw new ReferenceBackfillFailure("SOURCE_ROW_MISMATCH", "legacy source row identity does not match the promotion receipt", { sourceKey: reference.sourceKey });
  }
  const payloadId = jsonField(sourceRow.payload, "id");
  if (payloadId !== reference.sourceId) throw new ReferenceBackfillFailure("SOURCE_ROW_MISMATCH", "legacy source payload ID does not match its archive key", { sourceKey: reference.sourceKey });
  const rawReference = jsonField(sourceRow.payload, reference.sourceField);
  if (normalizedLegacyPath(rawReference) !== reference.sourcePath) {
    throw new ReferenceBackfillFailure("SOURCE_REFERENCE_MISMATCH", "legacy source field does not match the promoted archive path", { sourceKey: reference.sourceKey });
  }
  return sourceRow.payload;
}

async function verifyAttachmentProof(tx: Tx, reference: PlannedBusinessAttachmentReference): Promise<void> {
  await tx.$queryRaw`SELECT id FROM public.attachments WHERE id = ${reference.targetAttachmentId} FOR UPDATE`;
  const attachment = await tx.attachment.findUnique({ where: { id: reference.targetAttachmentId } });
  if (!attachment || attachment.deletedAt !== null || attachment.status !== "ready") {
    throw new ReferenceBackfillFailure("ATTACHMENT_NOT_READY", "attachment is not a verified ready row", { targetAttachmentId: reference.targetAttachmentId });
  }
  if (attachment.familyId.length === 0 || attachment.purpose !== reference.purpose) {
    throw new ReferenceBackfillFailure("ATTACHMENT_SCOPE_MISMATCH", "attachment family or purpose is not compatible with the legacy reference", { targetAttachmentId: reference.targetAttachmentId });
  }
  if (reference.kind !== "baby_avatar" && attachment.babyId !== reference.targetBabyId) {
    throw new ReferenceBackfillFailure("ATTACHMENT_SCOPE_MISMATCH", "attachment baby scope does not match the legacy reference", { targetAttachmentId: reference.targetAttachmentId });
  }
  if (reference.kind === "baby_avatar" && attachment.babyId !== null && attachment.babyId !== reference.sourceId) {
    throw new ReferenceBackfillFailure("ATTACHMENT_SCOPE_MISMATCH", "avatar attachment is already scoped to a different baby", { targetAttachmentId: reference.targetAttachmentId });
  }
  const attachmentMapping = await tx.legacyIdempotencyMapping.findUnique({
    where: { uq_legacy_idempotency_type_source: { targetEntityType: "attachment", sourceKey: reference.sourceKey } },
    select: { targetEntityId: true, status: true, sourceSystem: true, sourceBatchId: true, sourceTable: true, sourceId: true, sourceHash: true, mappingVersion: true, metadata: true },
  });
  if (!attachmentMapping || attachmentMapping.targetEntityId !== reference.targetAttachmentId || attachmentMapping.status !== "mapped" ||
      attachmentMapping.sourceSystem !== reference.sourceSystem || attachmentMapping.sourceBatchId !== reference.sourceBatchId ||
      attachmentMapping.sourceTable !== reference.sourceTable || attachmentMapping.sourceId !== reference.sourceId ||
      attachmentMapping.sourceHash !== reference.sourceHash || attachmentMapping.mappingVersion !== ATTACHMENT_PROMOTION_MAPPING_VERSION) {
    throw new ReferenceBackfillFailure("ATTACHMENT_RECEIPT_MISMATCH", "verified Attachment is missing an exact promotion receipt", { targetAttachmentId: reference.targetAttachmentId });
  }
  const promotionMetadata = metadataObject(attachmentMapping.metadata);
  const promotionBabyScopeMatches = promotionMetadata?.babyId === attachment.babyId ||
    (reference.kind === "baby_avatar" && promotionMetadata?.babyId === null && attachment.babyId === reference.sourceId);
  if (!promotionMetadata || promotionMetadata.storageState !== "ready" || promotionMetadata.sourcePath !== reference.sourcePath ||
      promotionMetadata.familyId !== attachment.familyId || !promotionBabyScopeMatches ||
      promotionMetadata.uploaderId !== attachment.uploaderId || promotionMetadata.purpose !== reference.purpose ||
      promotionMetadata.mimeType !== attachment.mimeType || promotionMetadata.byteSize !== attachment.byteSize ||
      promotionMetadata.sha256 !== attachment.sha256 || promotionMetadata.objectKey !== attachment.objectKey) {
    throw new ReferenceBackfillFailure("ATTACHMENT_RECEIPT_MISMATCH", "attachment promotion metadata is incomplete or conflicts", { targetAttachmentId: reference.targetAttachmentId });
  }
  const family = await tx.family.findUnique({ where: { id: attachment.familyId }, select: { id: true, deletedAt: true } });
  const uploader = await tx.user.findUnique({ where: { id: attachment.uploaderId }, select: { id: true, deletedAt: true } });
  const familyMember = await tx.familyMember.findUnique({
    where: { uq_family_members_family_user: { familyId: attachment.familyId, userId: attachment.uploaderId } },
    select: { status: true, deletedAt: true },
  });
  if (!family || family.deletedAt !== null || !uploader || uploader.deletedAt !== null || !familyMember || familyMember.status !== "active" || familyMember.deletedAt !== null) {
    throw new ReferenceBackfillFailure("ATTACHMENT_OWNER_INVALID", "attachment owner is no longer an active family member", { targetAttachmentId: reference.targetAttachmentId });
  }
  if (reference.kind === "baby_avatar" && attachment.babyId === null) {
    const babyMember = await tx.babyMember.findUnique({
      where: { uq_baby_members_user_baby: { userId: attachment.uploaderId, babyId: reference.sourceId } },
      select: { familyId: true, status: true, deletedAt: true },
    });
    if (!babyMember || babyMember.familyId !== attachment.familyId || babyMember.status !== "active" || babyMember.deletedAt !== null) {
      throw new ReferenceBackfillFailure("ATTACHMENT_OWNER_INVALID", "unscoped avatar uploader is not assigned to the target baby", { targetAttachmentId: reference.targetAttachmentId });
    }
  }
}

async function verifyBusinessSourceMapping(tx: Tx, reference: PlannedBusinessAttachmentReference): Promise<{ targetEntityId: string; familyId: string; babyId: string | null }> {
  const targetEntityType = expectedBusinessMappingType(reference.kind);
  const sourceKey = reference.kind === "ai_message_image"
    ? `AiChatMessage:${reference.sourceId}`
    : `${reference.sourceBatchId}/${reference.sourceTable}/${reference.sourceId}`;
  const mapping = await tx.legacyIdempotencyMapping.findUnique({
    where: { uq_legacy_idempotency_type_source: { targetEntityType, sourceKey } },
    select: { targetEntityId: true, status: true, sourceSystem: true, sourceBatchId: true, sourceTable: true, sourceId: true, sourceHash: true, mappingVersion: true },
  });
  if (!mapping || mapping.status !== "mapped" || mapping.sourceSystem !== reference.sourceSystem || mapping.sourceBatchId !== reference.sourceBatchId ||
      mapping.sourceTable !== reference.sourceTable || mapping.sourceId !== reference.sourceId || mapping.sourceHash !== reference.sourceHash ||
      (reference.kind === "ai_message_image" && mapping.mappingVersion !== "ai-history-v1")) {
    throw new ReferenceBackfillFailure("BUSINESS_RECEIPT_MISMATCH", "canonical business target is missing an exact legacy materialization receipt", { sourceKey });
  }
  if (targetEntityType === "growth") {
    await tx.$queryRaw`SELECT id FROM public.growth_measurements WHERE id = ${mapping.targetEntityId} FOR UPDATE`;
    const target = await tx.growthMeasurement.findUnique({ where: { id: mapping.targetEntityId }, select: { id: true, familyId: true, babyId: true } });
    if (!target) throw new ReferenceBackfillFailure("BUSINESS_TARGET_MISSING", "growth target from legacy receipt is missing", { sourceKey });
    return { targetEntityId: target.id, familyId: target.familyId, babyId: target.babyId };
  }
  if (targetEntityType === "ai_message") {
    await tx.$queryRaw`SELECT id FROM public.ai_messages WHERE id = ${mapping.targetEntityId} FOR UPDATE`;
    const target = await tx.aiChatMessage.findUnique({
      where: { id: mapping.targetEntityId },
      select: {
        id: true,
        session: {
          select: {
            baby: { select: { id: true, familyId: true, deletedAt: true } },
            user: { select: { familyMemberships: { where: { status: "active", deletedAt: null }, select: { familyId: true } } } },
          },
        },
      },
    });
    if (!target) throw new ReferenceBackfillFailure("BUSINESS_TARGET_MISSING", "AI message target from legacy receipt is missing", { sourceKey });
    if (target.session.baby && target.session.baby.deletedAt === null) {
      return { targetEntityId: target.id, familyId: target.session.baby.familyId, babyId: target.session.baby.id };
    }
    const familyIds = [...new Set(target.session.user.familyMemberships.map((membership) => membership.familyId))];
    const familyId = familyIds[0];
    if (familyIds.length !== 1 || !familyId) throw new ReferenceBackfillFailure("BUSINESS_TARGET_SCOPE_AMBIGUOUS", "AI message without a baby does not have one unambiguous active family", { sourceKey });
    return { targetEntityId: target.id, familyId, babyId: null };
  }
  await tx.$queryRaw`SELECT id FROM public.medical_reports WHERE id = ${mapping.targetEntityId} FOR UPDATE`;
  const target = await tx.medicalReport.findUnique({ where: { id: mapping.targetEntityId }, select: { id: true, familyId: true, babyId: true } });
  if (!target) throw new ReferenceBackfillFailure("BUSINESS_TARGET_MISSING", "medical target from legacy receipt is missing", { sourceKey });
  return { targetEntityId: target.id, familyId: target.familyId, babyId: target.babyId };
}

async function verifyBabyTarget(tx: Tx, reference: PlannedBusinessAttachmentReference, payload: Prisma.JsonValue): Promise<{ targetEntityId: string; familyId: string; babyId: string | null }> {
  if (reference.sourceTable !== "Baby" || reference.sourceId !== reference.targetBabyId) {
    throw new ReferenceBackfillFailure("BABY_TARGET_MISMATCH", "avatar source ID is not the canonical Baby ID", { sourceKey: reference.sourceKey });
  }
  await tx.$queryRaw`SELECT id FROM public.babies WHERE id = ${reference.sourceId} FOR UPDATE`;
  const target = await tx.baby.findUnique({ where: { id: reference.sourceId }, select: { id: true, familyId: true, avatarUrl: true, avatarMetadata: true, deletedAt: true } });
  if (!target || target.deletedAt !== null) throw new ReferenceBackfillFailure("BUSINESS_TARGET_MISSING", "baby avatar target is missing or deleted", { sourceKey: reference.sourceKey });
  const payloadFamilyId = isRecord(payload) && typeof payload.familyId === "string" ? payload.familyId : null;
  if (payloadFamilyId !== null && payloadFamilyId !== target.familyId) throw new ReferenceBackfillFailure("SOURCE_SCOPE_MISMATCH", "legacy Baby row family differs from canonical target", { sourceKey: reference.sourceKey });
  return { targetEntityId: target.id, familyId: target.familyId, babyId: target.id };
}

async function applyReference(tx: Tx, reference: PlannedBusinessAttachmentReference, payload: Prisma.JsonValue): Promise<ReferenceBackfillReceipt> {
  await verifyAttachmentProof(tx, reference);
  const target = reference.kind === "baby_avatar" ? await verifyBabyTarget(tx, reference, payload) : await verifyBusinessSourceMapping(tx, reference);
  if (reference.kind !== "baby_avatar" && isRecord(payload)) {
    if (payload.babyId !== undefined && payload.babyId !== target.babyId) {
      throw new ReferenceBackfillFailure("SOURCE_SCOPE_MISMATCH", "legacy source row baby differs from canonical target", { sourceKey: reference.sourceKey });
    }
    if (payload.familyId !== undefined && payload.familyId !== target.familyId) {
      throw new ReferenceBackfillFailure("SOURCE_SCOPE_MISMATCH", "legacy source row family differs from canonical target", { sourceKey: reference.sourceKey });
    }
  }
  const attachment = await tx.attachment.findUnique({ where: { id: reference.targetAttachmentId }, select: { familyId: true, babyId: true } });
  if (!attachment || attachment.familyId !== target.familyId || (reference.kind !== "baby_avatar" && attachment.babyId !== target.babyId)) {
    throw new ReferenceBackfillFailure("REFERENCE_SCOPE_MISMATCH", "attachment and business target do not share a family/baby scope", { sourceKey: reference.sourceKey });
  }
  const targetEntityType = reference.kind === "baby_avatar" ? "baby" : reference.kind === "growth_photo" ? "growth" : reference.kind === "medical_report" ? "medical" : "ai_message";
  const metadata = metadataFor(reference, target.targetEntityId);
  const existingReference = await tx.legacyIdempotencyMapping.findUnique({
    where: { uq_legacy_idempotency_type_source: { targetEntityType: ATTACHMENT_REFERENCE_ENTITY_TYPE, sourceKey: businessSourceKey(reference) } },
    select: { targetEntityId: true, status: true, sourceSystem: true, sourceBatchId: true, sourceTable: true, sourceId: true, sourceHash: true, mappingVersion: true, metadata: true },
  });
  if (existingReference && (existingReference.targetEntityId !== target.targetEntityId || existingReference.status !== "mapped" ||
      existingReference.sourceSystem !== reference.sourceSystem || existingReference.sourceBatchId !== reference.sourceBatchId ||
      existingReference.sourceTable !== reference.sourceTable || existingReference.sourceId !== reference.sourceId ||
      existingReference.sourceHash !== reference.sourceHash || existingReference.mappingVersion !== ATTACHMENT_REFERENCE_BACKFILL_MAPPING_VERSION ||
      !jsonEqual(existingReference.metadata, metadata))) {
    throw new ReferenceBackfillFailure("IDEMPOTENCY_CONFLICT", "existing business reference mapping conflicts with the receipt", { sourceKey: reference.sourceKey });
  }
  let status: ReferenceBackfillReceiptStatus = existingReference ? "replayed" : "committed";
  if (reference.kind === "growth_photo") {
    const growth = await tx.growthMeasurement.findUnique({ where: { id: target.targetEntityId }, select: { attachmentId: true } });
    if (!growth) throw new ReferenceBackfillFailure("BUSINESS_TARGET_MISSING", "growth target disappeared while applying the reference", { sourceKey: reference.sourceKey });
    if (growth.attachmentId !== null && growth.attachmentId !== reference.targetAttachmentId) {
      throw new ReferenceBackfillFailure("BUSINESS_REFERENCE_CONFLICT", "growth target already references another attachment", { sourceKey: reference.sourceKey });
    }
    if (growth.attachmentId === null) {
      await tx.growthMeasurement.update({ where: { id: target.targetEntityId }, data: { attachmentId: reference.targetAttachmentId } });
      if (existingReference) status = "reconciled";
    }
  } else if (reference.kind === "medical_report") {
    const existingLink = await tx.medicalReportAttachment.findUnique({
      where: { uq_medical_report_attachments: { reportId: target.targetEntityId, attachmentId: reference.targetAttachmentId } },
      select: { id: true },
    });
    if (!existingLink) {
      await tx.medicalReportAttachment.create({ data: { id: referenceMappingId(reference.sourceKey), reportId: target.targetEntityId, attachmentId: reference.targetAttachmentId } });
      if (existingReference) status = "reconciled";
    }
  } else if (reference.kind === "ai_message_image") {
    const message = await tx.aiChatMessage.findUnique({ where: { id: target.targetEntityId }, select: { image: true } });
    const expectedImage = privateAvatarPath(reference.targetAttachmentId);
    if (!message) throw new ReferenceBackfillFailure("BUSINESS_TARGET_MISSING", "AI message target disappeared while applying the reference", { sourceKey: reference.sourceKey });
    if (message.image !== null && message.image !== expectedImage) {
      throw new ReferenceBackfillFailure("BUSINESS_REFERENCE_CONFLICT", "AI message already references another image", { sourceKey: reference.sourceKey });
    }
    if (message.image === null) {
      await tx.aiChatMessage.update({ where: { id: target.targetEntityId }, data: { image: expectedImage } });
      if (existingReference) status = "reconciled";
    }
  } else {
    const baby = await tx.baby.findUnique({ where: { id: target.targetEntityId }, select: { avatarUrl: true } });
    const expectedAvatar = privateAvatarPath(reference.targetAttachmentId);
    if (!baby) throw new ReferenceBackfillFailure("BUSINESS_TARGET_MISSING", "baby target disappeared while applying the reference", { sourceKey: reference.sourceKey });
    if (baby.avatarUrl !== null && baby.avatarUrl !== expectedAvatar) {
      throw new ReferenceBackfillFailure("BUSINESS_REFERENCE_CONFLICT", "baby already has another avatar URL; refusing public URL fallback", { sourceKey: reference.sourceKey });
    }
    if (baby.avatarUrl === null) {
      await tx.baby.update({
        where: { id: target.targetEntityId },
        data: {
          avatarUrl: expectedAvatar,
          avatarMetadata: {
            state: "private_attachment_mapped",
            attachmentId: reference.targetAttachmentId,
            sourceBatchId: reference.sourceBatchId,
            sourceTable: reference.sourceTable,
            sourceId: reference.sourceId,
            sourceHash: reference.sourceHash,
            mappingVersion: ATTACHMENT_REFERENCE_BACKFILL_MAPPING_VERSION,
          },
        },
      });
      if (existingReference) status = "reconciled";
    }
    const currentAttachment = await tx.attachment.findUnique({ where: { id: reference.targetAttachmentId }, select: { babyId: true } });
    if (currentAttachment?.babyId === null) await tx.attachment.update({ where: { id: reference.targetAttachmentId }, data: { babyId: target.targetEntityId } });
  }
  if (!existingReference) {
    await tx.legacyIdempotencyMapping.create({
      data: {
        id: referenceMappingId(reference.sourceKey),
        targetEntityType: ATTACHMENT_REFERENCE_ENTITY_TYPE,
        targetEntityId: target.targetEntityId,
        sourceKey: reference.sourceKey,
        status: "mapped",
        sourceSystem: reference.sourceSystem,
        sourceBatchId: reference.sourceBatchId,
        sourceTable: reference.sourceTable,
        sourceId: reference.sourceId,
        sourceHash: reference.sourceHash,
        mappingVersion: ATTACHMENT_REFERENCE_BACKFILL_MAPPING_VERSION,
        metadata,
      },
    });
  }
  return { sourceKey: reference.sourceKey, targetEntityType, targetEntityId: target.targetEntityId, targetAttachmentId: reference.targetAttachmentId, status };
}

function reportFor(
  plan: AttachmentReferenceBackfillPlan,
  receipts: readonly ReferenceBackfillReceipt[],
  quarantine: readonly ReferenceBackfillQuarantine[],
  database: "ready" | "not_written",
): AttachmentReferenceBackfillExecutionReport {
  return {
    mappingVersion: ATTACHMENT_REFERENCE_BACKFILL_MAPPING_VERSION,
    status: quarantine.length ? "quarantined" : "completed",
    receipts,
    quarantine,
    counts: {
      planned: plan.references.length,
      committed: receipts.filter((item) => item.status === "committed").length,
      replayed: receipts.filter((item) => item.status === "replayed").length,
      reconciled: receipts.filter((item) => item.status === "reconciled").length,
      quarantined: quarantine.length,
    },
    storage: { database, objectStore: "not_written" },
  };
}

/** Execute one all-or-nothing reference backfill transaction. */
export async function backfillAttachmentReferences(
  prisma: Db,
  plan: AttachmentReferenceBackfillPlan,
): Promise<AttachmentReferenceBackfillExecutionReport> {
  if (plan.mappingVersion !== ATTACHMENT_REFERENCE_BACKFILL_MAPPING_VERSION || plan.sourceMappingVersion !== ATTACHMENT_PROMOTION_MAPPING_VERSION) {
    return reportFor(plan, [], [{ code: "MAPPING_VERSION_MISMATCH", message: "reference backfill plan uses an unsupported mapping version" }], "not_written");
  }
  if (plan.quarantine.length > 0 || plan.status !== "planned") {
    return reportFor(plan, [], plan.quarantine.length ? plan.quarantine : [{ code: "INVALID_PLAN", message: "reference backfill plan is not clean" }], "not_written");
  }
  if (plan.references.length === 0) return reportFor(plan, [], [], "ready");
  try {
    const receipts = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ATTACHMENT_REFERENCE_BACKFILL_MAPPING_VERSION}))`;
      const result: ReferenceBackfillReceipt[] = [];
      for (const reference of plan.references) {
        const payload = await verifyImportProof(tx, reference);
        result.push(await applyReference(tx, reference, payload));
      }
      return result;
    }, { maxWait: 5_000, timeout: 60_000 });
    return reportFor(plan, receipts, [], "ready");
  } catch (error) {
    const failure = error instanceof ReferenceBackfillFailure
      ? error
      : new ReferenceBackfillFailure("DATABASE_COMMIT_FAILED", "reference backfill transaction failed; all changes were rolled back");
    return reportFor(plan, [], [quarantineFromReceipt(failure, failure.details ?? {})], "not_written");
  }
}
