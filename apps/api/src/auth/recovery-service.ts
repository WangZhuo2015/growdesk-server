import type pg from "pg";
import crypto from "node:crypto";
import { hashPassword, verifyPassword } from "./password.js";

export interface GenerateRecoveryCodesResult {
  readonly codes: string[];
  readonly codeHashes: string[];
}

export function formatRecoveryCode(hex32: string): string {
  const matches = hex32.match(/.{1,4}/g);
  return matches ? matches.join("-") : hex32;
}

export function normalizeRecoveryCode(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-f0-9]/g, "");
}

export function hashRecoveryCode(normalizedCode: string): string {
  return crypto.createHash("sha256").update(normalizedCode).digest("hex");
}

export function generateRecoveryCodes(): GenerateRecoveryCodesResult {
  const codes: string[] = [];
  const codeHashes: string[] = [];
  for (let i = 0; i < 10; i++) {
    const rawHex = crypto.randomBytes(16).toString("hex");
    const formatted = formatRecoveryCode(rawHex);
    codes.push(formatted);
    codeHashes.push(hashRecoveryCode(rawHex));
  }
  return { codes, codeHashes };
}

export interface RegenerateRecoveryCodesTxResult {
  readonly codes: string[];
  readonly batchId: string;
}

/**
 * Regenerate single-use recovery code batch under strict lock hierarchy:
 * UserSyncState -> RecoveryCode.
 * Atomically revokes any existing active recovery codes for the user.
 */
export async function regenerateRecoveryCodesTx(
  pool: pg.Pool,
  userId: string,
): Promise<RegenerateRecoveryCodesTxResult> {
  const { codes, codeHashes } = generateRecoveryCodes();
  const batchId = crypto.randomUUID();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Strict lock hierarchy: UserSyncState(userId)
    await client.query(
      "SELECT cursor FROM user_sync_states WHERE user_id = $1 FOR UPDATE",
      [userId],
    );

    // 2. Revoke any existing active/unused recovery codes for this user
    await client.query(
      `UPDATE recovery_codes
       SET revoked_at = NOW()
       WHERE user_id = $1 AND revoked_at IS NULL AND used_at IS NULL`,
      [userId],
    );

    // 3. Insert 10 new recovery codes
    for (const codeHash of codeHashes) {
      await client.query(
        `INSERT INTO recovery_codes (code_hash, user_id, batch_id, created_at)
         VALUES ($1, $2, $3, NOW())`,
        [codeHash, userId, batchId],
      );
    }

    // 4. Increment UserSyncState cursor
    await client.query(
      `UPDATE user_sync_states
       SET cursor = cursor + 1, updated_at = NOW()
       WHERE user_id = $1`,
      [userId],
    );

    await client.query("COMMIT");
    return { codes, batchId };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export interface RecoverPasswordParams {
  readonly pool: pg.Pool;
  readonly username: string;
  readonly recoveryCode: string;
  readonly newPassword: string;
}

export interface RecoverPasswordResult {
  readonly success: boolean;
  readonly statusCode: 200 | 400 | 401;
  readonly code?: string;
  readonly message?: string;
}

/**
 * Recover password with single-use recovery code.
 * Strict lock hierarchy: UserSyncState(userId) -> RecoveryCode.
 * Atomically marks code used, revokes user's batch, updates password,
 * and revokes all active DeviceSessions and RefreshCredentials.
 */
export async function recoverPasswordTx(params: RecoverPasswordParams): Promise<RecoverPasswordResult> {
  const { pool, username, recoveryCode, newPassword } = params;
  const normalized = normalizeRecoveryCode(recoveryCode);

  if (normalized.length !== 32) {
    return {
      success: false,
      statusCode: 401,
      code: "INVALID_RECOVERY_CODE",
      message: "Invalid username or recovery code",
    };
  }

  const codeHash = hashRecoveryCode(normalized);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Locate user
    const userRes = await client.query(
      "SELECT id, password_hash, password_hash_version, deleted_at FROM users WHERE username = $1",
      [username],
    );
    if (userRes.rows.length === 0 || userRes.rows[0].deleted_at !== null) {
      await client.query("ROLLBACK");
      return {
        success: false,
        statusCode: 401,
        code: "INVALID_RECOVERY_CODE",
        message: "Invalid username or recovery code",
      };
    }
    const user = userRes.rows[0];

    // 2. Lock UserSyncState (Global Lock Ordering Rule #1)
    await client.query(
      "SELECT cursor FROM user_sync_states WHERE user_id = $1 FOR UPDATE",
      [user.id],
    );

    // 3. Lock RecoveryCode row (Global Lock Ordering Rule #3)
    const codeRes = await client.query(
      `SELECT code_hash, batch_id, used_at, revoked_at
       FROM recovery_codes
       WHERE code_hash = $1 AND user_id = $2
       FOR UPDATE`,
      [codeHash, user.id],
    );

    if (codeRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return {
        success: false,
        statusCode: 401,
        code: "INVALID_RECOVERY_CODE",
        message: "Invalid username or recovery code",
      };
    }

    const recRow = codeRes.rows[0];
    if (recRow.used_at !== null || recRow.revoked_at !== null) {
      await client.query("ROLLBACK");
      return {
        success: false,
        statusCode: 401,
        code: "INVALID_RECOVERY_CODE",
        message: "Invalid username or recovery code",
      };
    }

    // 4. Mark code as used
    await client.query(
      "UPDATE recovery_codes SET used_at = NOW() WHERE code_hash = $1",
      [codeHash],
    );

    // 5. Revoke entire batch for this user
    await client.query(
      `UPDATE recovery_codes
       SET revoked_at = NOW()
       WHERE user_id = $1 AND batch_id = $2 AND used_at IS NULL`,
      [user.id, recRow.batch_id],
    );

    // 6. Hash new password and update user
    const newPasswordHash = await hashPassword(newPassword, 12);
    await client.query(
      `UPDATE users
       SET password_hash = $1,
           password_hash_version = password_hash_version + 1,
           password_hash_needs_rehash = false,
           updated_at = NOW()
       WHERE id = $2`,
      [newPasswordHash, user.id],
    );

    // 7. Revoke ALL device sessions and refresh credentials for this user
    await client.query(
      "UPDATE device_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL",
      [user.id],
    );
    await client.query(
      "UPDATE refresh_credentials SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL",
      [user.id],
    );

    // 8. Increment UserSyncState cursor
    await client.query(
      "UPDATE user_sync_states SET cursor = cursor + 1, updated_at = NOW() WHERE user_id = $1",
      [user.id],
    );

    await client.query("COMMIT");
    return {
      success: true,
      statusCode: 200,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export interface ChangePasswordParams {
  readonly pool: pg.Pool;
  readonly userId: string;
  readonly sessionId: string;
  readonly oldPassword: string;
  readonly newPassword: string;
}

export interface ChangePasswordResult {
  readonly success: boolean;
  readonly statusCode: 200 | 400 | 401;
  readonly code?: string;
  readonly message?: string;
}

/**
 * Change password with current password verification.
 * Under UserSyncState row lock:
 * 1. Verifies current password (supports legacy hash transparent upgrade)
 * 2. Updates password hash with cost 12
 * 3. Revokes all OTHER active sessions and credentials for the user
 * 4. Increments UserSyncState cursor
 */
export async function changePasswordTx(params: ChangePasswordParams): Promise<ChangePasswordResult> {
  const { pool, userId, sessionId, oldPassword, newPassword } = params;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Fetch user
    const userRes = await client.query(
      "SELECT id, password_hash, password_hash_version, deleted_at FROM users WHERE id = $1",
      [userId],
    );
    if (userRes.rows.length === 0 || userRes.rows[0].deleted_at !== null) {
      await client.query("ROLLBACK");
      return {
        success: false,
        statusCode: 401,
        code: "USER_NOT_FOUND",
        message: "User account not found",
      };
    }
    const user = userRes.rows[0];

    // 2. Verify current password
    const verification = await verifyPassword(oldPassword, user.password_hash);
    if (!verification.valid) {
      await client.query("ROLLBACK");
      return {
        success: false,
        statusCode: 401,
        code: "INVALID_CREDENTIALS",
        message: "Current password does not match",
      };
    }

    // 3. Lock UserSyncState (Global Lock Ordering Rule #1)
    await client.query(
      "SELECT cursor FROM user_sync_states WHERE user_id = $1 FOR UPDATE",
      [userId],
    );

    // 4. Hash new password
    const newPasswordHash = await hashPassword(newPassword, 12);
    await client.query(
      `UPDATE users
       SET password_hash = $1,
           password_hash_version = password_hash_version + 1,
           password_hash_needs_rehash = false,
           updated_at = NOW()
       WHERE id = $2`,
      [newPasswordHash, userId],
    );

    // 5. Revoke OTHER sessions and credentials (preserve current active session)
    await client.query(
      "UPDATE device_sessions SET revoked_at = NOW() WHERE user_id = $1 AND id != $2 AND revoked_at IS NULL",
      [userId, sessionId],
    );
    await client.query(
      "UPDATE refresh_credentials SET revoked_at = NOW() WHERE user_id = $1 AND session_id != $2 AND revoked_at IS NULL",
      [userId, sessionId],
    );

    // 6. Increment UserSyncState cursor
    await client.query(
      "UPDATE user_sync_states SET cursor = cursor + 1, updated_at = NOW() WHERE user_id = $1",
      [userId],
    );

    await client.query("COMMIT");
    return {
      success: true,
      statusCode: 200,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
