import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { referenceData } from "../../apps/api/src/knowledge/legacy-reference-data.js";
import { vaccineEngineRules } from "../../apps/api/src/knowledge/vaccine-engine-rules.js";
import { books } from "../../apps/api/src/knowledge/books-data.js";

const LEGACY_REFERENCE_GOLDEN = {
  sourceCommit: "0b3e87c202b7420cb2ad2e1ee5d24cab3ceea156",
  milestones: { count: 119, hash: "3dfecd94ae22a6d1fada509b20ba6231346d41af6e18481a958b96f9eb8f020b" },
  warningSigns: { count: 32, hash: "046bb54a4e30ce541dcf34b962c910f08b0f5907fd764484becddf860c93b2a0" },
  activities: { count: 25, hash: "bd34e983417db9c8d47361465d7befb6303bad3cfbf3f4e2d0dd960328fee398" },
  guidelines: { count: 4, hash: "14826d0dc44ad4fc8d52b70fd6cc90b233a42e0a1647169b7cf423cbf0ce6cb5" },
  sources: { count: 59, hash: "ca66b11a6768037a06a3c3e9327802584553093e8cc5f94b37011e498c3cc2cd" },
  releaseMetadataHash: "4562b1b408a09ecb262522777fd20826c1b81a71bba7aaa09f9b549a48a6275f",
  vaccineEngineRules: { count: 8, hash: "c85fac1f63c5a34aa812fa22d37f3987d5244aedfee234b0aea2425149524c27" },
  books: { count: 5, hash: "fb6fa9b5585d638de64a309148cfeefc3c719f4b664506cb3443409590c4521d" },
} as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function withoutAliases(rows: Record<string, unknown>[], aliases: readonly string[]): Record<string, unknown>[] {
  const excluded = new Set(aliases);
  return rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !excluded.has(key))));
}

test("legacy public knowledge remains byte-faithful after compatibility aliases are removed", () => {
  const projections = [
    {
      name: "milestones",
      rows: referenceData.milestones,
      aliases: ["milestoneId", "monthAge", "ageRangeEarliestMonth", "ageRangeMedianMonth", "ageRangeLatestMonth"],
      golden: LEGACY_REFERENCE_GOLDEN.milestones,
    },
    {
      name: "warningSigns",
      rows: referenceData.warningSigns,
      aliases: ["warningSignId", "monthAge", "signText", "actionAdvice"],
      golden: LEGACY_REFERENCE_GOLDEN.warningSigns,
    },
    {
      name: "activities",
      rows: referenceData.activities,
      aliases: ["activityId", "monthAge", "content", "targetMonthMin", "targetMonthMax"],
      golden: LEGACY_REFERENCE_GOLDEN.activities,
    },
    {
      name: "guidelines",
      rows: referenceData.guidelines,
      aliases: ["id"],
      golden: LEGACY_REFERENCE_GOLDEN.guidelines,
    },
  ] as const;

  for (const projection of projections) {
    assert.equal(projection.rows.length, projection.golden.count, `${projection.name} count drifted`);
    assert.equal(sha256(withoutAliases(projection.rows, projection.aliases)), projection.golden.hash, `${projection.name} content drifted`);
  }
});

test("legacy release metadata and source references retain their golden hashes", () => {
  const { sources, ...releaseMetadata } = referenceData.dataRelease as Record<string, unknown> & { sources: Record<string, unknown>[] };
  assert.equal(sources.length, LEGACY_REFERENCE_GOLDEN.sources.count);
  assert.equal(new Set(sources.map((source) => source.id)).size, sources.length, "source reference IDs must remain unique");
  assert.equal(sha256(sources), LEGACY_REFERENCE_GOLDEN.sources.hash);
  assert.equal(sha256(releaseMetadata), LEGACY_REFERENCE_GOLDEN.releaseMetadataHash);
});

test("legacy vaccine engine rules retain their golden hash", () => {
  assert.equal(vaccineEngineRules.length, LEGACY_REFERENCE_GOLDEN.vaccineEngineRules.count);
  assert.equal(sha256(vaccineEngineRules), LEGACY_REFERENCE_GOLDEN.vaccineEngineRules.hash);
});

test("legacy books retain their golden hash", () => {
  assert.equal(books.length, LEGACY_REFERENCE_GOLDEN.books.count);
  assert.equal(sha256(books), LEGACY_REFERENCE_GOLDEN.books.hash);
});
