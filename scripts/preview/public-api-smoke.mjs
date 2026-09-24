#!/usr/bin/env node
/**
 * Real HTTPS smoke for the isolated GrowDesk preview API.
 *
 * Run from the preview checkout (the env file is supplied by the host):
 *   node --env-file=/path/to/backend.env scripts/preview/public-api-smoke.mjs
 *
 * Optional host-only switches:
 *   PUBLIC_API_BASE_URL=https://ampere.zwang.fun:8443
 *   PUBLIC_API_SMOKE_PHASE=core|full (default: core)
 *   PUBLIC_API_SMOKE_S3=1 (default: skipped)
 *
 * The script deliberately emits one JSON result on stdout. Credentials,
 * access/refresh tokens, environment values, response bodies, and signed
 * object URLs stay in memory and are never logged.
 */

import { createHash, randomUUID } from "node:crypto";
import { createDatabaseContext, parseDatabaseConfig } from "@growdesk/database";

const DEFAULT_API_BASE_URL = "https://ampere.zwang.fun:8443";
const API_BASE_URL = normalizeBaseUrl(
  process.env.PUBLIC_API_BASE_URL ??
    process.env.GROWDESK_PUBLIC_API_BASE_URL ??
    DEFAULT_API_BASE_URL,
);
const requestedPhase = process.env.PUBLIC_API_SMOKE_PHASE ?? "core";
const PHASE = requestedPhase === "core" || requestedPhase === "full" ? requestedPhase : "invalid";
const ENABLE_S3 = ["1", "true", "yes"].includes(
  (process.env.PUBLIC_API_SMOKE_S3 ?? "").toLowerCase(),
);
const REQUEST_TIMEOUT_MS = 20_000;
const TEST_PASSWORD = "TestPublicApiPassword123!";
const RUN_TAG = `${Date.now()}_${randomUUID().slice(0, 8)}`;
const USERNAME_PREFIX = `test_public_api_${RUN_TAG}_`;

class SmokeFailure extends Error {
  constructor(code) {
    super(code);
    this.name = "SmokeFailure";
    this.code = code;
  }
}

function normalizeBaseUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return "";
  return value.trim().replace(/\/+$/, "");
}

function fail(code) {
  throw new SmokeFailure(code);
}

function statusList(expected) {
  return Array.isArray(expected) ? expected : [expected];
}

function requireStatus(response, expected, code) {
  if (!statusList(expected).includes(response.status)) {
    fail(`${code}_status_${response.status}`);
  }
}

function requireObject(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
}

function requireData(response, code) {
  const payload = requireObject(response.payload, `${code}_invalid_json`);
  if (!("data" in payload)) fail(`${code}_missing_data`);
  return payload.data;
}

function requireString(value, code) {
  if (typeof value !== "string" || value.length === 0) fail(code);
  return value;
}

function requireArray(value, code) {
  if (!Array.isArray(value)) fail(code);
  return value;
}

function requirePage(value, code) {
  const page = requireObject(value, code);
  if (!("nextCursor" in page)) fail(`${code}_missing_next_cursor`);
}

function failureCode(error) {
  if (error instanceof SmokeFailure) return error.code;
  if (error?.name === "AbortError") return "request_timeout";
  if (error?.name === "TypeError") return "network_error";
  if (error?.name === "DatabaseConfigError") return "database_guard_rejected";
  return "unexpected_error";
}

async function apiRequest(label, options) {
  const { method = "GET", path, token, body, headers = {} } = options;
  let url;
  try {
    url = new URL(path, `${API_BASE_URL}/`);
  } catch {
    fail(`${label}_invalid_path`);
  }

  const requestHeaders = {
    accept: "application/json",
    ...(body === undefined ? {} : { "content-type": "application/json" }),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...headers,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let payload = null;
    if (raw !== "") {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = null;
      }
    }
    return { status: response.status, payload };
  } catch (error) {
    if (error?.name === "AbortError") fail(`${label}_timeout`);
    fail(`${label}_network`);
  } finally {
    clearTimeout(timer);
  }
}

function validateCleanupDatabase(raw) {
  const target = parseDatabaseConfig(raw, "test");
  if (
    target.host !== "127.0.0.1" ||
    target.port !== 55432 ||
    target.database !== "test_growdesk_preview" ||
    target.username !== "test_preview" ||
    (target.sslmode !== null && target.sslmode !== "disable")
  ) {
    fail("cleanup_database_identity_mismatch");
  }
  return target;
}

function validateApiBaseUrl() {
  if (!API_BASE_URL) fail("invalid_api_base_url");
  let parsed;
  try {
    parsed = new URL(API_BASE_URL);
  } catch {
    fail("invalid_api_base_url");
  }
  if (!parsed.hostname || !["https:", "http:"].includes(parsed.protocol)) {
    fail("invalid_api_base_url");
  }
}

function newAccount(alias) {
  return {
    alias,
    username: `${USERNAME_PREFIX}${alias}`,
    displayName: `test_public_api_${alias}_${RUN_TAG}`,
    userId: null,
    accessToken: null,
    refreshToken: null,
    familyId: null,
    babyId: null,
    familyIds: new Set(),
  };
}

const state = {
  accounts: { a: newAccount("a"), b: newAccount("b") },
  userIds: new Set(),
  familyIds: new Set(),
  attachments: new Map(),
  feeding: null,
};

const checks = [];

async function check(name, operation) {
  try {
    await operation();
    checks.push({ name, status: "passed" });
    return true;
  } catch (error) {
    checks.push({ name, status: "failed", reason: failureCode(error) });
    return false;
  }
}

function skip(name, reason) {
  checks.push({ name, status: "skipped", reason });
}

function requireAccountToken(account, code) {
  return requireString(account.accessToken, `${code}_missing_access_token`);
}

function rememberFamily(account, family) {
  const familyObject = requireObject(family, "family_invalid");
  const id = requireString(familyObject.id, "family_missing_id");
  account.familyIds.add(id);
  state.familyIds.add(id);
  return id;
}

function rememberBaby(account, baby) {
  const babyObject = requireObject(baby, "baby_invalid");
  const id = requireString(babyObject.id, "baby_missing_id");
  account.babyId = id;
  return id;
}

async function register(account) {
  const response = await apiRequest(`register_${account.alias}`, {
    method: "POST",
    path: "/api/v1/auth/register",
    body: {
      username: account.username,
      password: TEST_PASSWORD,
      displayName: account.displayName,
      deviceLabel: `test_public_api_${account.alias}`,
    },
  });
  requireStatus(response, 201, `register_${account.alias}`);
  const data = requireObject(requireData(response, `register_${account.alias}`), "register_missing_data");
  account.userId = requireString(data.user?.id, `register_${account.alias}_missing_user`);
  account.accessToken = requireString(data.accessToken, `register_${account.alias}_missing_access`);
  account.refreshToken = requireString(data.refreshToken, `register_${account.alias}_missing_refresh`);
  state.userIds.add(account.userId);
}

async function login(account) {
  const response = await apiRequest(`login_${account.alias}`, {
    method: "POST",
    path: "/api/v1/auth/login",
    body: {
      username: account.username,
      password: TEST_PASSWORD,
      deviceLabel: `test_public_api_login_${account.alias}`,
    },
  });
  requireStatus(response, 200, `login_${account.alias}`);
  const data = requireObject(requireData(response, `login_${account.alias}`), "login_missing_data");
  if (data.user?.id !== account.userId) fail(`login_${account.alias}_wrong_user`);
  account.accessToken = requireString(data.accessToken, `login_${account.alias}_missing_access`);
  account.refreshToken = requireString(data.refreshToken, `login_${account.alias}_missing_refresh`);
}

async function refresh(account) {
  const priorRefreshToken = requireString(account.refreshToken, `refresh_${account.alias}_missing_input`);
  const rotationId = randomUUID();
  const response = await apiRequest(`refresh_${account.alias}`, {
    method: "POST",
    path: "/api/v1/auth/refresh",
    body: { refreshToken: priorRefreshToken, rotationId },
  });
  requireStatus(response, 200, `refresh_${account.alias}`);
  const data = requireObject(requireData(response, `refresh_${account.alias}`), "refresh_missing_data");
  if (data.rotationId !== rotationId) fail(`refresh_${account.alias}_wrong_rotation`);
  account.accessToken = requireString(data.accessToken, `refresh_${account.alias}_missing_access`);
  account.refreshToken = requireString(data.refreshToken, `refresh_${account.alias}_missing_refresh`);
}

async function createFamily(account) {
  const response = await apiRequest(`create_family_${account.alias}`, {
    method: "POST",
    path: "/api/v1/families",
    token: requireAccountToken(account, `create_family_${account.alias}`),
    body: {
      name: `test_public_api_family_${account.alias}_${RUN_TAG}`,
      timeZone: "Asia/Shanghai",
    },
  });
  requireStatus(response, 201, `create_family_${account.alias}`);
  return rememberFamily(account, requireData(response, `create_family_${account.alias}`));
}

async function listFamilies(account) {
  const response = await apiRequest(`list_families_${account.alias}`, {
    path: "/api/v1/families",
    token: requireAccountToken(account, `list_families_${account.alias}`),
  });
  requireStatus(response, 200, `list_families_${account.alias}`);
  const families = requireArray(requireData(response, `list_families_${account.alias}`), `families_${account.alias}_not_array`);
  for (const family of families) rememberFamily(account, family);
  if (families.length === 0) fail(`list_families_${account.alias}_empty`);
  return families;
}

async function createBaby(account) {
  const familyId = requireString(account.familyId, `create_baby_${account.alias}_missing_family`);
  const response = await apiRequest(`create_baby_${account.alias}`, {
    method: "POST",
    path: `/api/v1/families/${familyId}/babies`,
    token: requireAccountToken(account, `create_baby_${account.alias}`),
    body: {
      name: `test_public_api_baby_${account.alias}_${RUN_TAG}`,
      birthDate: "2025-01-01",
      gender: account.alias === "a" ? "girl" : "boy",
    },
  });
  requireStatus(response, 201, `create_baby_${account.alias}`);
  const baby = requireData(response, `create_baby_${account.alias}`);
  const babyId = rememberBaby(account, baby);
  const familyInResponse = requireObject(baby, "baby_invalid").familyId;
  if (familyInResponse !== familyId) fail(`create_baby_${account.alias}_wrong_family`);
  return babyId;
}

async function listFamilyBabies(account) {
  const familyId = requireString(account.familyId, `list_babies_${account.alias}_missing_family`);
  const response = await apiRequest(`list_babies_${account.alias}`, {
    path: `/api/v1/families/${familyId}/babies`,
    token: requireAccountToken(account, `list_babies_${account.alias}`),
  });
  requireStatus(response, 200, `list_babies_${account.alias}`);
  const babies = requireArray(requireData(response, `list_babies_${account.alias}`), `babies_${account.alias}_not_array`);
  if (!babies.some((baby) => baby?.id === account.babyId)) fail(`list_babies_${account.alias}_missing_created_baby`);
}

async function getBaby(account) {
  const babyId = requireString(account.babyId, `get_baby_${account.alias}_missing_baby`);
  const response = await apiRequest(`get_baby_${account.alias}`, {
    path: `/api/v1/babies/${babyId}`,
    token: requireAccountToken(account, `get_baby_${account.alias}`),
  });
  requireStatus(response, 200, `get_baby_${account.alias}`);
  const baby = requireObject(requireData(response, `get_baby_${account.alias}`), "get_baby_invalid_data");
  if (baby.id !== babyId || baby.familyId !== account.familyId) fail(`get_baby_${account.alias}_wrong_scope`);
}

const listDescriptors = [
  { key: "feeding", suffix: "records/feeding", paginated: true },
  { key: "sleep", suffix: "records/sleep", paginated: true },
  { key: "diaper", suffix: "records/diaper", paginated: true },
  { key: "food", suffix: "records/food", paginated: true },
  { key: "supplement", suffix: "records/supplement", paginated: true },
  { key: "growth", suffix: "growth-measurements", paginated: true },
  { key: "medical", suffix: "medical-reports", paginated: true },
  { key: "vaccine", suffix: "vaccines/records", paginated: false },
];

async function listRecord(account, descriptor) {
  const babyId = requireString(account.babyId, `list_${descriptor.key}_missing_baby`);
  const query = descriptor.paginated ? "?limit=5" : "";
  const response = await apiRequest(`list_${descriptor.key}_${account.alias}`, {
    path: `/api/v1/babies/${babyId}/${descriptor.suffix}${query}`,
    token: requireAccountToken(account, `list_${descriptor.key}_${account.alias}`),
  });
  requireStatus(response, 200, `list_${descriptor.key}_${account.alias}`);
  const payload = requireObject(response.payload, `list_${descriptor.key}_invalid_json`);
  requireArray(payload.data, `list_${descriptor.key}_data_not_array`);
  if (descriptor.paginated) requirePage(payload.page, `list_${descriptor.key}_page_invalid`);
}

async function crossScopeSetup(accountA, accountB) {
  const familyId = requireString(accountA.familyId, "cross_scope_missing_family");
  const babyId = requireString(accountA.babyId, "cross_scope_missing_baby");
  const foreignFamily = await apiRequest("cross_scope_family_read", {
    path: `/api/v1/families/${familyId}`,
    token: requireAccountToken(accountB, "cross_scope_family_read"),
  });
  requireStatus(foreignFamily, [403, 404], "cross_scope_family_read_rejected");
  const foreignBaby = await apiRequest("cross_scope_baby_read", {
    path: `/api/v1/babies/${babyId}`,
    token: requireAccountToken(accountB, "cross_scope_baby_read"),
  });
  requireStatus(foreignBaby, [403, 404], "cross_scope_baby_read_rejected");
}

async function createFeeding(account) {
  const babyId = requireString(account.babyId, "feeding_create_missing_baby");
  const idempotencyKey = randomUUID();
  const response = await apiRequest("feeding_create", {
    method: "POST",
    path: `/api/v1/babies/${babyId}/records/feeding`,
    token: requireAccountToken(account, "feeding_create"),
    headers: { "idempotency-key": idempotencyKey },
    body: {
      feedingType: "formula",
      occurredAt: "2026-09-16T08:00:00.000Z",
      amountMl: "120.00",
      spitUp: false,
      notes: `test_public_api_feeding_${RUN_TAG}`,
    },
  });
  requireStatus(response, 201, "feeding_create");
  const data = requireObject(requireData(response, "feeding_create"), "feeding_create_invalid_data");
  state.feeding = {
    id: requireString(data.id, "feeding_create_missing_id"),
    version: requireString(data.version, "feeding_create_missing_version"),
    babyId,
  };
}

async function getFeeding(account) {
  const feeding = requireObject(state.feeding, "feeding_get_missing_create");
  const response = await apiRequest("feeding_get", {
    path: `/api/v1/babies/${feeding.babyId}/records/feeding/${feeding.id}`,
    token: requireAccountToken(account, "feeding_get"),
  });
  requireStatus(response, 200, "feeding_get");
  const data = requireObject(requireData(response, "feeding_get"), "feeding_get_invalid_data");
  if (data.id !== feeding.id || data.babyId !== feeding.babyId) fail("feeding_get_wrong_scope");
}

async function updateFeeding(account) {
  const feeding = requireObject(state.feeding, "feeding_update_missing_create");
  const response = await apiRequest("feeding_update", {
    method: "PATCH",
    path: `/api/v1/babies/${feeding.babyId}/records/feeding/${feeding.id}`,
    token: requireAccountToken(account, "feeding_update"),
    headers: { "idempotency-key": randomUUID() },
    body: {
      baseVersion: feeding.version,
      amountMl: "130.00",
      notes: `test_public_api_feeding_updated_${RUN_TAG}`,
    },
  });
  requireStatus(response, 200, "feeding_update");
  const data = requireObject(requireData(response, "feeding_update"), "feeding_update_invalid_data");
  const version = requireString(data.version, "feeding_update_missing_version");
  if (data.id !== feeding.id || version === feeding.version) fail("feeding_update_not_versioned");
  feeding.version = version;
}

async function deleteFeeding(account) {
  const feeding = requireObject(state.feeding, "feeding_delete_missing_create");
  const response = await apiRequest("feeding_delete", {
    method: "DELETE",
    path: `/api/v1/babies/${feeding.babyId}/records/feeding/${feeding.id}?baseVersion=${encodeURIComponent(feeding.version)}`,
    token: requireAccountToken(account, "feeding_delete"),
    headers: { "idempotency-key": randomUUID() },
  });
  requireStatus(response, 200, "feeding_delete");
  const data = requireObject(requireData(response, "feeding_delete"), "feeding_delete_invalid_data");
  if (data.id !== feeding.id || data.deleted !== true) fail("feeding_delete_not_deleted");
}

async function verifyDeletedFeeding(account) {
  const feeding = requireObject(state.feeding, "feeding_verify_delete_missing_create");
  const response = await apiRequest("feeding_get_deleted", {
    path: `/api/v1/babies/${feeding.babyId}/records/feeding/${feeding.id}`,
    token: requireAccountToken(account, "feeding_get_deleted"),
  });
  requireStatus(response, 404, "feeding_get_deleted");
}

async function crossScopeFeedingWrite(accountA, accountB) {
  const babyId = requireString(accountA.babyId, "cross_scope_feeding_missing_baby");
  const response = await apiRequest("cross_scope_feeding_write", {
    method: "POST",
    path: `/api/v1/babies/${babyId}/records/feeding`,
    token: requireAccountToken(accountB, "cross_scope_feeding_write"),
    headers: { "idempotency-key": randomUUID() },
    body: {
      feedingType: "formula",
      occurredAt: "2026-09-16T09:00:00.000Z",
      amountMl: "1.00",
      spitUp: false,
    },
  });
  requireStatus(response, [403, 404], "cross_scope_feeding_write_rejected");
}

const fullRecordDescriptors = [
  {
    key: "sleep",
    suffix: "records/sleep",
    create: { sleepType: "nap", startedAt: "2026-09-16T10:00:00.000Z", notes: `test_public_api_sleep_${RUN_TAG}` },
    update: (version) => ({ baseVersion: version, nightWakingCount: 1 }),
  },
  {
    key: "diaper",
    suffix: "records/diaper",
    create: { diaperType: "pee", occurredAt: "2026-09-16T11:00:00.000Z", notes: `test_public_api_diaper_${RUN_TAG}` },
    update: (version) => ({ baseVersion: version, poopColor: null }),
  },
  {
    key: "food",
    suffix: "records/food",
    create: { recordDate: "2026-09-16", mealType: "lunch", foodItemIds: [], portionDescription: "test 30g puree" },
    update: (version) => ({ baseVersion: version, portionDescription: "test 40g puree" }),
  },
  {
    key: "supplement",
    suffix: "records/supplement",
    create: { supplementName: `test_public_api_vitamin_${RUN_TAG}`, occurredAt: "2026-09-16T14:00:00.000Z", amount: "400 IU" },
    update: (version) => ({ baseVersion: version, amount: "450 IU" }),
  },
  {
    key: "growth",
    suffix: "growth-measurements",
    create: { measurementDate: "2026-09-16", weightKg: "7.80", heightCm: "68.5" },
    update: (version) => ({ baseVersion: version, weightKg: "7.90" }),
  },
  {
    key: "medical",
    suffix: "medical-reports",
    create: { reportDate: "2026-09-16", title: `test_public_api_report_${RUN_TAG}`, notes: "test report" },
    update: (version) => ({ baseVersion: version, title: `test_public_api_report_updated_${RUN_TAG}` }),
  },
  {
    key: "vaccine",
    suffix: "vaccines/records",
    create: { vaccineCode: "HepB", administeredDate: "2026-09-16", clinic: "test clinic", batchNumber: "test batch" },
    noGet: "contract_has_no_individual_get",
    noUpdate: "contract_has_no_update_route",
  },
];

async function fullRecordCrud(account, descriptor) {
  const babyId = requireString(account.babyId, `full_${descriptor.key}_missing_baby`);
  const idempotencyKey = randomUUID();
  const createResponse = await apiRequest(`full_${descriptor.key}_create`, {
    method: "POST",
    path: `/api/v1/babies/${babyId}/${descriptor.suffix}`,
    token: requireAccountToken(account, `full_${descriptor.key}_create`),
    headers: { "idempotency-key": idempotencyKey },
    body: descriptor.create,
  });
  requireStatus(createResponse, 201, `full_${descriptor.key}_create`);
  const created = requireObject(requireData(createResponse, `full_${descriptor.key}_create`), `full_${descriptor.key}_create_invalid_data`);
  const id = requireString(created.id, `full_${descriptor.key}_create_missing_id`);
  let version = requireString(created.version, `full_${descriptor.key}_create_missing_version`);

  if (descriptor.noGet) {
    skip(`full_${descriptor.key}_get`, descriptor.noGet);
  } else {
    const getResponse = await apiRequest(`full_${descriptor.key}_get`, {
      path: `/api/v1/babies/${babyId}/${descriptor.suffix}/${id}`,
      token: requireAccountToken(account, `full_${descriptor.key}_get`),
    });
    requireStatus(getResponse, 200, `full_${descriptor.key}_get`);
    const got = requireObject(requireData(getResponse, `full_${descriptor.key}_get`), `full_${descriptor.key}_get_invalid_data`);
    if (got.id !== id || got.babyId !== babyId) fail(`full_${descriptor.key}_get_wrong_scope`);
  }

  if (descriptor.noUpdate) {
    skip(`full_${descriptor.key}_update`, descriptor.noUpdate);
  } else {
    const updateMethod = descriptor.key === "medical" ? "PUT" : "PATCH";
    const updateResponse = await apiRequest(`full_${descriptor.key}_update`, {
      method: updateMethod,
      path: `/api/v1/babies/${babyId}/${descriptor.suffix}/${id}`,
      token: requireAccountToken(account, `full_${descriptor.key}_update`),
      headers: { "idempotency-key": randomUUID() },
      body: descriptor.update(version),
    });
    requireStatus(updateResponse, 200, `full_${descriptor.key}_update`);
    const updated = requireObject(requireData(updateResponse, `full_${descriptor.key}_update`), `full_${descriptor.key}_update_invalid_data`);
    const nextVersion = requireString(updated.version, `full_${descriptor.key}_update_missing_version`);
    if (updated.id !== id || nextVersion === version) fail(`full_${descriptor.key}_update_not_versioned`);
    version = nextVersion;
  }

  const deletePath = descriptor.key === "vaccine"
    ? `/api/v1/babies/${babyId}/${descriptor.suffix}/${id}`
    : `/api/v1/babies/${babyId}/${descriptor.suffix}/${id}?baseVersion=${encodeURIComponent(version)}`;
  const deleteResponse = await apiRequest(`full_${descriptor.key}_delete`, {
    method: "DELETE",
    path: deletePath,
    token: requireAccountToken(account, `full_${descriptor.key}_delete`),
    headers: { "idempotency-key": randomUUID() },
  });
  requireStatus(deleteResponse, 200, `full_${descriptor.key}_delete`);
  const deleted = requireObject(requireData(deleteResponse, `full_${descriptor.key}_delete`), `full_${descriptor.key}_delete_invalid_data`);
  if (deleted.id !== id || deleted.deleted !== true) fail(`full_${descriptor.key}_delete_not_deleted`);

  if (!descriptor.noGet) {
    const afterDelete = await apiRequest(`full_${descriptor.key}_get_deleted`, {
      path: `/api/v1/babies/${babyId}/${descriptor.suffix}/${id}`,
      token: requireAccountToken(account, `full_${descriptor.key}_get_deleted`),
    });
    requireStatus(afterDelete, 404, `full_${descriptor.key}_get_deleted`);
  }
}

async function runOptionalS3(account) {
  const familyId = requireString(account.familyId, "s3_missing_family");
  const babyId = requireString(account.babyId, "s3_missing_baby");
  const bytes = Buffer.from("test_public_api_attachment_payload", "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const createResponse = await apiRequest("s3_create", {
    method: "POST",
    path: "/api/v1/attachments",
    token: requireAccountToken(account, "s3_create"),
    body: {
      purpose: "medical_report",
      mimeType: "image/png",
      byteSize: bytes.byteLength,
      sha256,
      ownerScope: { familyId, babyId },
    },
  });
  requireStatus(createResponse, 201, "s3_create");
  const attachment = requireObject(requireData(createResponse, "s3_create"), "s3_create_invalid_data");
  const attachmentId = requireString(attachment.id, "s3_create_missing_id");
  const uploadUrl = requireString(attachment.uploadUrl, "s3_create_missing_upload_url");
  state.attachments.set(attachmentId, { account, id: attachmentId });

  let uploadResponse;
  try {
    uploadResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: bytes,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") fail("s3_upload_timeout");
    fail("s3_upload_network");
  }
  if (!uploadResponse.ok) fail(`s3_upload_status_${uploadResponse.status}`);

  const completeResponse = await apiRequest("s3_complete", {
    method: "POST",
    path: `/api/v1/attachments/${attachmentId}/complete`,
    token: requireAccountToken(account, "s3_complete"),
    body: { sha256, byteSize: bytes.byteLength },
  });
  requireStatus(completeResponse, 200, "s3_complete");
  const completeData = requireObject(requireData(completeResponse, "s3_complete"), "s3_complete_invalid_data");
  if (completeData.success !== true) fail("s3_complete_not_ready");
}

async function cleanupRemoteAttachments() {
  const failures = [];
  for (const attachment of state.attachments.values()) {
    try {
      const response = await apiRequest("cleanup_attachment", {
        method: "DELETE",
        path: `/api/v1/attachments/${attachment.id}`,
        token: requireAccountToken(attachment.account, "cleanup_attachment"),
      });
      if (![200, 404].includes(response.status)) failures.push(`attachment_status_${response.status}`);
    } catch (error) {
      failures.push(failureCode(error));
    }
  }
  return failures;
}

async function cleanupDatabase() {
  const target = validateCleanupDatabase(process.env.DATABASE_URL);
  const db = createDatabaseContext({ url: target.url });
  let familyIds = [...state.familyIds];
  const userIds = [...state.userIds];
  try {
    // If a registration succeeded but the family list failed, discover only
    // families linked to these exact test user IDs before deleting by ID.
    if (userIds.length > 0) {
      const linkedFamilies = await db.prisma.family.findMany({
        where: { members: { some: { userId: { in: userIds } } } },
        select: { id: true },
      });
      familyIds = [...new Set([...familyIds, ...linkedFamilies.map((family) => family.id)])];
    }

    let deletedFamilies = 0;
    if (familyIds.length > 0) {
      const deleted = await db.prisma.family.deleteMany({ where: { id: { in: familyIds } } });
      deletedFamilies = deleted.count;
    }

    let deletedUsers = 0;
    if (userIds.length > 0) {
      const deleted = await db.prisma.user.deleteMany({
        where: {
          id: { in: userIds },
          username: { startsWith: USERNAME_PREFIX },
        },
      });
      deletedUsers = deleted.count;
    }

    const remainingFamilies = familyIds.length === 0
      ? 0
      : (await db.prisma.family.count({ where: { id: { in: familyIds } } }));
    const remainingUsers = userIds.length === 0
      ? 0
      : (await db.prisma.user.count({
          where: { id: { in: userIds }, username: { startsWith: USERNAME_PREFIX } },
        }));
    if (remainingFamilies !== 0 || remainingUsers !== 0) fail("cleanup_rows_remain");
    return { status: "passed", deletedFamilies, deletedUsers };
  } finally {
    await db.close();
  }
}

async function main() {
  const result = { ok: false, phase: PHASE, checks, cleanup: null };
  let fatal = null;
  try {
    if (!(await check("api_base_guard", async () => validateApiBaseUrl()))) {
      throw new SmokeFailure("api_base_guard_failed");
    }
    if (PHASE === "invalid") {
      checks.push({ name: "phase_guard", status: "failed", reason: "invalid_smoke_phase" });
      throw new SmokeFailure("invalid_smoke_phase");
    }
    checks.push({ name: "phase_guard", status: "passed" });

    // Guard before any remote write so a missing/misrouted cleanup database
    // cannot leave a newly-created preview tenant behind.
    await check("cleanup_database_guard", async () => {
      validateCleanupDatabase(process.env.DATABASE_URL);
    });
    if (checks.at(-1)?.status !== "passed") throw new SmokeFailure("cleanup_database_guard_failed");

    if (!(await check("health_live", async () => {
      const response = await apiRequest("health_live", { path: "/health/live" });
      requireStatus(response, 200, "health_live");
      const data = requireObject(response.payload, "health_live_invalid_json");
      if (data.status !== "ok") fail("health_live_not_ok");
    }))) throw new SmokeFailure("health_live_failed");

    if (!(await check("health_ready", async () => {
      const response = await apiRequest("health_ready", { path: "/health/ready" });
      requireStatus(response, 200, "health_ready");
      const data = requireObject(response.payload, "health_ready_invalid_json");
      if (data.status !== "ok" || data.dependencies?.postgres !== "ok" || data.dependencies?.redis !== "ok") {
        fail("health_ready_not_ok");
      }
    }))) throw new SmokeFailure("health_ready_failed");

    if (!(await check("register_account_a", () => register(state.accounts.a)))) throw new SmokeFailure("register_account_a_failed");
    if (!(await check("login_account_a", () => login(state.accounts.a)))) throw new SmokeFailure("login_account_a_failed");
    if (!(await check("refresh_account_a", () => refresh(state.accounts.a)))) throw new SmokeFailure("refresh_account_a_failed");

    await check("me_after_refresh", async () => {
      const response = await apiRequest("me_after_refresh", {
        path: "/api/v1/me",
        token: requireAccountToken(state.accounts.a, "me_after_refresh"),
      });
      requireStatus(response, 200, "me_after_refresh");
      const data = requireObject(requireData(response, "me_after_refresh"), "me_after_refresh_invalid_data");
      if (data.id !== state.accounts.a.userId) fail("me_after_refresh_wrong_user");
    });

    if (!(await check("list_families_a", async () => {
      const families = await listFamilies(state.accounts.a);
      state.accounts.a.familyId = families[0].id;
    }))) throw new SmokeFailure("list_families_a_failed");
    await check("create_family_a", async () => {
      state.accounts.a.familyId = await createFamily(state.accounts.a);
    });
    if (!(await check("create_baby_a", () => createBaby(state.accounts.a)))) throw new SmokeFailure("create_baby_a_failed");
    await check("list_family_babies_a", () => listFamilyBabies(state.accounts.a));
    await check("get_baby_a", () => getBaby(state.accounts.a));

    if (!(await check("register_account_b", () => register(state.accounts.b)))) throw new SmokeFailure("register_account_b_failed");
    if (!(await check("list_families_b", async () => {
      const families = await listFamilies(state.accounts.b);
      state.accounts.b.familyId = families[0].id;
    }))) throw new SmokeFailure("list_families_b_failed");
    await check("create_family_b", async () => {
      state.accounts.b.familyId = await createFamily(state.accounts.b);
    });
    if (!(await check("create_baby_b", () => createBaby(state.accounts.b)))) throw new SmokeFailure("create_baby_b_failed");
    await check("list_family_babies_b", () => listFamilyBabies(state.accounts.b));
    await check("get_baby_b", () => getBaby(state.accounts.b));

    await check("cross_scope_family_and_baby", () => crossScopeSetup(state.accounts.a, state.accounts.b));
    for (const descriptor of listDescriptors) {
      await check(`list_${descriptor.key}_a`, () => listRecord(state.accounts.a, descriptor));
    }

    if (!(await check("feeding_create", () => createFeeding(state.accounts.a)))) {
      skip("feeding_get", "feeding_create_failed");
      skip("feeding_update", "feeding_create_failed");
      skip("feeding_delete", "feeding_create_failed");
      skip("feeding_get_deleted", "feeding_create_failed");
    } else {
      await check("feeding_get", () => getFeeding(state.accounts.a));
      await check("cross_scope_feeding_write", () => crossScopeFeedingWrite(state.accounts.a, state.accounts.b));
      if (await check("feeding_update", () => updateFeeding(state.accounts.a))) {
        await check("feeding_delete", () => deleteFeeding(state.accounts.a));
        await check("feeding_get_deleted", () => verifyDeletedFeeding(state.accounts.a));
      } else {
        skip("feeding_delete", "feeding_update_failed");
        skip("feeding_get_deleted", "feeding_update_failed");
      }
    }

    if (PHASE === "full") {
      for (const descriptor of fullRecordDescriptors) {
        const name = `full_${descriptor.key}_crud`;
        await check(name, () => fullRecordCrud(state.accounts.a, descriptor));
      }
    } else {
      skip("full_record_crud", "phase_core_set_PUBLIC_API_SMOKE_PHASE=full_to_enable");
    }

    if (ENABLE_S3) {
      await check("s3_attachment", () => runOptionalS3(state.accounts.a));
    } else {
      skip("s3_attachment", "disabled_by_default_set_PUBLIC_API_SMOKE_S3=1_to_enable");
    }
  } catch (error) {
    fatal = failureCode(error);
  } finally {
    const remoteAttachmentFailures = await cleanupRemoteAttachments();
    try {
      result.cleanup = await cleanupDatabase();
      if (remoteAttachmentFailures.length > 0 && result.cleanup.status === "passed") {
        result.cleanup = { status: "failed", reason: "remote_attachment_cleanup_failed" };
      }
    } catch (error) {
      result.cleanup = { status: "failed", reason: failureCode(error) };
    }
  }

  if (fatal) result.fatal = fatal;
  const checksOk = checks.every((checkResult) => checkResult.status !== "failed");
  result.ok = !fatal && checksOk && result.cleanup?.status === "passed";
  return result;
}

try {
  const result = await main();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  // Keep stdout machine-readable even for an import/initialization failure.
  process.stdout.write(`${JSON.stringify({ ok: false, phase: PHASE, checks, cleanup: { status: "failed", reason: failureCode(error) } })}\n`);
  process.exitCode = 1;
}
