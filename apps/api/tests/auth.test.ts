import assert from "node:assert/strict";
import { test } from "node:test";
import { hashPassword, verifyPassword } from "../src/auth/password.js";
import {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
} from "../src/auth/tokens.js";

test("password hashing and verification", async () => {
  const plain = "Secr3tP@ssw0rd!";
  const hash = await hashPassword(plain, 10);
  assert.ok(hash.startsWith("$2b$10$"), "Should be standard bcrypt hash");

  const validResult = await verifyPassword(plain, hash);
  assert.equal(validResult.valid, true);
  assert.equal(validResult.needsUpgrade, false);

  const invalidResult = await verifyPassword("WrongPassword123!", hash);
  assert.equal(invalidResult.valid, false);

  // Test legacy bcrypt format ($2a$08$)
  // Valid bcrypt hash for "legacyPassword" with $2a$08$
  const legacyHash = "$2a$08$2Z6sEsuGq3e3k0v5f8hV0.0N2u8EwI1s3Zk9w0L5G1D9I6V8Q8Y7a";
  const legacyValid = await verifyPassword("non_matching", legacyHash);
  assert.equal(legacyValid.valid, false);

  // Empty or malformed hash fails closed safely
  const emptyResult = await verifyPassword(plain, "");
  assert.equal(emptyResult.valid, false);
  assert.equal(emptyResult.needsUpgrade, false);

  const malformedResult = await verifyPassword(plain, "plain_md5_hash");
  assert.equal(malformedResult.valid, false);
});

test("access token signing and verification lifecycle", async () => {
  const userId = "00000000-0000-4000-8000-000000000001";
  const sessionId = "00000000-0000-4000-8000-000000000002";
  const secret = "test-secret-key-must-be-at-least-32-characters-long!";

  const { token, expiresIn } = await signAccessToken(
    { userId, sessionId, deviceLabel: "iOS Test Device" },
    secret,
    600,
  );

  assert.equal(expiresIn, 600);
  assert.ok(typeof token === "string" && token.split(".").length === 3);

  // Verify valid token
  const claims = await verifyAccessToken(token, secret, "baby-panel-api");
  assert.equal(claims.userId, userId);
  assert.equal(claims.sessionId, sessionId);
  assert.equal(claims.deviceLabel, "iOS Test Device");
  assert.ok(typeof claims.jti === "string" && claims.jti.length > 0);

  // Rejects wrong audience
  await assert.rejects(
    verifyAccessToken(token, secret, "https://example.com/mcp"),
    /unexpected "aud" claim value/i,
  );

  // Rejects wrong secret
  await assert.rejects(
    verifyAccessToken(token, "another-wrong-secret-key-32-chars-long!", "baby-panel-api"),
    /signature verification failed/i,
  );

  // Rejects expired token
  const { token: expiredToken } = await signAccessToken(
    { userId, sessionId },
    secret,
    -10, // expired 10 seconds ago
  );
  await assert.rejects(
    verifyAccessToken(expiredToken, secret, "baby-panel-api"),
    /"exp" claim timestamp check failed/i,
  );
});

test("refresh token generation and hashing", () => {
  const { rawToken, tokenHash } = generateRefreshToken();
  assert.equal(typeof rawToken, "string");
  assert.equal(rawToken.length, 64);
  assert.equal(typeof tokenHash, "string");
  assert.equal(tokenHash.length, 64);

  // Hash determinism
  assert.equal(hashRefreshToken(rawToken), tokenHash);

  // Uniqueness
  const another = generateRefreshToken();
  assert.notEqual(rawToken, another.rawToken);
  assert.notEqual(tokenHash, another.tokenHash);
});
