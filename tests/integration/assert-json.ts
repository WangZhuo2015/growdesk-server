import assert from "node:assert/strict";

export function readObject(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "Expected a JSON object");
  return value as Record<string, unknown>;
}
export function readRows(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value), "Expected a JSON array");
  return value.map((item: unknown) => readObject(item));
}
export function readString(value: unknown): string {
  assert.equal(typeof value, "string", "Expected a JSON string");
  return value as string;
}
export function valueAt(value: unknown, ...keys: Array<string | number>): unknown {
  let current = value;
  for (const key of keys) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}
export function hasHttpStatus(error: unknown, status: number): boolean {
  return valueAt(error, "$metadata", "httpStatusCode") === status;
}
