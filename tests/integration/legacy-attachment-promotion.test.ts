import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createDatabaseContext } from "../../packages/database/src/client.js";
import { requireTestDatabaseUrl, requireTestObjectStorage } from "../../packages/testkit/src/environment.js";
import {
  ATTACHMENT_PROMOTION_MAPPING_VERSION,
  LegacyAttachmentPromotionRuntime,
  type PlannedAttachmentReport,
} from "../../scripts/legacy-import/attachment-promotion-runtime.js";

interface OwnedRun {
  readonly directory: string;
  readonly token: string;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly pgPort: number;
  readonly s3: {
    readonly endpoint: string;
    readonly bucket: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly region: string;
    readonly pid: number;
  };
}

function readRun(): OwnedRun {
  const file = process.env.BOOT02_RUN_FILE;
  if (!file) throw new Error("Attachment promotion integration requires the managed test runner");
  const real = fs.realpathSync(file);
  const root = path.dirname(real);
  if (path.dirname(root) !== fs.realpathSync(os.tmpdir()) || !path.basename(root).startsWith("growdesk-integration-")) {
    throw new Error("Integration manifest is outside its private run");
  }
  const stat = fs.statSync(real);
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("Unsafe integration manifest permissions");
  return JSON.parse(fs.readFileSync(real, "utf8")) as OwnedRun;
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function plannerObjectKeySegment(value: string): string {
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

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("$metadata" in error)) return false;
  const metadata = error.$metadata;
  return typeof metadata === "object" && metadata !== null && "httpStatusCode" in metadata && metadata.httpStatusCode === 404;
}

function planFor(options: {
  readonly token: string;
  readonly sourcePath: string;
  readonly sourceId: string;
  readonly attachmentId: string;
  readonly familyId: string;
  readonly babyId: string | null;
  readonly uploaderId: string;
  readonly bytes: Buffer;
}): PlannedAttachmentReport {
  const digest = sha256(options.bytes);
  const familyForKey = plannerObjectKeySegment(options.familyId);
  const objectKey = `families/${familyForKey}/attachments/growth_photo/legacy/${options.attachmentId}.png`;
  const sourceHash = sha256(Buffer.from(`test-source-row:${options.sourceId}`));
  return {
    mappingVersion: ATTACHMENT_PROMOTION_MAPPING_VERSION,
    receipts: [{
      sourceSystem: "test_legacy_snapshot",
      sourceBatchId: "a".repeat(64),
      sourceTable: "GrowthMeasurement",
      sourceId: options.sourceId,
      sourceField: "imageUrl",
      sourcePath: options.sourcePath,
      sourceHash,
      mappingVersion: ATTACHMENT_PROMOTION_MAPPING_VERSION,
      result: "planned",
      storageState: "not_copied",
      targetAttachmentId: options.attachmentId,
      targetObjectKey: objectKey,
      targetSha256: digest,
      targetByteSize: options.bytes.length,
      attachment: {
        id: options.attachmentId,
        familyId: options.familyId,
        babyId: options.babyId,
        uploaderId: options.uploaderId,
        purpose: "growth_photo",
        mimeType: "image/png",
        byteSize: options.bytes.length,
        sha256: digest,
        objectKey,
        status: "pending",
      },
    }],
  };
}

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("legacy attachment promotion copies and verifies MinIO objects, commits idempotently, and reconciles residues", async (t) => {
  const run = readRun();
  const storage = requireTestObjectStorage(run.s3, run.token);
  process.kill(storage.pid, 0);
  const databaseUrl = requireTestDatabaseUrl(
    `postgresql://${run.user}:${run.password}@127.0.0.1:${run.pgPort}/${run.database}?sslmode=disable`,
    { host: "127.0.0.1", port: run.pgPort, database: run.database, role: run.user, password: run.password },
  );
  const database = createDatabaseContext({ url: databaseUrl });
  const client = new S3Client({
    endpoint: storage.endpoint,
    region: storage.region,
    forcePathStyle: true,
    credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey },
  });
  const suffix = run.token;
  const familyId = `test_legacy_family 家庭_${suffix}`;
  const otherFamilyId = `test_legacy_other_family_${suffix}`;
  const userId = `test_legacy_uploader_${suffix}`;
  const babyId = `test_legacy_baby_${suffix}`;
  const familyMemberId = `test_legacy_family_member_${suffix}`;
  const otherFamilyMemberId = `test_legacy_other_member_${suffix}`;
  const babyMemberId = `test_legacy_baby_member_${suffix}`;
  const firstAttachmentId = `test_legacy_attachment_${suffix}`;
  const failureAttachmentId = `test_legacy_failure_attachment_${suffix}`;
  const archiveRoot = path.join(run.directory, "legacy-attachment-archive");
  const firstPath = "public/uploads/growth/test-pixel.png";
  const failurePath = "public/uploads/growth/test-failure.png";
  const firstFile = path.join(archiveRoot, "files", firstPath);
  const failureFile = path.join(archiveRoot, "files", failurePath);
  const firstKey = `families/${plannerObjectKeySegment(familyId)}/attachments/growth_photo/legacy/${firstAttachmentId}.png`;
  const failureKey = `families/${plannerObjectKeySegment(familyId)}/attachments/growth_photo/legacy/${failureAttachmentId}.png`;
  const uploadedKeys = new Set([firstKey, failureKey]);
  await fsp.mkdir(path.dirname(firstFile), { recursive: true });
  await fsp.writeFile(firstFile, pixel);
  await fsp.writeFile(failureFile, pixel);
  await client.send(new CreateBucketCommand({ Bucket: storage.bucket }));

  t.after(async () => {
    for (const key of uploadedKeys) {
      try { await client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: key })); } catch { /* cleanup is best effort */ }
    }
    try { await client.send(new DeleteBucketCommand({ Bucket: storage.bucket })); } catch { /* runner removes the bucket */ }
    await database.prisma.legacyIdempotencyMapping.deleteMany({ where: { targetEntityType: "attachment", targetEntityId: { in: [firstAttachmentId, failureAttachmentId] } } });
    await database.prisma.attachment.deleteMany({ where: { id: { in: [firstAttachmentId, failureAttachmentId] } } });
    await database.prisma.babyMember.deleteMany({ where: { id: babyMemberId } });
    await database.prisma.familyMember.deleteMany({ where: { id: { in: [familyMemberId, otherFamilyMemberId] } } });
    await database.prisma.baby.deleteMany({ where: { id: babyId } });
    await database.prisma.family.deleteMany({ where: { id: { in: [familyId, otherFamilyId] } } });
    await database.prisma.user.deleteMany({ where: { id: userId } });
    await database.close();
    client.destroy();
  });

  await database.prisma.user.create({
    data: { id: userId, username: `test_legacy_uploader_${suffix}`, passwordHash: "test-only", displayName: "test legacy uploader" },
  });
  await database.prisma.family.create({ data: { id: familyId, name: "test legacy family" } });
  await database.prisma.family.create({ data: { id: otherFamilyId, name: "test legacy other family" } });
  await database.prisma.familyMember.create({ data: { id: familyMemberId, familyId, userId, role: "member", relation: "parent", status: "active" } });
  await database.prisma.familyMember.create({ data: { id: otherFamilyMemberId, familyId: otherFamilyId, userId, role: "member", relation: "parent", status: "active" } });
  await database.prisma.baby.create({ data: { id: babyId, familyId, nickname: "test legacy baby", birthDate: new Date("2026-01-01"), gender: "unknown" } });
  await database.prisma.babyMember.create({ data: { id: babyMemberId, familyId, babyId, userId, role: "member", status: "active" } });

  const firstPlan = planFor({ token: suffix, sourcePath: firstPath, sourceId: "test_growth_1", attachmentId: firstAttachmentId, familyId, babyId, uploaderId: userId, bytes: pixel });
  assert.match(firstPlan.receipts![0]!.targetObjectKey, /^families\/test_legacy_family%20%E5%AE%B6%E5%BA%AD_/);
  const archiveRootLink = `${archiveRoot}-link`;
  await fsp.symlink(archiveRoot, archiveRootLink, "dir");
  assert.throws(
    () => new LegacyAttachmentPromotionRuntime({ prisma: database.prisma, s3: client, bucket: storage.bucket, archiveRoot: archiveRootLink }),
    /archiveRoot must be a regular directory/,
  );
  await fsp.unlink(archiveRootLink);
  const filesRootLink = path.join(run.directory, "legacy-attachment-files-link");
  await fsp.mkdir(filesRootLink);
  await fsp.symlink(path.join(archiveRoot, "files"), path.join(filesRootLink, "files"), "dir");
  assert.throws(
    () => new LegacyAttachmentPromotionRuntime({ prisma: database.prisma, s3: client, bucket: storage.bucket, archiveRoot: filesRootLink }),
    /archive files root must not be a symlink/,
  );
  await fsp.rm(filesRootLink, { recursive: true, force: true });
  const runtime = new LegacyAttachmentPromotionRuntime({ prisma: database.prisma, s3: client, bucket: storage.bucket, archiveRoot });
  const first = await runtime.promote(firstPlan);
  assert.equal(first.status, "completed");
  assert.deepEqual(first.receipts.map((receipt) => receipt.status), ["committed"]);
  assert.equal(first.counts.committed, 1);
  const stored = await database.prisma.attachment.findUniqueOrThrow({ where: { id: firstAttachmentId } });
  assert.equal(stored.status, "ready");
  assert.equal(stored.sha256, sha256(pixel));
  assert.equal(await database.prisma.legacyIdempotencyMapping.count({ where: { targetEntityId: firstAttachmentId } }), 1);

  const replay = await runtime.promote(firstPlan);
  assert.equal(replay.status, "completed");
  assert.deepEqual(replay.receipts.map((receipt) => receipt.status), ["replayed"]);
  assert.equal(await database.prisma.legacyIdempotencyMapping.count({ where: { targetEntityId: firstAttachmentId } }), 1);

  const wrongMime = Buffer.from(pixel);
  await client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: firstKey, Body: wrongMime, ContentLength: wrongMime.length, ContentType: "application/pdf" }));
  const mimeMismatch = await runtime.promote(firstPlan);
  assert.equal(mimeMismatch.status, "quarantined");
  assert.equal(mimeMismatch.quarantine[0]?.code, "OBJECT_MIME_MISMATCH");
  await client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: firstKey, Body: Buffer.from(pixel).fill(0, 0, 1), ContentLength: pixel.length, ContentType: "image/png" }));
  const hashMismatch = await runtime.promote(firstPlan);
  assert.equal(hashMismatch.status, "quarantined");
  assert.equal(hashMismatch.quarantine[0]?.code, "OBJECT_HASH_MISMATCH");
  assert.equal((await database.prisma.attachment.findUniqueOrThrow({ where: { id: firstAttachmentId } })).status, "ready");

  const foreignPlan = planFor({
    token: suffix,
    sourcePath: firstPath,
    sourceId: "test_growth_cross_tenant",
    attachmentId: `test_legacy_cross_tenant_${suffix}`,
    familyId: otherFamilyId,
    babyId,
    uploaderId: userId,
    bytes: pixel,
  });
  const foreign = await runtime.promote(foreignPlan);
  assert.equal(foreign.status, "quarantined");
  assert.equal(foreign.quarantine[0]?.code, "OWNER_NOT_AUTHORIZED");
  await assert.rejects(client.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: foreignPlan.receipts![0]!.targetObjectKey })), isNotFound);

  const failurePlan = planFor({ token: suffix, sourcePath: failurePath, sourceId: "test_growth_db_failure", attachmentId: failureAttachmentId, familyId, babyId, uploaderId: userId, bytes: pixel });
  const traversal = await runtime.promote({
    ...failurePlan,
    receipts: [{ ...failurePlan.receipts![0]!, sourcePath: "public/uploads/../escape.png" }],
  });
  assert.equal(traversal.status, "quarantined");
  assert.equal(traversal.quarantine[0]?.code, "PATH_TRAVERSAL");
  const symlinkedPath = path.join(archiveRoot, "files", "public", "uploads", "symlink-dir");
  await fsp.symlink(path.join(archiveRoot, "files", "public", "uploads", "growth"), symlinkedPath, "dir");
  const symlinked = await runtime.promote({
    ...failurePlan,
    receipts: [{ ...failurePlan.receipts![0]!, sourcePath: "public/uploads/symlink-dir/test-pixel.png" }],
  });
  assert.equal(symlinked.status, "quarantined");
  assert.equal(symlinked.quarantine[0]?.code, "SYMLINK_REJECTED");
  const missing = await runtime.promote({
    ...failurePlan,
    receipts: [{ ...failurePlan.receipts![0]!, sourcePath: "public/uploads/growth/does-not-exist.png" }],
  });
  assert.equal(missing.status, "quarantined");
  assert.equal(missing.quarantine[0]?.code, "SOURCE_MISSING");
  const hashMismatchPlan = planFor({ token: suffix, sourcePath: failurePath, sourceId: "test_growth_source_hash_mismatch", attachmentId: `test_legacy_source_hash_${suffix}`, familyId, babyId, uploaderId: userId, bytes: pixel });
  const hashMismatchReceipt = hashMismatchPlan.receipts![0]!;
  const sourceHashMismatch = await runtime.promote({
    ...hashMismatchPlan,
    receipts: [{
      ...hashMismatchReceipt,
      targetSha256: "0".repeat(64),
      attachment: { ...hashMismatchReceipt.attachment, sha256: "0".repeat(64) },
    }],
  });
  assert.equal(sourceHashMismatch.status, "quarantined");
  assert.equal(sourceHashMismatch.quarantine[0]?.code, "SOURCE_HASH_MISMATCH");
  let injectFailure = true;
  const failingRuntime = new LegacyAttachmentPromotionRuntime({
    prisma: database.prisma,
    s3: client,
    bucket: storage.bucket,
    archiveRoot,
    hooks: { afterAttachmentWrite: () => { if (injectFailure) { injectFailure = false; throw new Error("test database commit failure"); } } },
  });
  const failed = await failingRuntime.promote(failurePlan);
  assert.equal(failed.status, "quarantined");
  assert.equal(failed.quarantine[0]?.code, "DATABASE_COMMIT_FAILED");
  assert.equal(failed.storage.objectStore, "residual_object");
  assert.equal(await database.prisma.attachment.count({ where: { id: failureAttachmentId } }), 0);
  assert.equal(await database.prisma.legacyIdempotencyMapping.count({ where: { targetEntityId: failureAttachmentId } }), 0);
  const reconciled = await runtime.reconcile(failurePlan);
  assert.equal(reconciled.status, "completed");
  assert.deepEqual(reconciled.receipts.map((receipt) => receipt.status), ["reconciled"]);
  assert.equal((await database.prisma.attachment.findUniqueOrThrow({ where: { id: failureAttachmentId } })).status, "ready");
  assert.equal(await database.prisma.legacyIdempotencyMapping.count({ where: { targetEntityId: failureAttachmentId } }), 1);
});
