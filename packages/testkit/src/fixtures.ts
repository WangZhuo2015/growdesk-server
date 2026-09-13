export interface TestTenantIdentity {
  readonly username: string;
  readonly familyId: string;
  readonly babyId: string;
}

/**
 * Build deterministic, isolated identifiers for unit fixtures. This helper
 * does not create database rows; integration setup owns creation and cleanup.
 */
export function testTenantIdentity(suffix: string): TestTenantIdentity {
  const normalized = suffix.trim().replace(/[^a-z0-9_]+/gi, "_").toLowerCase();
  if (normalized.length < 1 || normalized.length > 40) {
    throw new Error("Test fixture suffix must contain 1-40 alphanumeric characters");
  }
  return {
    username: `test_${normalized}_user`,
    familyId: `test_family_${normalized}`,
    babyId: `test_baby_${normalized}`,
  };
}
