import test from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "../../packages/database/src/generated/client.js";
import { mapGrowthRow } from "../../packages/database/src/growth-repository.js";
import { mapEntityToGrowthMeasurement } from "../../apps/api/src/services/growth-service.js";

test("growth legacy metadata maps through the entity and DTO whitelist", () => {
  const entity = mapGrowthRow({
    id: "test_growth_row",
    familyId: "test_growth_family",
    babyId: "test_growth_baby",
    measurementDate: new Date("2026-09-18T00:00:00.000Z"),
    weightKg: new Prisma.Decimal("7.25"),
    heightCm: new Prisma.Decimal("66.5"),
    headCircumferenceCm: new Prisma.Decimal("42.5"),
    attachmentId: null,
    notes: "test human notes",
    legacyClientId: "test_growth_legacy_client",
    legacyMetadata: {
      sourceTable: "GrowthMeasurement",
      sourceBatchId: "test_growth_batch",
      legacyDate: "2026-09-18",
      legacyClientId: "test_growth_metadata_client",
      legacyRecordedById: "test_growth_recorder",
      legacySource: "ui_manual",
      legacySourceAgent: "test_growth_agent",
      legacyGrowth: {
        ageInMonths: 8,
        ageLabel: "8月18天",
        percentile: 75,
      },
      extra: {
        sessionToken: "test_secret_value",
        archiveOnlyField: "must_not_cross_boundary",
      },
    },
    version: 1,
    deletedAt: null,
    createdAt: new Date("2026-09-19T00:00:00.000Z"),
    updatedAt: new Date("2026-09-19T00:00:00.000Z"),
  });

  assert.deepEqual(
    {
      legacyDate: entity.legacyDate,
      legacyAgeInMonths: entity.legacyAgeInMonths,
      legacyAgeLabel: entity.legacyAgeLabel,
      legacyPercentile: entity.legacyPercentile,
      legacyClientId: entity.legacyClientId,
      legacyRecordedById: entity.legacyRecordedById,
      legacySource: entity.legacySource,
      legacySourceAgent: entity.legacySourceAgent,
    },
    {
      legacyDate: "2026-09-18",
      legacyAgeInMonths: 8,
      legacyAgeLabel: "8月18天",
      legacyPercentile: 75,
      legacyClientId: "test_growth_legacy_client",
      legacyRecordedById: "test_growth_recorder",
      legacySource: "ui_manual",
      legacySourceAgent: "test_growth_agent",
    },
  );

  const dto = mapEntityToGrowthMeasurement(entity);
  assert.deepEqual(
    {
      legacyDate: dto.legacyDate,
      legacyAgeInMonths: dto.legacyAgeInMonths,
      legacyAgeLabel: dto.legacyAgeLabel,
      legacyPercentile: dto.legacyPercentile,
      legacyClientId: dto.legacyClientId,
      legacyRecordedById: dto.legacyRecordedById,
      legacySource: dto.legacySource,
      legacySourceAgent: dto.legacySourceAgent,
    },
    {
      legacyDate: "2026-09-18",
      legacyAgeInMonths: 8,
      legacyAgeLabel: "8月18天",
      legacyPercentile: 75,
      legacyClientId: "test_growth_legacy_client",
      legacyRecordedById: "test_growth_recorder",
      legacySource: "ui_manual",
      legacySourceAgent: "test_growth_agent",
    },
  );
  assert.equal("legacyMetadata" in dto, false);
  assert.equal("extra" in dto, false);
  assert.equal("sessionToken" in dto, false);
});

test("growth metadata outside the importer marker stays out of the DTO", () => {
  const entity = mapGrowthRow({
    id: "test_growth_canonical",
    familyId: "test_growth_family",
    babyId: "test_growth_baby",
    measurementDate: new Date("2026-09-18T00:00:00.000Z"),
    weightKg: null,
    heightCm: null,
    headCircumferenceCm: null,
    attachmentId: null,
    notes: null,
    legacyClientId: "test_should_not_leak",
    legacyMetadata: {
      legacyDate: "2026-09-18",
      legacyGrowth: { ageInMonths: 8, ageLabel: "8月18天", percentile: 75 },
      extra: { secretToken: "test_secret_value" },
    },
    version: 1,
    deletedAt: null,
    createdAt: new Date("2026-09-19T00:00:00.000Z"),
    updatedAt: new Date("2026-09-19T00:00:00.000Z"),
  });

  const dto = mapEntityToGrowthMeasurement(entity);
  assert.equal("legacyDate" in dto, false);
  assert.equal("legacyClientId" in dto, false);
  assert.equal("legacyMetadata" in dto, false);
});
