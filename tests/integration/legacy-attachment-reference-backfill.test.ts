/** Run only through an owned PostgreSQL integration environment. */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabaseContext } from "../../packages/database/src/client.js";
import { requireTestDatabaseUrl } from "../../packages/testkit/src/environment.js";
import {
  backfillAttachmentReferences,
  planAttachmentReferenceBackfill,
} from "../../scripts/legacy-import/attachment-reference-backfill.js";
import { ATTACHMENT_PROMOTION_MAPPING_VERSION, type PlannedAttachmentReport } from "../../scripts/legacy-import/attachment-promotion-runtime.js";

interface OwnedRun {
  readonly directory: string;
  readonly token: string;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly pgPort: number;
}

function readRun(): OwnedRun {
  const file = process.env.BOOT02_RUN_FILE;
  if (!file) throw new Error("Reference backfill integration requires the managed test runner");
  const real = fs.realpathSync(file);
  const root = path.dirname(real);
  if (path.dirname(root) !== fs.realpathSync(os.tmpdir()) || !path.basename(root).startsWith("growdesk-integration-")) {
    throw new Error("Integration manifest is outside its private run");
  }
  const stat = fs.statSync(real);
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("Unsafe integration manifest permissions");
  return JSON.parse(fs.readFileSync(real, "utf8")) as OwnedRun;
}

function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value, Object.keys(value as object).sort())).digest("hex");
}

function sourceKey(batchId: string, table: string, sourceId: string, field: string, sourcePath: string): string {
  return [batchId, table, sourceId, field, sourcePath].join("/");
}

function reportReceipt(options: {
  readonly sourceSystem: string;
  readonly sourceBatchId: string;
  readonly sourceTable: string;
  readonly sourceId: string;
  readonly sourceField: string;
  readonly sourcePath: string;
  readonly sourceHash: string;
  readonly targetAttachmentId: string;
  readonly familyId: string;
  readonly babyId: string | null;
  readonly purpose: string;
  readonly uploaderId: string;
}): NonNullable<PlannedAttachmentReport["receipts"]>[number] {
  const targetHash = "d".repeat(64);
  const extension = options.purpose === "medical_report" ? "pdf" : "png";
  const objectKey = `families/${options.familyId}/attachments/${options.purpose}/legacy/${options.targetAttachmentId}.${extension}`;
  return {
    sourceSystem: options.sourceSystem,
    sourceBatchId: options.sourceBatchId,
    sourceTable: options.sourceTable,
    sourceId: options.sourceId,
    sourceField: options.sourceField,
    sourcePath: options.sourcePath,
    sourceHash: options.sourceHash,
    mappingVersion: ATTACHMENT_PROMOTION_MAPPING_VERSION,
    result: "planned",
    storageState: "not_copied",
    targetAttachmentId: options.targetAttachmentId,
    targetObjectKey: objectKey,
    targetSha256: targetHash,
    targetByteSize: 4,
    attachment: {
      id: options.targetAttachmentId,
      familyId: options.familyId,
      babyId: options.babyId,
      uploaderId: options.uploaderId,
      purpose: options.purpose,
      mimeType: options.purpose === "medical_report" ? "application/pdf" : "image/png",
      byteSize: 4,
      sha256: targetHash,
      objectKey,
      status: "pending",
    },
  };
}

test("owned PG backfills private avatar, growth and medical references atomically and idempotently", async (t) => {
  const run = readRun();
  const databaseUrl = requireTestDatabaseUrl(
    `postgresql://${run.user}:${run.password}@127.0.0.1:${run.pgPort}/${run.database}?sslmode=disable`,
    { host: "127.0.0.1", port: run.pgPort, database: run.database, role: run.user, password: run.password },
  );
  const database = createDatabaseContext({ url: databaseUrl });
  const suffix = run.token;
  const sourceSystem = "test_reference_backfill_snapshot";
  const batchId = crypto.createHash("sha256").update(`test_reference_backfill/${suffix}`).digest("hex");
  const familyId = `test_reference_backfill_family_${suffix}`;
  const otherFamilyId = `test_reference_backfill_other_family_${suffix}`;
  const userId = `test_reference_backfill_user_${suffix}`;
  const babyId = `test_reference_backfill_baby_${suffix}`;
  const otherBabyId = `test_reference_backfill_other_baby_${suffix}`;
  const growthId = `test_reference_backfill_growth_${suffix}`;
  const foreignGrowthId = `test_reference_backfill_foreign_growth_${suffix}`;
  const medicalId = `test_reference_backfill_medical_${suffix}`;
  const avatarAttachmentId = crypto.randomUUID();
  const growthAttachmentId = `test_reference_backfill_growth_attachment_${suffix}`;
  const medicalAttachmentId = `test_reference_backfill_medical_attachment_${suffix}`;
  const otherAttachmentId = `test_reference_backfill_other_attachment_${suffix}`;
  const growthPath = "public/uploads/growth/test-growth.png";
  const medicalPath = "public/uploads/medical/test-medical.png";
  const avatarPath = "public/uploads/avatar/test-avatar.png";
  const babyPayload = { id: babyId, familyId, nickname: "test_reference_backfill_baby", avatarUrl: "/uploads/avatar/test-avatar.png" };
  const growthPayload = { id: growthId, babyId, date: "2026-09-18", imageUrl: "/uploads/growth/test-growth.png" };
  const medicalPayload = { id: medicalId, babyId, date: "2026-09-18", title: "test_reference_backfill_medical", imageUrl: "/uploads/medical/test-medical.png" };
  const rows = [
    { table: "Baby", id: babyId, path: avatarPath, payload: babyPayload, familyId, babyId: null },
    { table: "GrowthMeasurement", id: growthId, path: growthPath, payload: growthPayload, familyId, babyId },
    { table: "MedicalReport", id: medicalId, path: medicalPath, payload: medicalPayload, familyId, babyId },
  ] as const;
  const sourceHashes = new Map(rows.map((row) => [`${row.table}/${row.id}`, sha256(row.payload)]));
  const allAttachmentIds = [avatarAttachmentId, growthAttachmentId, medicalAttachmentId, otherAttachmentId];

  t.after(async () => {
    await database.prisma.legacyIdempotencyMapping.deleteMany({ where: { sourceBatchId: batchId } });
    await database.prisma.medicalReportAttachment.deleteMany({ where: { reportId: medicalId } });
    await database.prisma.growthMeasurement.deleteMany({ where: { id: growthId } });
    await database.prisma.medicalReport.deleteMany({ where: { id: medicalId } });
    await database.prisma.attachment.deleteMany({ where: { id: { in: allAttachmentIds } } });
    await database.prisma.legacyImportRow.deleteMany({ where: { batchId } });
    await database.prisma.legacyImportBatch.deleteMany({ where: { id: batchId } });
    await database.prisma.babyMember.deleteMany({ where: { babyId: { in: [babyId, otherBabyId] } } });
    await database.prisma.familyMember.deleteMany({ where: { userId: userId } });
    await database.prisma.baby.deleteMany({ where: { id: { in: [babyId, otherBabyId] } } });
    await database.prisma.family.deleteMany({ where: { id: { in: [familyId, otherFamilyId] } } });
    await database.prisma.user.deleteMany({ where: { id: userId } });
    await database.close();
  });

  await database.prisma.user.create({ data: { id: userId, username: `${userId}_${suffix}`, passwordHash: "test-only", displayName: "test reference backfill" } });
  await database.prisma.family.create({ data: { id: familyId, name: "test reference backfill family" } });
  await database.prisma.family.create({ data: { id: otherFamilyId, name: "test reference other family" } });
  await database.prisma.familyMember.create({ data: { id: `test_reference_backfill_member_${suffix}`, familyId, userId, role: "admin", relation: "parent", status: "active" } });
  await database.prisma.familyMember.create({ data: { id: `test_reference_backfill_other_member_${suffix}`, familyId: otherFamilyId, userId, role: "admin", relation: "parent", status: "active" } });
  await database.prisma.baby.create({ data: { id: babyId, familyId, nickname: "test reference baby", birthDate: new Date("2026-01-01"), gender: "unknown" } });
  await database.prisma.baby.create({ data: { id: otherBabyId, familyId: otherFamilyId, nickname: "test reference other baby", birthDate: new Date("2026-01-01"), gender: "unknown" } });
  await database.prisma.babyMember.create({ data: { id: `test_reference_backfill_baby_member_${suffix}`, familyId, babyId, userId, role: "admin", status: "active" } });
  await database.prisma.babyMember.create({ data: { id: `test_reference_backfill_other_baby_member_${suffix}`, familyId: otherFamilyId, babyId: otherBabyId, userId, role: "admin", status: "active" } });
  await database.prisma.legacyImportBatch.create({
    data: {
      id: batchId,
      sourceSystem,
      sourceSnapshot: "test_legacy_snapshot",
      checksum: batchId,
      mappingVersion: "identity-v1",
      rowCount: rows.length,
      tableCounts: { Baby: 1, GrowthMeasurement: 1, MedicalReport: 1 },
    },
  });
  for (const row of rows) {
    await database.prisma.legacyImportRow.create({
      data: {
        batchId,
        sourceTable: row.table,
        sourceId: row.id,
        familyId: row.familyId,
        babyId: row.babyId,
        payload: row.payload,
        payloadHash: sourceHashes.get(`${row.table}/${row.id}`)!,
      },
    });
  }
  await database.prisma.growthMeasurement.create({
    data: { id: growthId, familyId, babyId, measurementDate: new Date("2026-09-18"), weightKg: "7.25", heightCm: "66.5", headCircumferenceCm: null, notes: null },
  });
  await database.prisma.medicalReport.create({
    data: { id: medicalId, familyId, babyId, caregiverId: userId, reportDate: new Date("2026-09-18"), title: "test_reference_backfill_medical", hospital: null, department: null, diagnosis: null, notes: null, items: [] },
  });
  for (const [type, id, table, sourceId] of [
    ["growth", `test_reference_backfill_growth_mapping_${suffix}`, "GrowthMeasurement", growthId],
    ["medical", `test_reference_backfill_medical_mapping_${suffix}`, "MedicalReport", medicalId],
  ] as const) {
    await database.prisma.legacyIdempotencyMapping.create({
      data: {
        id,
        targetEntityType: type,
        targetEntityId: type === "growth" ? growthId : medicalId,
        sourceKey: `${batchId}/${table}/${sourceId}`,
        status: "mapped",
        sourceSystem,
        sourceBatchId: batchId,
        sourceTable: table,
        sourceId,
        sourceHash: sourceHashes.get(`${table}/${sourceId}`)!,
        mappingVersion: type === "growth" ? "care-v1" : "medical-v1",
      },
    });
  }

  const receipts = [
    reportReceipt({ sourceSystem, sourceBatchId: batchId, sourceTable: "Baby", sourceId: babyId, sourceField: "avatarUrl", sourcePath: avatarPath, sourceHash: sourceHashes.get(`Baby/${babyId}`)!, targetAttachmentId: avatarAttachmentId, familyId, babyId: null, purpose: "avatar", uploaderId: userId }),
    reportReceipt({ sourceSystem, sourceBatchId: batchId, sourceTable: "GrowthMeasurement", sourceId: growthId, sourceField: "imageUrl", sourcePath: growthPath, sourceHash: sourceHashes.get(`GrowthMeasurement/${growthId}`)!, targetAttachmentId: growthAttachmentId, familyId, babyId, purpose: "growth_photo", uploaderId: userId }),
    reportReceipt({ sourceSystem, sourceBatchId: batchId, sourceTable: "MedicalReport", sourceId: medicalId, sourceField: "imageUrl", sourcePath: medicalPath, sourceHash: sourceHashes.get(`MedicalReport/${medicalId}`)!, targetAttachmentId: medicalAttachmentId, familyId, babyId, purpose: "medical_report", uploaderId: userId }),
  ];
  for (const receipt of receipts) {
    await database.prisma.attachment.create({
      data: {
        id: receipt.targetAttachmentId,
        familyId: receipt.attachment.familyId,
        babyId: receipt.attachment.babyId,
        uploaderId: userId,
        purpose: receipt.attachment.purpose,
        mimeType: receipt.attachment.mimeType,
        byteSize: receipt.attachment.byteSize,
        sha256: receipt.attachment.sha256,
        objectKey: receipt.attachment.objectKey,
        status: "ready",
        expiresAt: new Date("9999-12-31T23:59:59.999Z"),
      },
    });
    await database.prisma.legacyIdempotencyMapping.create({
      data: {
        id: `test_reference_backfill_attachment_mapping_${receipt.targetAttachmentId}`,
        targetEntityType: "attachment",
        targetEntityId: receipt.targetAttachmentId,
        sourceKey: sourceKey(batchId, receipt.sourceTable, receipt.sourceId, receipt.sourceField, receipt.sourcePath),
        status: "mapped",
        sourceSystem,
        sourceBatchId: batchId,
        sourceTable: receipt.sourceTable,
        sourceId: receipt.sourceId,
        sourceHash: receipt.sourceHash,
        mappingVersion: ATTACHMENT_PROMOTION_MAPPING_VERSION,
        metadata: {
          sourcePath: receipt.sourcePath,
          familyId: receipt.attachment.familyId,
          babyId: receipt.attachment.babyId,
          uploaderId: userId,
          purpose: receipt.attachment.purpose,
          mimeType: receipt.attachment.mimeType,
          byteSize: receipt.attachment.byteSize,
          sha256: receipt.attachment.sha256,
          objectKey: receipt.attachment.objectKey,
          storageState: "ready",
        },
      },
    });
  }

  const report: PlannedAttachmentReport = { mappingVersion: ATTACHMENT_PROMOTION_MAPPING_VERSION, receipts };
  const plan = planAttachmentReferenceBackfill(report);
  assert.equal(plan.status, "planned");
  const first = await backfillAttachmentReferences(database.prisma, plan);
  assert.equal(first.status, "completed");
  assert.deepEqual(first.receipts.map((item) => item.status), ["committed", "committed", "committed"]);
  assert.equal((await database.prisma.growthMeasurement.findUniqueOrThrow({ where: { id: growthId } })).attachmentId, growthAttachmentId);
  assert.equal(await database.prisma.medicalReportAttachment.count({ where: { reportId: medicalId, attachmentId: medicalAttachmentId } }), 1);
  const mappedBaby = await database.prisma.baby.findUniqueOrThrow({ where: { id: babyId } });
  assert.equal(mappedBaby.avatarUrl, `/api/attachments/${avatarAttachmentId}`);
  assert.equal((mappedBaby.avatarMetadata as { state?: string }).state, "private_attachment_mapped");
  assert.equal("legacyUrl" in (mappedBaby.avatarMetadata as object), false);
  assert.equal((await database.prisma.attachment.findUniqueOrThrow({ where: { id: avatarAttachmentId } })).babyId, babyId);
  assert.equal(await database.prisma.legacyIdempotencyMapping.count({ where: { targetEntityType: "attachment_reference", sourceBatchId: batchId } }), 3);

  const replay = await backfillAttachmentReferences(database.prisma, plan);
  assert.equal(replay.status, "completed");
  assert.deepEqual(replay.receipts.map((item) => item.status), ["replayed", "replayed", "replayed"]);
  assert.equal(await database.prisma.medicalReportAttachment.count({ where: { reportId: medicalId, attachmentId: medicalAttachmentId } }), 1);

  await database.prisma.baby.update({ where: { id: babyId }, data: { avatarUrl: "https://legacy.test/public-avatar.png" } });
  const noPublicFallback = await backfillAttachmentReferences(database.prisma, plan);
  assert.equal(noPublicFallback.status, "quarantined");
  assert.equal(noPublicFallback.quarantine[0]?.code, "BUSINESS_REFERENCE_CONFLICT");
  assert.equal((await database.prisma.baby.findUniqueOrThrow({ where: { id: babyId } })).avatarUrl, "https://legacy.test/public-avatar.png");
  await database.prisma.baby.update({ where: { id: babyId }, data: { avatarUrl: `/api/attachments/${avatarAttachmentId}` } });

  await database.prisma.attachment.update({ where: { id: growthAttachmentId }, data: { status: "pending" } });
  const notReady = await backfillAttachmentReferences(database.prisma, plan);
  assert.equal(notReady.status, "quarantined");
  assert.equal(notReady.quarantine[0]?.code, "ATTACHMENT_NOT_READY");
  await database.prisma.attachment.update({ where: { id: growthAttachmentId }, data: { status: "ready" } });

  // A cross-family attachment must not be attached to the otherwise valid growth row.
  await database.prisma.attachment.create({
    data: {
      id: otherAttachmentId,
      familyId: otherFamilyId,
      babyId: otherBabyId,
      uploaderId: userId,
      purpose: "growth_photo",
      mimeType: "image/png",
      byteSize: 4,
      sha256: "d".repeat(64),
      objectKey: `families/${otherFamilyId}/attachments/growth_photo/legacy/${otherAttachmentId}.png`,
      status: "ready",
      expiresAt: new Date("9999-12-31T23:59:59.999Z"),
    },
  });
  const foreignPayload = { id: foreignGrowthId, babyId, date: "2026-09-17", imageUrl: "/uploads/growth/test-growth.png" };
  const foreignHash = sha256(foreignPayload);
  await database.prisma.legacyImportRow.create({ data: { batchId, sourceTable: "GrowthMeasurement", sourceId: foreignGrowthId, familyId, babyId, payload: foreignPayload, payloadHash: foreignHash } });
  await database.prisma.growthMeasurement.create({ data: { id: foreignGrowthId, familyId, babyId, measurementDate: new Date("2026-09-17"), weightKg: "7.20", heightCm: null, headCircumferenceCm: null, notes: null } });
  await database.prisma.legacyIdempotencyMapping.create({ data: { id: `test_reference_backfill_foreign_business_${suffix}`, targetEntityType: "growth", targetEntityId: foreignGrowthId, sourceKey: `${batchId}/GrowthMeasurement/${foreignGrowthId}`, status: "mapped", sourceSystem, sourceBatchId: batchId, sourceTable: "GrowthMeasurement", sourceId: foreignGrowthId, sourceHash: foreignHash, mappingVersion: "care-v1" } });
  const foreignReceipt = reportReceipt({ sourceSystem, sourceBatchId: batchId, sourceTable: "GrowthMeasurement", sourceId: foreignGrowthId, sourceField: "imageUrl", sourcePath: growthPath, sourceHash: foreignHash, targetAttachmentId: otherAttachmentId, familyId: otherFamilyId, babyId: otherBabyId, purpose: "growth_photo", uploaderId: userId });
  await database.prisma.legacyIdempotencyMapping.create({
    data: {
      id: `test_reference_backfill_foreign_attachment_mapping_${suffix}`,
      targetEntityType: "attachment",
      targetEntityId: otherAttachmentId,
      sourceKey: sourceKey(batchId, "GrowthMeasurement", foreignGrowthId, "imageUrl", growthPath),
      status: "mapped",
      sourceSystem,
      sourceBatchId: batchId,
      sourceTable: "GrowthMeasurement",
      sourceId: foreignGrowthId,
      sourceHash: foreignReceipt.sourceHash,
      mappingVersion: ATTACHMENT_PROMOTION_MAPPING_VERSION,
      metadata: { sourcePath: growthPath, familyId: otherFamilyId, babyId: otherBabyId, uploaderId: userId, purpose: "growth_photo", mimeType: "image/png", byteSize: 4, sha256: "d".repeat(64), objectKey: foreignReceipt.targetObjectKey, storageState: "ready" },
    },
  });
  const foreignPlan = planAttachmentReferenceBackfill({ mappingVersion: ATTACHMENT_PROMOTION_MAPPING_VERSION, receipts: [foreignReceipt] });
  const foreign = await backfillAttachmentReferences(database.prisma, foreignPlan);
  assert.equal(foreign.status, "quarantined");
  assert.equal(foreign.quarantine[0]?.code, "REFERENCE_SCOPE_MISMATCH");
  assert.equal((await database.prisma.growthMeasurement.findUniqueOrThrow({ where: { id: growthId } })).attachmentId, growthAttachmentId);

  // Demonstrate whole-batch rollback: first reference is valid, second crosses
  // the tenant scope. The first target remains untouched after the failure.
  const rollbackGrowthId = `test_reference_backfill_rollback_growth_${suffix}`;
  const rollbackAttachmentId = `test_reference_backfill_rollback_attachment_${suffix}`;
  const rollbackPath = "public/uploads/growth/test-rollback.png";
  const rollbackPayload = { id: rollbackGrowthId, babyId, imageUrl: "/uploads/growth/test-rollback.png" };
  const rollbackHash = sha256(rollbackPayload);
  await database.prisma.legacyImportRow.create({ data: { batchId, sourceTable: "GrowthMeasurement", sourceId: rollbackGrowthId, familyId, babyId, payload: rollbackPayload, payloadHash: rollbackHash } });
  await database.prisma.growthMeasurement.create({ data: { id: rollbackGrowthId, familyId, babyId, measurementDate: new Date("2026-09-17"), weightKg: "7.10", heightCm: null, headCircumferenceCm: null, notes: null } });
  await database.prisma.legacyIdempotencyMapping.create({ data: { id: `test_reference_backfill_rollback_business_${suffix}`, targetEntityType: "growth", targetEntityId: rollbackGrowthId, sourceKey: `${batchId}/GrowthMeasurement/${rollbackGrowthId}`, status: "mapped", sourceSystem, sourceBatchId: batchId, sourceTable: "GrowthMeasurement", sourceId: rollbackGrowthId, sourceHash: rollbackHash, mappingVersion: "care-v1" } });
  await database.prisma.attachment.create({ data: { id: rollbackAttachmentId, familyId, babyId, uploaderId: userId, purpose: "growth_photo", mimeType: "image/png", byteSize: 4, sha256: "d".repeat(64), objectKey: `families/${familyId}/attachments/growth_photo/legacy/${rollbackAttachmentId}.png`, status: "ready", expiresAt: new Date("9999-12-31T23:59:59.999Z") } });
  const rollbackReceipt = reportReceipt({ sourceSystem, sourceBatchId: batchId, sourceTable: "GrowthMeasurement", sourceId: rollbackGrowthId, sourceField: "imageUrl", sourcePath: rollbackPath, sourceHash: rollbackHash, targetAttachmentId: rollbackAttachmentId, familyId, babyId, purpose: "growth_photo", uploaderId: userId });
  await database.prisma.legacyIdempotencyMapping.create({ data: { id: `test_reference_backfill_rollback_attachment_mapping_${suffix}`, targetEntityType: "attachment", targetEntityId: rollbackAttachmentId, sourceKey: sourceKey(batchId, "GrowthMeasurement", rollbackGrowthId, "imageUrl", rollbackPath), status: "mapped", sourceSystem, sourceBatchId: batchId, sourceTable: "GrowthMeasurement", sourceId: rollbackGrowthId, sourceHash: rollbackHash, mappingVersion: ATTACHMENT_PROMOTION_MAPPING_VERSION, metadata: { sourcePath: rollbackPath, familyId, babyId, uploaderId: userId, purpose: "growth_photo", mimeType: "image/png", byteSize: 4, sha256: "d".repeat(64), objectKey: rollbackReceipt.targetObjectKey, storageState: "ready" } } });
  const atomicPlan = planAttachmentReferenceBackfill({ mappingVersion: ATTACHMENT_PROMOTION_MAPPING_VERSION, receipts: [rollbackReceipt, foreignReceipt] });
  const atomic = await backfillAttachmentReferences(database.prisma, atomicPlan);
  assert.equal(atomic.status, "quarantined");
  assert.equal(atomic.storage.database, "not_written");
  assert.equal(atomic.quarantine[0]?.code, "REFERENCE_SCOPE_MISMATCH");
  assert.equal((await database.prisma.growthMeasurement.findUniqueOrThrow({ where: { id: rollbackGrowthId } })).attachmentId, null);
  assert.equal(await database.prisma.legacyIdempotencyMapping.count({ where: { targetEntityType: "attachment_reference", sourceId: rollbackGrowthId } }), 0);
});
