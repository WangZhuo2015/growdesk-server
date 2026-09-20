/**
 * Execute the read-only attachment promotion plan against owned storage.
 *
 * The planner in attachment_promotion.py is intentionally side-effect free.
 * This module is the small, separately testable write boundary: it rechecks
 * the archive path and file digest, copies one object at a time to a private
 * bucket, then records the ready Attachment row and legacy idempotency
 * mapping in one PostgreSQL transaction.  It never creates business
 * references (growth, medical, baby or AI rows).
 */

import { createHash } from "node:crypto";
import { constants, lstatSync, realpathSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { type PrismaClient } from "@growdesk/database";

export const ATTACHMENT_PROMOTION_MAPPING_VERSION = "attachment-promotion-v1";
export const ATTACHMENT_PROMOTION_ENTITY_TYPE = "attachment";
export const MAX_PROMOTED_FILE_BYTES = 256 * 1024 * 1024;
const READY_EXPIRY = new Date("9999-12-31T23:59:59.999Z");
const SHA256 = /^[0-9a-f]{64}$/;
const ALLOWED_PURPOSES = new Set(["avatar", "medical_report", "voice_note", "growth_photo"]);
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "audio/m4a",
  "audio/wav",
  "audio/mpeg",
  "audio/mp4",
  "application/pdf",
]);

type Db = PrismaClient;

export interface PlannedAttachment {
  readonly id: string;
  readonly familyId: string;
  readonly babyId: string | null;
  readonly uploaderId: string;
  readonly purpose: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly objectKey: string;
  readonly status: string;
}

export interface PlannedAttachmentReceipt {
  readonly sourceSystem: string;
  readonly sourceBatchId: string;
  readonly sourceTable: string;
  readonly sourceId: string;
  readonly sourceField: string;
  readonly sourcePath: string;
  readonly sourceHash: string;
  readonly mappingVersion: string;
  readonly result: string;
  readonly storageState: string;
  readonly targetAttachmentId: string;
  readonly targetObjectKey: string;
  readonly targetSha256: string;
  readonly targetByteSize: number;
  readonly attachment: PlannedAttachment;
}

export interface PlannedAttachmentReport {
  readonly mappingVersion?: string;
  readonly receipts?: readonly PlannedAttachmentReceipt[];
}

export type PromotionReceiptStatus = "committed" | "replayed" | "reconciled";

export interface PromotionReceipt {
  readonly sourceKey: string;
  readonly targetAttachmentId: string;
  readonly targetObjectKey: string;
  readonly status: PromotionReceiptStatus;
}

export interface PromotionQuarantine {
  code: string;
  message: string;
  sourceKey?: string;
  sourcePath?: string;
  targetAttachmentId?: string;
  targetObjectKey?: string;
}

export interface PromotionExecutionReport {
  readonly mode: "promote" | "reconcile";
  readonly status: "completed" | "quarantined";
  readonly mappingVersion: string;
  readonly receipts: readonly PromotionReceipt[];
  readonly quarantine: readonly PromotionQuarantine[];
  readonly counts: {
    readonly planned: number;
    readonly committed: number;
    readonly replayed: number;
    readonly reconciled: number;
    readonly quarantined: number;
  };
  readonly storage: {
    readonly database: "ready" | "not_written" | "partially_written";
    readonly objectStore: "verified" | "not_written" | "residual_object";
  };
}

export interface PromotionTestHooks {
  /** Test-only fault injection. Throwing rolls back the surrounding transaction. */
  readonly afterAttachmentWrite?: () => Promise<void> | void;
}

export interface LegacyAttachmentPromotionOptions {
  readonly prisma: Db;
  readonly s3: Pick<S3Client, "send">;
  readonly bucket: string;
  /** Immutable archive directory containing the planner's `files/` directory. */
  readonly archiveRoot: string;
  readonly mappingVersion?: string;
  readonly hooks?: PromotionTestHooks;
}

interface ValidatedReceipt {
  readonly receipt: PlannedAttachmentReceipt;
  readonly sourceKey: string;
  readonly sourceFile: string;
}

interface StoredObjectDigest {
  readonly byteSize: number;
  readonly sha256: string;
  readonly mimeType: string;
}

class PromotionFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PromotionFailure";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PromotionFailure("INVALID_RECEIPT", `${field} must be a non-empty string`);
  }
  return value;
}

function containsControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

function safeId(value: unknown, field: string): string {
  const id = stringField(value, field);
  if (id.length > 255 || id.trim().length === 0 || id === "." || id === ".." || id.includes("\\") || id.includes("/") || containsControl(id)) {
    throw new PromotionFailure("INVALID_RECEIPT", `${field} contains an unsafe character`);
  }
  return id;
}

/** Match the planner's urllib.parse.quote(value, safe="-_.~") byte-for-byte. */
function encodeObjectKeySegment(value: string): string {
  let encoded = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const character = String.fromCharCode(byte);
    if ((byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) ||
        (byte >= 0x61 && byte <= 0x7a) || "-_.~".includes(character)) {
      encoded += character;
    } else {
      encoded += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return encoded;
}

function sha256Field(value: unknown, field: string): string {
  const hash = stringField(value, field);
  if (!SHA256.test(hash)) {
    throw new PromotionFailure("INVALID_HASH", `${field} must be a lowercase SHA-256`);
  }
  return hash;
}

function integerField(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > MAX_PROMOTED_FILE_BYTES) {
    throw new PromotionFailure("INVALID_SIZE", `${field} is outside the supported file-size range`);
  }
  return value;
}

function normalizedSourcePath(value: unknown): string {
  const raw = stringField(value, "sourcePath");
  if (raw.includes("\\") || raw.includes("%") || raw.includes("\0") || isAbsolute(raw)) {
    throw new PromotionFailure("PATH_TRAVERSAL", "sourcePath is not a normalized archive-relative path");
  }
  const parts = raw.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new PromotionFailure("PATH_TRAVERSAL", "sourcePath contains a traversal or empty segment");
  }
  if (!raw.startsWith("public/uploads/") && !raw.startsWith("data/archive/")) {
    throw new PromotionFailure("PATH_OUTSIDE_ALLOWED_ROOT", "sourcePath is outside the captured attachment roots");
  }
  return raw;
}

function normalizedObjectKey(value: unknown, familyId: string): string {
  const key = stringField(value, "targetObjectKey");
  if (key.length > 500 || key.includes("\\") || key.includes("\0") || key.startsWith("/")) {
    throw new PromotionFailure("INVALID_OBJECT_KEY", "targetObjectKey is unsafe");
  }
  const parts = key.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === ".." || containsControl(part))) {
    throw new PromotionFailure("INVALID_OBJECT_KEY", "targetObjectKey contains an unsafe segment");
  }
  const familyPrefix = "families/" + encodeObjectKeySegment(familyId) + "/attachments/";
  if (!key.startsWith(familyPrefix)) {
    throw new PromotionFailure("OBJECT_OWNER_MISMATCH", "targetObjectKey is outside the family attachment prefix");
  }
  // The planner percent-encodes only the family segment. Reject encoded
  // bytes in the remaining segments so a receipt cannot smuggle an opaque
  // path into a different object namespace.
  if (parts.slice(2).some((part) => part.includes("%"))) {
    throw new PromotionFailure("INVALID_OBJECT_KEY", "targetObjectKey contains an encoded non-owner segment");
  }
  return key;
}

function assertEqual(actual: unknown, expected: unknown, code: string, field: string): void {
  if (actual !== expected) throw new PromotionFailure(code, `${field} does not match the planned value`);
}

function sourceKeyOf(receipt: PlannedAttachmentReceipt): string {
  return [receipt.sourceBatchId, receipt.sourceTable, receipt.sourceId, receipt.sourceField, receipt.sourcePath].join("/");
}

function parseAttachment(value: unknown): PlannedAttachment {
  if (!isRecord(value)) throw new PromotionFailure("INVALID_RECEIPT", "attachment must be an object");
  const id = safeId(value.id, "attachment.id");
  const familyId = safeId(value.familyId, "attachment.familyId");
  const babyId = value.babyId === null ? null : safeId(value.babyId, "attachment.babyId");
  const uploaderId = safeId(value.uploaderId, "attachment.uploaderId");
  const purpose = stringField(value.purpose, "attachment.purpose");
  if (!ALLOWED_PURPOSES.has(purpose)) throw new PromotionFailure("INVALID_PURPOSE", `unsupported purpose ${purpose}`);
  const mimeType = stringField(value.mimeType, "attachment.mimeType").toLowerCase();
  if (!ALLOWED_MIME_TYPES.has(mimeType)) throw new PromotionFailure("INVALID_MIME", `unsupported MIME ${mimeType}`);
  const byteSize = integerField(value.byteSize, "attachment.byteSize");
  const sha256 = sha256Field(value.sha256, "attachment.sha256");
  const objectKey = normalizedObjectKey(value.objectKey, familyId);
  assertEqual(value.status, "pending", "INVALID_STATUS", "attachment.status");
  return { id, familyId, babyId, uploaderId, purpose, mimeType, byteSize, sha256, objectKey, status: "pending" };
}

function validateReceipt(value: unknown, mappingVersion: string, filesRoot: string): ValidatedReceipt {
  if (!isRecord(value)) throw new PromotionFailure("INVALID_RECEIPT", "receipt must be an object");
  const receipt = value as unknown as PlannedAttachmentReceipt;
  const sourceSystem = safeId(value.sourceSystem, "sourceSystem");
  const sourceBatchId = sha256Field(value.sourceBatchId, "sourceBatchId");
  const sourceTable = safeId(value.sourceTable, "sourceTable");
  const sourceId = safeId(value.sourceId, "sourceId");
  const sourceField = safeId(value.sourceField, "sourceField");
  const sourcePath = normalizedSourcePath(value.sourcePath);
  const sourceHash = sha256Field(value.sourceHash, "sourceHash");
  assertEqual(value.mappingVersion, mappingVersion, "MAPPING_VERSION_MISMATCH", "mappingVersion");
  assertEqual(value.result, "planned", "INVALID_RECEIPT", "result");
  assertEqual(value.storageState, "not_copied", "INVALID_RECEIPT", "storageState");
  const attachment = parseAttachment(value.attachment);
  const targetAttachmentId = safeId(value.targetAttachmentId, "targetAttachmentId");
  const targetObjectKey = normalizedObjectKey(value.targetObjectKey, attachment.familyId);
  const targetSha256 = sha256Field(value.targetSha256, "targetSha256");
  const targetByteSize = integerField(value.targetByteSize, "targetByteSize");
  assertEqual(targetAttachmentId, attachment.id, "TARGET_ID_MISMATCH", "targetAttachmentId");
  assertEqual(targetObjectKey, attachment.objectKey, "TARGET_OBJECT_MISMATCH", "targetObjectKey");
  assertEqual(targetSha256, attachment.sha256, "TARGET_HASH_MISMATCH", "targetSha256");
  assertEqual(targetByteSize, attachment.byteSize, "TARGET_SIZE_MISMATCH", "targetByteSize");
  const sourceKey = sourceKeyOf({
    sourceSystem,
    sourceBatchId,
    sourceTable,
    sourceId,
    sourceField,
    sourcePath,
    sourceHash,
    mappingVersion,
    result: "planned",
    storageState: "not_copied",
    targetAttachmentId,
    targetObjectKey,
    targetSha256,
    targetByteSize,
    attachment,
  });
  if (sourceKey.length > 1000) throw new PromotionFailure("INVALID_RECEIPT", "source key is too long");
  let root: string;
  try {
    const filesEntry = lstatSync(filesRoot);
    if (filesEntry.isSymbolicLink()) {
      throw new PromotionFailure("SYMLINK_REJECTED", "archive files root must not be a symlink");
    }
    if (!filesEntry.isDirectory()) {
      throw new PromotionFailure("SOURCE_MISSING", "archive files root is not a directory");
    }
    root = realpathSync(filesRoot);
  } catch (error) {
    if (error instanceof PromotionFailure) throw error;
    throw new PromotionFailure("SOURCE_MISSING", "archive files root is unavailable");
  }
  const candidate = resolve(root, sourcePath);
  const relativeCandidate = relative(root, candidate);
  if (relativeCandidate === "" || relativeCandidate === ".." || relativeCandidate.startsWith(`..${sep}`) || isAbsolute(relativeCandidate)) {
    throw new PromotionFailure("PATH_TRAVERSAL", "sourcePath resolves outside archive files");
  }
  let resolvedCandidate: string;
  try {
    resolvedCandidate = realpathSync(candidate);
  } catch {
    throw new PromotionFailure("SOURCE_MISSING", "source attachment file is missing");
  }
  const resolvedRelative = relative(root, resolvedCandidate);
  if (resolvedRelative === "" || resolvedRelative === ".." || resolvedRelative.startsWith(`..${sep}`) || isAbsolute(resolvedRelative)) {
    throw new PromotionFailure("PATH_TRAVERSAL", "source attachment resolves outside archive files");
  }
  let current = root;
  try {
    for (const part of relativeCandidate.split(sep)) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) {
        throw new PromotionFailure("SYMLINK_REJECTED", "source attachment path contains a symlink");
      }
    }
  } catch (error) {
    if (error instanceof PromotionFailure) throw error;
    throw new PromotionFailure("SOURCE_MISSING", "source attachment path is missing");
  }
  try {
    const link = lstatSync(candidate);
    const file = statSync(candidate);
    if (link.isSymbolicLink() || !file.isFile()) throw new Error("not a regular file");
  } catch (error) {
    if (error instanceof PromotionFailure) throw error;
    throw new PromotionFailure("SOURCE_MISSING", "source attachment is not a regular file");
  }
  return {
    receipt: {
      sourceSystem,
      sourceBatchId,
      sourceTable,
      sourceId,
      sourceField,
      sourcePath,
      sourceHash,
      mappingVersion,
      result: "planned",
      storageState: "not_copied",
      targetAttachmentId,
      targetObjectKey,
      targetSha256,
      targetByteSize,
      attachment,
    },
    sourceKey,
    sourceFile: resolvedCandidate,
  };
}

async function streamDigest(stream: AsyncIterable<Uint8Array>): Promise<{ byteSize: number; sha256: string }> {
  const hash = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteSize += bytes.length;
    if (byteSize > MAX_PROMOTED_FILE_BYTES) {
      throw new PromotionFailure("FILE_TOO_LARGE", "attachment exceeds the promotion size limit");
    }
    hash.update(bytes);
  }
  return { byteSize, sha256: hash.digest("hex") };
}

async function digestFile(file: string): Promise<{ byteSize: number; sha256: string }> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) throw new PromotionFailure("SOURCE_MISSING", "source attachment is not a regular file");
    return await streamDigest(handle.createReadStream({ autoClose: false }));
  } catch (error) {
    if (error instanceof PromotionFailure) throw error;
    throw new PromotionFailure("SOURCE_READ_FAILED", "source attachment could not be read");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function notFound(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (isRecord(error.$metadata) && error.$metadata.httpStatusCode === 404) return true;
  return error.name === "NotFound" || error.name === "NoSuchKey" || error.Code === "NoSuchKey";
}

async function verifyObject(
  s3: Pick<S3Client, "send">,
  bucket: string,
  objectKey: string,
  expected: PlannedAttachment,
): Promise<StoredObjectDigest | null> {
  let head;
  try {
    head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
  } catch (error) {
    if (notFound(error)) return null;
    throw new PromotionFailure("OBJECT_HEAD_FAILED", "object metadata could not be read");
  }
  if (head.ContentLength !== expected.byteSize) {
    throw new PromotionFailure("OBJECT_SIZE_MISMATCH", "stored object size differs from the planned size");
  }
  if (head.ContentType !== expected.mimeType) {
    throw new PromotionFailure("OBJECT_MIME_MISMATCH", "stored object MIME differs from the planned MIME");
  }
  let response;
  try {
    response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
  } catch {
    throw new PromotionFailure("OBJECT_READ_FAILED", "stored object could not be read");
  }
  if (!response.Body) throw new PromotionFailure("OBJECT_READ_FAILED", "stored object has no body");
  let digest: { byteSize: number; sha256: string };
  try {
    digest = await streamDigest(response.Body as AsyncIterable<Uint8Array>);
  } catch (error) {
    if (error instanceof PromotionFailure && error.code === "FILE_TOO_LARGE") {
      throw new PromotionFailure("OBJECT_SIZE_MISMATCH", "stored object exceeds the planned size limit");
    }
    throw new PromotionFailure("OBJECT_READ_FAILED", "stored object body could not be read");
  }
  if (digest.byteSize !== expected.byteSize) {
    throw new PromotionFailure("OBJECT_SIZE_MISMATCH", "stored object body size differs from the planned size");
  }
  if (digest.sha256 !== expected.sha256) {
    throw new PromotionFailure("OBJECT_HASH_MISMATCH", "stored object hash differs from the planned hash");
  }
  return { ...digest, mimeType: head.ContentType };
}

async function putObject(
  s3: Pick<S3Client, "send">,
  bucket: string,
  sourceFile: string,
  objectKey: string,
  expected: PlannedAttachment,
): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(sourceFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) throw new PromotionFailure("SOURCE_MISSING", "source attachment is not a regular file");
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: handle.createReadStream({ autoClose: false }),
      ContentLength: expected.byteSize,
      ContentType: expected.mimeType,
    }));
  } catch (error) {
    if (error instanceof PromotionFailure) throw error;
    throw new PromotionFailure("OBJECT_WRITE_FAILED", "object copy failed");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

type OwnershipDb = Pick<Db, "family" | "user" | "familyMember" | "baby" | "babyMember">;

async function assertOwnership(db: OwnershipDb, attachment: PlannedAttachment): Promise<void> {
  const family = await db.family.findUnique({ where: { id: attachment.familyId }, select: { id: true, deletedAt: true } });
  if (!family || family.deletedAt) throw new PromotionFailure("OWNER_NOT_FOUND", "attachment family is missing or deleted");
  const user = await db.user.findUnique({ where: { id: attachment.uploaderId }, select: { id: true, deletedAt: true } });
  if (!user || user.deletedAt) throw new PromotionFailure("OWNER_NOT_FOUND", "attachment uploader is missing or deleted");
  const familyMember = await db.familyMember.findUnique({
    where: { uq_family_members_family_user: { familyId: attachment.familyId, userId: attachment.uploaderId } },
    select: { familyId: true, userId: true, status: true, deletedAt: true },
  });
  if (!familyMember || familyMember.status !== "active" || familyMember.deletedAt) {
    throw new PromotionFailure("OWNER_NOT_AUTHORIZED", "uploader is not an active family member");
  }
  if (!attachment.babyId) return;
  const baby = await db.baby.findUnique({
    where: { uq_babies_family_id_id: { familyId: attachment.familyId, id: attachment.babyId } },
    select: { familyId: true, id: true, deletedAt: true },
  });
  if (!baby || baby.familyId !== attachment.familyId || baby.deletedAt) {
    throw new PromotionFailure("OWNER_NOT_AUTHORIZED", "baby does not belong to the attachment family");
  }
  const babyMember = await db.babyMember.findUnique({
    where: { uq_baby_members_user_baby: { userId: attachment.uploaderId, babyId: attachment.babyId } },
    select: { familyId: true, babyId: true, userId: true, status: true, deletedAt: true },
  });
  if (!babyMember || babyMember.familyId !== attachment.familyId || babyMember.status !== "active" || babyMember.deletedAt) {
    throw new PromotionFailure("OWNER_NOT_AUTHORIZED", "uploader is not an active baby member");
  }
}

function attachmentMatches(row: {
  id: string;
  familyId: string;
  babyId: string | null;
  uploaderId: string;
  purpose: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  objectKey: string;
  deletedAt: Date | null;
}, expected: PlannedAttachment): boolean {
  return row.id === expected.id && row.familyId === expected.familyId && row.babyId === expected.babyId &&
    row.uploaderId === expected.uploaderId && row.purpose === expected.purpose && row.mimeType === expected.mimeType &&
    row.byteSize === expected.byteSize && row.sha256 === expected.sha256 && row.objectKey === expected.objectKey &&
    row.deletedAt === null;
}

export class LegacyAttachmentPromotionRuntime {
  private readonly filesRoot: string;
  private readonly mappingVersion: string;

  constructor(private readonly options: LegacyAttachmentPromotionOptions) {
    if (!options.bucket || options.bucket.includes("/")) throw new Error("Attachment promotion requires an explicit bucket");
    if (!isAbsolute(options.archiveRoot)) throw new Error("Attachment promotion archiveRoot must be absolute");
    const archivePath = resolve(options.archiveRoot);
    const archiveLink = lstatSync(archivePath);
    if (archiveLink.isSymbolicLink() || !archiveLink.isDirectory()) {
      throw new Error("Attachment promotion archiveRoot must be a regular directory");
    }
    const archiveRoot = realpathSync(archivePath);
    const filesEntry = join(archiveRoot, "files");
    const filesLink = lstatSync(filesEntry);
    if (filesLink.isSymbolicLink()) throw new Error("Attachment promotion archive files root must not be a symlink");
    this.filesRoot = realpathSync(filesEntry);
    const filesRelative = relative(archiveRoot, this.filesRoot);
    if (filesRelative === "" || filesRelative.startsWith(`..${sep}`) || isAbsolute(filesRelative) || !statSync(this.filesRoot).isDirectory()) {
      throw new Error("Attachment promotion archive files root escapes the archive");
    }
    this.mappingVersion = options.mappingVersion ?? ATTACHMENT_PROMOTION_MAPPING_VERSION;
  }

  async promote(report: PlannedAttachmentReport): Promise<PromotionExecutionReport> {
    return this.run(report, "promote");
  }

  async reconcile(report: PlannedAttachmentReport): Promise<PromotionExecutionReport> {
    return this.run(report, "reconcile");
  }

  private async run(report: PlannedAttachmentReport, mode: "promote" | "reconcile"): Promise<PromotionExecutionReport> {
    const envelopeValid = Boolean(report) && report.mappingVersion === this.mappingVersion && Array.isArray(report.receipts);
    const receipts = envelopeValid ? report.receipts! : [];
    const outcomes: PromotionReceipt[] = [];
    const quarantine: PromotionQuarantine[] = [];
    let database: PromotionExecutionReport["storage"]["database"] = "not_written";
    let objectStore: PromotionExecutionReport["storage"]["objectStore"] = "not_written";
    if (!envelopeValid) {
      quarantine.push({
        code: report && report.mappingVersion !== this.mappingVersion ? "MAPPING_VERSION_MISMATCH" : "INVALID_REPORT",
        message: report && report.mappingVersion !== this.mappingVersion
          ? "planner report mapping version does not match the runtime"
          : "planner report must contain the expected mappingVersion and receipts array",
      });
    }
    for (const rawReceipt of receipts) {
      let validated: ValidatedReceipt | undefined;
      let receiptObjectVerified = false;
      try {
        validated = validateReceipt(rawReceipt, this.mappingVersion, this.filesRoot);
        // Check authorization before touching the object store. This keeps a
        // cross-family/baby receipt from leaving a copy behind as evidence.
        await assertOwnership(this.options.prisma, validated.receipt.attachment);
        const sourceDigest = await digestFile(validated.sourceFile);
        if (sourceDigest.byteSize !== validated.receipt.attachment.byteSize || sourceDigest.sha256 !== validated.receipt.attachment.sha256) {
          throw new PromotionFailure("SOURCE_HASH_MISMATCH", "source file size or hash differs from the planned attachment");
        }
        let stored = await verifyObject(this.options.s3, this.options.bucket, validated.receipt.targetObjectKey, validated.receipt.attachment);
        if (!stored) {
          await putObject(this.options.s3, this.options.bucket, validated.sourceFile, validated.receipt.targetObjectKey, validated.receipt.attachment);
          stored = await verifyObject(this.options.s3, this.options.bucket, validated.receipt.targetObjectKey, validated.receipt.attachment);
          if (!stored) throw new PromotionFailure("OBJECT_WRITE_FAILED", "object was not visible after copy");
        }
        objectStore = "verified";
        receiptObjectVerified = true;
        const committed = await this.commitReceipt(validated);
        const result: PromotionReceipt = mode === "reconcile" && committed.status === "committed"
          ? { ...committed, status: "reconciled" }
          : committed;
        outcomes.push(result);
        if (result.status === "committed" || result.status === "replayed" || result.status === "reconciled") database = "ready";
      } catch (error) {
        const failure = error instanceof PromotionFailure ? error : new PromotionFailure("DATABASE_COMMIT_FAILED", "attachment promotion failed");
        let item: PromotionQuarantine = { code: failure.code, message: failure.message };
        if (validated) {
          item = {
            ...item,
            sourceKey: validated.sourceKey,
            sourcePath: validated.receipt.sourcePath,
            targetAttachmentId: validated.receipt.targetAttachmentId,
            targetObjectKey: validated.receipt.targetObjectKey,
          };
        } else if (isRecord(rawReceipt)) {
          item = {
            ...item,
            ...(typeof rawReceipt.sourcePath === "string" ? { sourcePath: rawReceipt.sourcePath } : {}),
            ...(typeof rawReceipt.targetAttachmentId === "string" ? { targetAttachmentId: rawReceipt.targetAttachmentId } : {}),
            ...(typeof rawReceipt.targetObjectKey === "string" ? { targetObjectKey: rawReceipt.targetObjectKey } : {}),
          };
        }
        quarantine.push(item);
        if (item.targetObjectKey && receiptObjectVerified) objectStore = "residual_object";
        if (item.code === "DATABASE_COMMIT_FAILED") database = "partially_written";
      }
    }
    const counts = {
      planned: receipts.length,
      committed: outcomes.filter((item) => item.status === "committed").length,
      replayed: outcomes.filter((item) => item.status === "replayed").length,
      reconciled: outcomes.filter((item) => item.status === "reconciled").length,
      quarantined: quarantine.length,
    };
    return {
      mode,
      status: quarantine.length ? "quarantined" : "completed",
      mappingVersion: this.mappingVersion,
      receipts: outcomes,
      quarantine,
      counts,
      storage: { database, objectStore },
    };
  }

  private async commitReceipt(validated: ValidatedReceipt): Promise<PromotionReceipt> {
    const { receipt, sourceKey } = validated;
    try {
      return await this.options.prisma.$transaction(async (tx) => {
        // Serialize concurrent retries for one source. The lock is scoped to
        // this transaction and never relies on an application process lock.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${sourceKey}))`;
        await assertOwnership(tx, receipt.attachment);
        const mapping = await tx.legacyIdempotencyMapping.findUnique({
          where: { uq_legacy_idempotency_type_source: { targetEntityType: ATTACHMENT_PROMOTION_ENTITY_TYPE, sourceKey } },
        });
        if (mapping) {
          if (mapping.status !== "mapped" || mapping.sourceHash !== receipt.sourceHash || mapping.sourceBatchId !== receipt.sourceBatchId ||
              mapping.targetEntityId !== receipt.targetAttachmentId || mapping.mappingVersion !== this.mappingVersion) {
            throw new PromotionFailure("IDEMPOTENCY_CONFLICT", "existing legacy mapping does not match the receipt");
          }
          const existing = await tx.attachment.findUnique({ where: { id: receipt.targetAttachmentId } });
          if (!existing || !attachmentMatches(existing, receipt.attachment)) {
            throw new PromotionFailure("IDEMPOTENCY_CONFLICT", "existing legacy mapping has no matching attachment row");
          }
          if (existing.status !== "ready") {
            await tx.attachment.update({ where: { id: existing.id }, data: { status: "ready" } });
            return { sourceKey, targetAttachmentId: receipt.targetAttachmentId, targetObjectKey: receipt.targetObjectKey, status: "reconciled" };
          }
          return { sourceKey, targetAttachmentId: receipt.targetAttachmentId, targetObjectKey: receipt.targetObjectKey, status: "replayed" };
        }
        const existing = await tx.attachment.findUnique({ where: { id: receipt.targetAttachmentId } });
        let status: PromotionReceiptStatus = "committed";
        if (existing) {
          if (!attachmentMatches(existing, receipt.attachment) || !["pending", "ready"].includes(existing.status)) {
            throw new PromotionFailure("ATTACHMENT_CONFLICT", "existing attachment row does not match the receipt");
          }
          if (existing.status !== "ready") {
            await tx.attachment.update({ where: { id: existing.id }, data: { status: "ready" } });
            status = "reconciled";
          } else {
            status = "replayed";
          }
        } else {
          await tx.attachment.create({
            data: {
              id: receipt.attachment.id,
              familyId: receipt.attachment.familyId,
              babyId: receipt.attachment.babyId,
              uploaderId: receipt.attachment.uploaderId,
              purpose: receipt.attachment.purpose,
              mimeType: receipt.attachment.mimeType,
              byteSize: receipt.attachment.byteSize,
              sha256: receipt.attachment.sha256,
              objectKey: receipt.attachment.objectKey,
              status: "ready",
              expiresAt: READY_EXPIRY,
            },
          });
        }
        await this.options.hooks?.afterAttachmentWrite?.();
        await tx.legacyIdempotencyMapping.create({
          data: {
            id: `attachment:${receipt.targetAttachmentId}`,
            targetEntityType: ATTACHMENT_PROMOTION_ENTITY_TYPE,
            targetEntityId: receipt.targetAttachmentId,
            sourceKey,
            status: "mapped",
            sourceSystem: receipt.sourceSystem,
            sourceBatchId: receipt.sourceBatchId,
            sourceTable: receipt.sourceTable,
            sourceId: receipt.sourceId,
            sourceHash: receipt.sourceHash,
            mappingVersion: this.mappingVersion,
            metadata: {
              sourcePath: receipt.sourcePath,
              familyId: receipt.attachment.familyId,
              babyId: receipt.attachment.babyId,
              uploaderId: receipt.attachment.uploaderId,
              purpose: receipt.attachment.purpose,
              mimeType: receipt.attachment.mimeType,
              byteSize: receipt.attachment.byteSize,
              sha256: receipt.attachment.sha256,
              objectKey: receipt.targetObjectKey,
              storageState: "ready",
            },
          },
        });
        return { sourceKey, targetAttachmentId: receipt.targetAttachmentId, targetObjectKey: receipt.targetObjectKey, status };
      });
    } catch (error) {
      if (error instanceof PromotionFailure) throw error;
      throw new PromotionFailure("DATABASE_COMMIT_FAILED", "database transaction failed; object can be reconciled later");
    }
  }
}

export function buildAttachmentPromotionSourceKey(receipt: PlannedAttachmentReceipt): string {
  return sourceKeyOf(receipt);
}
