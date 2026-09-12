import bcrypt from "bcryptjs";

export interface PasswordVerificationResult {
  readonly valid: boolean;
  readonly needsUpgrade: boolean;
}

/**
 * Hash password using bcrypt.
 */
export async function hashPassword(password: string, rounds = 10): Promise<string> {
  return bcrypt.hash(password, rounds);
}

/**
 * Verify plaintext password against a stored hash (including legacy bcrypt hashes).
 */
export async function verifyPassword(password: string, hash: string): Promise<PasswordVerificationResult> {
  if (!hash || typeof hash !== "string") {
    return { valid: false, needsUpgrade: false };
  }

  const isBcrypt = hash.startsWith("$2a$") || hash.startsWith("$2b$") || hash.startsWith("$2y$");
  if (!isBcrypt) {
    return { valid: false, needsUpgrade: false };
  }

  const valid = await bcrypt.compare(password, hash);
  if (!valid) {
    return { valid: false, needsUpgrade: false };
  }

  const roundsMatch = /^\$2[aby]\$(\d+)\$/.exec(hash);
  const rounds = roundsMatch && roundsMatch[1] ? parseInt(roundsMatch[1], 10) : 0;
  // Upgrade if rounds < 10 or using older $2a$ format
  const needsUpgrade = rounds < 10 || hash.startsWith("$2a$");

  return { valid: true, needsUpgrade };
}
