/** API wire versions are strings; PostgreSQL record versions are signed int32. */
export function readRecordVersion(value: unknown): number {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw Object.assign(new Error("baseVersion must be a positive integer string"), { statusCode: 400, code: "INVALID_BASE_VERSION" });
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result > 2_147_483_647) {
    throw Object.assign(new Error("baseVersion is outside the persisted version range"), { statusCode: 400, code: "INVALID_BASE_VERSION" });
  }
  return result;
}
