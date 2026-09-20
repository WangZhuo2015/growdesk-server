import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ATTACHMENT_REFERENCE_BACKFILL_MAPPING_VERSION,
  planAttachmentReferenceBackfill,
} from "../../scripts/legacy-import/attachment-reference-backfill.js";
import { ATTACHMENT_PROMOTION_MAPPING_VERSION, type PlannedAttachmentReport } from "../../scripts/legacy-import/attachment-promotion-runtime.js";

const batch = "a".repeat(64);
const hash = "b".repeat(64);

function receipt(options: {
  table: string;
  id: string;
  field: string;
  path: string;
  purpose: string;
  babyId: string | null;
  attachmentId: string;
}): NonNullable<PlannedAttachmentReport["receipts"]>[number] {
  const objectKey = `families/test_reference_family/attachments/${options.purpose}/legacy/${options.attachmentId}.png`;
  return {
    sourceSystem: "test_reference_snapshot",
    sourceBatchId: batch,
    sourceTable: options.table,
    sourceId: options.id,
    sourceField: options.field,
    sourcePath: options.path,
    sourceHash: hash,
    mappingVersion: ATTACHMENT_PROMOTION_MAPPING_VERSION,
    result: "planned",
    storageState: "not_copied",
    targetAttachmentId: options.attachmentId,
    targetObjectKey: objectKey,
    targetSha256: hash,
    targetByteSize: 4,
    attachment: {
      id: options.attachmentId,
      familyId: "test_reference_family",
      babyId: options.babyId,
      uploaderId: "test_reference_user",
      purpose: options.purpose,
      mimeType: options.purpose === "medical_report" ? "application/pdf" : "image/png",
      byteSize: 4,
      sha256: hash,
      objectKey,
      status: "pending",
    },
  };
}

test("pure reference planner maps only canonical Baby/Growth/Medical fields", () => {
  const report: PlannedAttachmentReport = {
    mappingVersion: ATTACHMENT_PROMOTION_MAPPING_VERSION,
    receipts: [
      receipt({ table: "Baby", id: "test_reference_baby", field: "avatarUrl", path: "public/uploads/avatar/test.png", purpose: "avatar", babyId: null, attachmentId: "test_reference_avatar" }),
      receipt({ table: "GrowthMeasurement", id: "test_reference_growth", field: "imageUrl", path: "public/uploads/growth/test.png", purpose: "growth_photo", babyId: "test_reference_baby", attachmentId: "test_reference_growth_attachment" }),
      receipt({ table: "MedicalReport", id: "test_reference_medical", field: "imageUrl", path: "public/uploads/medical/test.png", purpose: "medical_report", babyId: "test_reference_baby", attachmentId: "test_reference_medical_attachment" }),
    ],
  };

  const plan = planAttachmentReferenceBackfill(report);
  assert.equal(plan.status, "planned");
  assert.equal(plan.mappingVersion, ATTACHMENT_REFERENCE_BACKFILL_MAPPING_VERSION);
  assert.deepEqual(plan.references.map((item) => item.kind), ["baby_avatar", "growth_photo", "medical_report"]);
  assert.equal(plan.references[0]?.targetBabyId, "test_reference_baby");
  assert.equal(plan.references[1]?.sourceKey, `${batch}/GrowthMeasurement/test_reference_growth/imageUrl/public/uploads/growth/test.png`);
  assert.deepEqual(plan.quarantine, []);
});

test("AI and voice references are reported without guessing a canonical field", () => {
  const report: PlannedAttachmentReport = {
    mappingVersion: ATTACHMENT_PROMOTION_MAPPING_VERSION,
    receipts: [
      receipt({ table: "AiJob", id: "test_reference_ai_job", field: "imageUrl", path: "public/uploads/ai/test.png", purpose: "growth_photo", babyId: "test_reference_baby", attachmentId: "test_reference_ai_attachment" }),
      receipt({ table: "AiArchive", id: "test_reference_voice", field: "filePath", path: "data/archive/test.m4a", purpose: "voice_note", babyId: "test_reference_baby", attachmentId: "test_reference_voice_attachment" }),
    ],
  };

  const plan = planAttachmentReferenceBackfill(report);
  assert.equal(plan.status, "quarantined");
  assert.deepEqual(plan.references, []);
  assert.deepEqual(plan.quarantine.map((item) => item.code), ["UNSUPPORTED_REFERENCE", "UNSUPPORTED_REFERENCE"]);
});

test("planner fails closed on duplicate, public URL, and purpose mismatch", () => {
  const first = receipt({ table: "GrowthMeasurement", id: "test_reference_growth", field: "imageUrl", path: "public/uploads/growth/test.png", purpose: "growth_photo", babyId: "test_reference_baby", attachmentId: "test_reference_growth_attachment" });
  const report: PlannedAttachmentReport = {
    mappingVersion: ATTACHMENT_PROMOTION_MAPPING_VERSION,
    receipts: [
      first,
      { ...first },
      receipt({ table: "Baby", id: "test_reference_baby", field: "avatarUrl", path: "https://legacy.test/test.png", purpose: "avatar", babyId: null, attachmentId: "test_reference_public_avatar" }),
      receipt({ table: "MedicalReport", id: "test_reference_medical", field: "imageUrl", path: "public/uploads/medical/test.png", purpose: "avatar", babyId: "test_reference_baby", attachmentId: "test_reference_wrong_purpose" }),
    ],
  };

  const plan = planAttachmentReferenceBackfill(report);
  assert.equal(plan.status, "quarantined");
  assert.equal(plan.references.length, 1);
  assert.deepEqual(plan.quarantine.map((item) => item.code), ["DUPLICATE_SOURCE_REFERENCE", "INVALID_SOURCE_PATH", "PURPOSE_MISMATCH"]);
});
