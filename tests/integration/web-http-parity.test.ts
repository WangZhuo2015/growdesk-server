/**
 * Run only from scripts/test-integration.py --web-root <old Web repository>.
 *
 * This is deliberately a real two-listener test: the API is a Fastify TCP
 * listener and the old Web is its built Next standalone server. The browser
 * side is represented by fetch plus an explicit cookie jar so this exercises
 * the BFF session, origin checks, legacy payload adapters and PostgreSQL.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import net, { type AddressInfo } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { buildApiApp } from "../../apps/api/src/app.js";
import { createDatabaseContext } from "../../packages/database/src/client.js";
import { type DeleteObjectsCommandOutput, S3Client, CreateBucketCommand, ListObjectsV2Command, DeleteObjectsCommand, DeleteBucketCommand } from "@aws-sdk/client-s3";
import { AwsS3StorageDriver } from "../../apps/api/src/storage/s3-storage-service.js";
import { requireTestObjectStorage, type TestObjectStorageIdentity, requireTestDatabaseUrl } from "../../packages/testkit/src/environment.js";
import { goldenClockArgs } from "./golden-clock.js";

interface OwnedRun {
  directory: string;
  database: string;
  user: string;
  password: string;
  pgPort: number;
  redisPort: number;
  token: string;
  s3?: TestObjectStorageIdentity;
}

interface HttpResult {
  status: number;
  body: any;
  headers: Headers;
}

interface HttpOptions {
  method?: string;
  cookie?: string;
  origin?: string;
  authorization?: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

const WEB_COOKIE_NAME = "__Host-growdesk_web";
const TEST_PASSWORD = "TestHttpParityPassword123!";

function readOwnedRun(): OwnedRun {
  const manifestPath = process.env.BOOT02_RUN_FILE;
  if (!manifestPath) throw new Error("Use the managed isolated integration runner");
  const file = fs.realpathSync(manifestPath);
  const directory = path.dirname(file);
  const stat = fs.statSync(file);
  const tmp = fs.realpathSync(os.tmpdir());
  if (
    path.dirname(directory) !== tmp ||
    !path.basename(directory).startsWith("growdesk-integration-") ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error("Unsafe integration manifest");
  }
  const directoryStat = fs.statSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.uid !== stat.uid || (directoryStat.mode & 0o077) !== 0) {
    throw new Error("Unsafe integration run directory");
  }
  const run = JSON.parse(fs.readFileSync(file, "utf8")) as OwnedRun;
  if (
    run.directory !== directory ||
    run.database !== "test_growdesk_integration" ||
    run.user !== "test_runner" ||
    !/^[a-f0-9]{48}$/.test(run.password) ||
    !/^[a-f0-9]{32}$/.test(run.token) ||
    !Number.isInteger(run.pgPort) ||
    !Number.isInteger(run.redisPort) ||
    run.pgPort < 1025 ||
    run.pgPort > 65535 ||
    run.redisPort < 1025 ||
    run.redisPort > 65535 ||
    run.redisPort === 6379 ||
    run.pgPort === run.redisPort
  ) {
    throw new Error("Not an owned test tenant");
  }
  return run;
}

async function freePort(): Promise<number> {
  const listener = net.createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
  });
  const address = listener.address() as AddressInfo;
  const port = address.port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}

function parseResponseBody(raw: string): any {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function request(base: string, pathname: string, options: HttpOptions = {}): Promise<HttpResult> {
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(options.headers ?? {}),
  };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.origin) headers.origin = options.origin;
  if (options.authorization) headers.authorization = options.authorization;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(`${base}${pathname}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: "manual",
    signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
  });
  const raw = await response.text();
  return { status: response.status, body: parseResponseBody(raw), headers: response.headers };
}

function bodySummary(body: unknown): string {
  try {
    const serialized = JSON.stringify(body);
    return (serialized === undefined ? String(body) : serialized).slice(0, 700);
  } catch {
    return String(body).slice(0, 700);
  }
}

function expectStatus(result: HttpResult, status: number, label: string): any {
  assert.equal(result.status, status, `${label}: ${bodySummary(result.body)}`);
  return result.body;
}

function setCookieFrom(result: HttpResult): string | null {
  const getSetCookie = (result.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const values = typeof getSetCookie === "function"
    ? getSetCookie.call(result.headers)
    : [result.headers.get("set-cookie") ?? ""];
  const escaped = WEB_COOKIE_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = values.join(",").match(new RegExp(`${escaped}=([^;,\\s]+)`));
  return match?.[1] ? `${WEB_COOKIE_NAME}=${decodeURIComponent(match[1])}` : null;
}

function sessionCookie(result: HttpResult, label: string): string {
  const cookie = setCookieFrom(result);
  assert.ok(cookie, `${label}: response did not set ${WEB_COOKIE_NAME}`);
  return cookie;
}

async function waitForWeb(child: ChildProcess, origin: string, logPath: string): Promise<void> {
  let lastError = "";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Next standalone exited before readiness (${child.exitCode})`);
    }
    try {
      const response = await request(origin, "/api/auth/me", { timeoutMs: 2_000 });
      if (response.status === 200 || response.status === 401) return;
      lastError = `status ${response.status}: ${bodySummary(response.body)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  let tail = "";
  try {
    const log = fs.readFileSync(logPath, "utf8");
    tail = log.slice(-3000);
  } catch {
    // The readiness error remains actionable without a log file.
  }
  throw new Error(`Next standalone readiness timed out: ${lastError}\n${tail}`);
}

async function stopProcess(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function idFromBody(body: any): string {
  const value = body?.id ?? body?.data?.id ?? body?.record?.id;
  assert.equal(typeof value, "string", `missing record ID: ${bodySummary(body)}`);
  return value;
}

function versionFromBody(body: any): string {
  const value = body?.version ?? body?.baseVersion ?? body?.data?.version ?? body?.record?.version;
  assert.match(String(value), /^[1-9]\d*$/, `missing record version: ${bodySummary(body)}`);
  return String(value);
}

function listFromBody(body: any): any[] {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.records)) return body.records;
  assert.fail(`legacy list response is not an array: ${bodySummary(body)}`);
}

async function runLegacyCrud(
  webOrigin: string,
  cookie: string,
  origin: string,
  label: string,
  endpoint: string,
  createBody: Record<string, unknown>,
  updateFields: Record<string, unknown>,
  expectedRecorder?: string,
): Promise<string> {
  const created = await request(webOrigin, endpoint, {
    method: "POST", cookie, origin, body: { ...createBody, clientId: randomUUID() },
  });
  const createdBody = expectStatus(created, 201, `${label} create`);
  if (expectedRecorder) assert.equal(createdBody.recordedById, expectedRecorder, `${label} must expose the authenticated recorder`);
  const id = idFromBody(createdBody);
  let version = versionFromBody(createdBody);

  const listed = await request(webOrigin, `${endpoint}?babyId=${encodeURIComponent(String(createBody.babyId))}`, { cookie });
  const rows = listFromBody(expectStatus(listed, 200, `${label} list`));
  assert.ok(rows.some((row) => row?.id === id), `${label} list omitted ${id}`);

  const detail = await request(webOrigin, `${endpoint}?babyId=${encodeURIComponent(String(createBody.babyId))}&id=${encodeURIComponent(id)}`, { cookie });
  expectStatus(detail, 200, `${label} detail`);

  const updated = await request(webOrigin, endpoint, {
    method: "PUT", cookie, origin, body: { id, babyId: createBody.babyId, version, ...updateFields },
  });
  const updatedBody = expectStatus(updated, 200, `${label} update`);
  version = versionFromBody(updatedBody);

  const deleted = await request(webOrigin, `${endpoint}?id=${encodeURIComponent(id)}&babyId=${encodeURIComponent(String(createBody.babyId))}&baseVersion=${encodeURIComponent(version)}`, {
    method: "DELETE", cookie, origin,
  });
  expectStatus(deleted, 200, `${label} delete`);
  return id;
}

test("old Web HTTP parity against a real Fastify listener and owned PostgreSQL", async (t) => {
  const run = readOwnedRun();
  const webRootValue = process.env.GROWDESK_WEB_ROOT;
  if (!webRootValue || !path.isAbsolute(webRootValue)) {
    throw new Error("Use --web-root with an absolute old Web repository path");
  }
  const webRoot = fs.realpathSync(webRootValue);
  const standalone = path.join(webRoot, ".next", "standalone", "server.js");
  assert.ok(fs.statSync(standalone).isFile(), "old Web standalone server.js is missing");

  const databaseUrl = requireTestDatabaseUrl(
    `postgresql://${run.user}:${run.password}@127.0.0.1:${run.pgPort}/${run.database}?sslmode=disable`,
    {
      host: "127.0.0.1",
      port: run.pgPort,
      database: run.database,
      role: run.user,
      password: run.password,
    },
  );
  const database = createDatabaseContext({ url: databaseUrl });
  try {
    const { rows } = await database.pool.query(
      "SELECT current_user AS role, current_database() AS db, current_setting('cluster_name') AS token, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser",
    );
    assert.equal(rows[0]?.role, run.user, "database role is not the owned test role");
    assert.equal(rows[0]?.db, run.database, "database name is not the owned test database");
    assert.ok(rows[0]?.token === run.token, "PostgreSQL instance identity mismatch");
    assert.equal(rows[0]?.superuser, false, "test role must not be a superuser");
  } catch (error) {
    await database.close();
    throw error;
  }
  const jwtSecret = "test_http_parity_jwt_secret_at_least_32_chars";
  const storage = run.s3 ? requireTestObjectStorage(run.s3, run.token) : undefined;
  let storageClient: S3Client | undefined;
  if (storage) {
    process.kill(storage.pid, 0);
    storageClient = new S3Client({ endpoint: storage.endpoint, region: storage.region, forcePathStyle: true,
      credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey } });
    await storageClient.send(new CreateBucketCommand({ Bucket: storage.bucket }));
    t.after(async () => {
      try {
        // This exact run-token bucket belongs exclusively to this child stack.
        for (;;) {
          const page = await storageClient!.send(new ListObjectsV2Command({ Bucket: storage.bucket }));
          const objects = (page.Contents || []).flatMap((object) => object.Key ? [{ Key: object.Key }] : []);
          if (!objects.length) break;
          const deleted: DeleteObjectsCommandOutput = await storageClient!.send(new DeleteObjectsCommand({ Bucket: storage.bucket, Delete: { Objects: objects } }));
          assert.equal(deleted.Errors?.length || 0, 0, "owned object cleanup failed");
        }
        await storageClient!.send(new DeleteBucketCommand({ Bucket: storage.bucket }));
      } finally { storageClient!.destroy(); }
    });
  }
  const api = buildApiApp({ databaseContext: database, jwtSecret,
    ...(storage ? { storageDriver: new AwsS3StorageDriver({ ...storage, forcePathStyle: true }) } : {}) });
  const users: string[] = [];
  const families: string[] = [];
  let webProcess: ChildProcess | null = null;
  let webLogFd: number | null = null;
  const runtimeDir = path.join(run.directory, "web-http-runtime");
  const webLogPath = path.join(run.directory, "web-http.log");
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });

  await api.listen({ host: "127.0.0.1", port: 0 });
  const apiAddress = api.server.address();
  if (!apiAddress || typeof apiAddress === "string") throw new Error("Fastify did not expose a TCP address");
  const apiOrigin = `http://127.0.0.1:${(apiAddress as AddressInfo).port}`;
  const webPort = await freePort();
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const uiManifestPath = path.join(run.directory, "web-ui-manifest.json");

  // External OCR is deliberately virtual; database, BFF and object storage remain real.
  // Standalone Next changes cwd to its build directory, so reject profile overrides there.
  assert.equal(fs.existsSync(path.join(path.dirname(standalone), "llm-profiles.json")), false,
    "Standalone build must not contain a live LLM profile");
  const virtualAi = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions" ||
        request.headers.authorization !== "Bearer test_owned_virtual_ai") {
      response.writeHead(403).end(); return;
    }
    for await (const _chunk of request) { /* consume synthetic image request */ }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      title: "test_virtual_ocr", category: "general", date: "2026-09-19",
      hospital: "test_virtual_hospital", aiSummary: "test_virtual_ocr_response", items: [],
    }) } }] }));
  });
  await new Promise<void>((resolve) => virtualAi.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => virtualAi.close(error => error ? reject(error) : resolve())));
  const virtualAiUrl = `http://127.0.0.1:${(virtualAi.address() as AddressInfo).port}/v1`;

  const startWeb = async (useGoldenClock = Boolean(process.env.GROWDESK_LEGACY_WEB_ROOT)) => {
    if (webProcess && webProcess.exitCode === null) return;
    webLogFd = fs.openSync(webLogPath, "a", 0o600);
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: String(webPort),
      GROWDESK_ENABLED: "true",
      GROWDESK_API_URL: apiOrigin,
      GROWDESK_WEB_ORIGIN: webOrigin,
      NEXT_TELEMETRY_DISABLED: "1",
      AI_BASE_URL: virtualAiUrl, OPENAI_BASE_URL: virtualAiUrl,
      AI_API_KEY: "test_owned_virtual_ai", OPENAI_API_KEY: "test_owned_virtual_ai",
      OPENROUTER_API_KEY: "", AI_MODEL: "test_virtual", AI_VISION_MODEL: "test_virtual",

      // The migrated Web must not discover or mutate its checked-in SQLite DB.
      DATABASE_URL: `file:${path.join(runtimeDir, "unused-test-only.db")}`,
    };
    // The Next child is a production standalone process. Node's test runner
    // exports markers such as NODE_TEST_CONTEXT/npm_lifecycle_event; leaving
    // them set would make the Web load .env.test and deliberately relax CSRF.
    delete environment.NODE_TEST_CONTEXT;
    delete environment.npm_lifecycle_event;
    const clockArgs = useGoldenClock ? goldenClockArgs(run.directory) : [];
    webProcess = spawn(process.execPath, [...clockArgs, standalone], {
      cwd: runtimeDir,
      env: environment,
      stdio: ["ignore", webLogFd, webLogFd],
    });
    await waitForWeb(webProcess, webOrigin, webLogPath);
  };

  const runFixedUiHook = async () => {
    if (process.env.GROWDESK_WEB_UI !== "1") return;
    // Golden HTTP comparison fixes the server clock so legacy and canonical
    // projections see the same instant. The browser acceptance creates
    // records for its real local day, so keeping that fixed clock would hide
    // successful writes from every date-filtered page. Restart only the owned
    // Web child with the real clock after the golden assertions are complete.
    if (process.env.GROWDESK_LEGACY_WEB_ROOT) {
      await stopProcess(webProcess);
      webProcess = null;
      if (webLogFd !== null) {
        fs.closeSync(webLogFd);
        webLogFd = null;
      }
      await startWeb(false);
    }
    const script = path.join(webRoot, "scripts", "review", "ui-parity-acceptance.mjs");
    assert.ok(fs.statSync(script).isFile(), "fixed Web UI parity hook is missing");
    const hookLogPath = path.join(run.directory, "ui-parity.log");
    const hookLogFd = fs.openSync(hookLogPath, "a", 0o600);
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      UI_BASE_URL: webOrigin,
      UI_RUN_MANIFEST: uiManifestPath,
      GROWDESK_API_URL: apiOrigin,
      GROWDESK_WEB_ORIGIN: webOrigin,
      GROWDESK_PRIVATE_MANIFEST: uiManifestPath,
      DATABASE_URL: `file:${path.join(runtimeDir, "unused-test-only.db")}`,
    };
    delete environment.NODE_TEST_CONTEXT;
    delete environment.npm_lifecycle_event;
    const hook = spawn(process.execPath, [script], {
      cwd: webRoot,
      env: environment,
      stdio: ["ignore", hookLogFd, hookLogFd],
    });
    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        hook.once("error", reject);
        hook.once("exit", (code) => resolve(code ?? 1));
      });
      if (exitCode !== 0) {
        const tail = fs.readFileSync(hookLogPath, "utf8").slice(-4000);
        throw new Error(`fixed Web UI parity hook failed (${exitCode})\n${tail}`);
      }
    } finally {
      fs.closeSync(hookLogFd);
    }
  };

  t.after(async () => {
    await stopProcess(webProcess);
    webProcess = null;
    if (webLogFd !== null) {
      fs.closeSync(webLogFd);
      webLogFd = null;
    }
    // Keep child diagnostics private; the owning runner removes its runtime
    // directory on failure as well as success. Never publish session manifests.
    if (fs.existsSync(webLogPath)) {
      const diagnostic = path.join(os.tmpdir(), `growdesk-web-http-${process.pid}.log`);
      fs.writeFileSync(diagnostic, fs.readFileSync(webLogPath), { mode: 0o600 });
      t.diagnostic(`Private Next diagnostics: ${diagnostic}`);
    }
    try {
      if (families.length) await database.prisma.family.deleteMany({ where: { id: { in: families } } });
      if (users.length) {
        await database.prisma.user.deleteMany({
          where: { id: { in: users }, username: { startsWith: "test_http_parity_" } },
        });
      }
    } finally {
      await api.close();
      await database.close();
    }
  });

  fs.writeFileSync(uiManifestPath, JSON.stringify({
    version: 1,
    runId: path.basename(run.directory),
    ownerPid: process.pid,
    environmentManifest: path.resolve(process.env.BOOT02_RUN_FILE!),
    uiBaseUrl: webOrigin,
    bffOrigin: webOrigin,
    apiBaseUrl: apiOrigin,
    database: { host: "127.0.0.1", port: run.pgPort, name: run.database, database: run.database, role: run.user },
    redis: { host: "127.0.0.1", port: run.redisPort },
    storage: { s3Covered: Boolean(storage), driver: storage ? "owned-minio" : "mock" },
    externalAi: { mode: "owned-loopback-virtual", realProviderCovered: false },
  }) + "\n", { mode: 0o600 });
  fs.chmodSync(uiManifestPath, 0o600);

  await startWeb();

  const aUsername = `test_http_parity_a_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const bUsername = `test_http_parity_b_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

  const missingOrigin = await request(webOrigin, "/api/auth/register", {
    method: "POST",
    body: { username: aUsername, password: TEST_PASSWORD, displayName: "test_http_parity_a" },
  });
  expectStatus(missingOrigin, 403, "register without Origin must fail CSRF");

  const hostileOrigin = await request(webOrigin, "/api/auth/register", {
    method: "POST",
    origin: "http://evil.example",
    body: { username: aUsername, password: TEST_PASSWORD, displayName: "test_http_parity_a" },
  });
  expectStatus(hostileOrigin, 403, "register with hostile Origin must fail CSRF");

  const registration = await request(webOrigin, "/api/auth/register", {
    method: "POST", origin: webOrigin,
    body: { username: aUsername, password: TEST_PASSWORD, displayName: "test_http_parity_a" },
  });
  const registrationBody = expectStatus(registration, 201, "register");
  const aCookie = sessionCookie(registration, "register A");
  const aUserId = registrationBody?.user?.id;
  const aFamilyId = registrationBody?.family?.id ?? registrationBody?.families?.[0]?.id;
  assert.equal(typeof aUserId, "string", "register response missing user id");
  assert.equal(typeof aFamilyId, "string", "register response missing family id");
  users.push(aUserId);
  families.push(aFamilyId);

  const login = await request(webOrigin, "/api/auth/login", {
    method: "POST", origin: webOrigin,
    body: { username: aUsername, password: TEST_PASSWORD },
  });
  const loginBody = expectStatus(login, 200, "login");
  const activeCookie = sessionCookie(login, "login A");
  assert.equal(loginBody?.user?.id, aUserId, "login returned a different principal");

  const me = await request(webOrigin, "/api/auth/me", { cookie: activeCookie });
  const meBody = expectStatus(me, 200, "me");
  assert.equal(meBody?.user?.id, aUserId, "me did not resolve the authenticated principal");

  const babyResponse = await request(webOrigin, "/api/baby", {
    method: "POST", cookie: activeCookie, origin: webOrigin,
    body: {
      familyId: aFamilyId,
      nickname: "test_http_parity_baby",
      birthDate: "2026-01-01",
      gender: "female",
    },
  });
  const babyBody = expectStatus(babyResponse, 201, "baby create");
  const babyId = idFromBody(babyBody);
  assert.equal(babyBody.familyId, aFamilyId, "baby was created outside the selected family");

  await runLegacyCrud(
    webOrigin, activeCookie, webOrigin, "feeding", "/api/records/feeding",
    { babyId, type: "formula", timestamp: "2026-09-19T12:00:00Z", amountMl: 60, notes: "test_http_feed", recordedById: randomUUID() },
    { notes: "test_http_feed_updated" }, aUserId,
  );
  await runLegacyCrud(
    webOrigin, activeCookie, webOrigin, "sleep", "/api/records/sleep",
    { babyId, type: "nap", startTime: "2026-09-19T10:00:00Z", endTime: "2026-09-19T10:30:00Z", nightWakingCount: 0 },
    { notes: "test_http_sleep_updated" }, aUserId,
  );
  await runLegacyCrud(
    webOrigin, activeCookie, webOrigin, "diaper", "/api/records/diaper",
    { babyId, type: "pee", timestamp: "2026-09-19T11:00:00Z" },
    { notes: "test_http_diaper_updated" }, aUserId,
  );
  await runLegacyCrud(
    webOrigin, activeCookie, webOrigin, "food", "/api/food/logs",
    { babyId, date: "2026-09-19", time: "12:30", mealType: "lunch", foods: [], reaction: "like", portion: "test" },
    { notes: "test_http_food_updated" },
  );
  await runLegacyCrud(
    webOrigin, activeCookie, webOrigin, "growth", "/api/growth",
    { babyId, date: "2026-09-19", weightKg: 7.2, heightCm: 68.1, headCircumferenceCm: 43.2 },
    { notes: "test_http_growth_updated" },
  );

  const savedRecipes: any[] = [];
  for (const [index, recipeDate] of ["2026-09-18", "2026-09-19", "2026-09-19"].entries()) {
    const result = await request(webOrigin, "/api/food/plans", {
      method: "POST", cookie: activeCookie, origin: webOrigin,
      body: { babyId, date: recipeDate, name: `test_http_recipe_${index}`, ingredients: ["test_carrot"], steps: ["test_step"] },
    });
    const recipe = expectStatus(result, 201, "food recipe create");
    assert.equal(recipe.babyId, babyId);
    assert.equal(recipe.date, recipeDate);
    assert.ok(recipe.id && recipe.createdAt);
    savedRecipes.push(recipe);
  }
  const allRecipes = listFromBody(expectStatus(await request(webOrigin, `/api/food/plans?babyId=${babyId}`, { cookie: activeCookie }), 200, "recipe history"));
  assert.deepEqual(allRecipes.map(row => row.id), [savedRecipes[1].id, savedRecipes[2].id, savedRecipes[0].id]);
  for (const recipe of savedRecipes) assert.deepEqual(allRecipes.find(row => row.id === recipe.id), recipe, "recipe identity/content must survive later saves");
  const dayRecipes = listFromBody(expectStatus(await request(webOrigin, `/api/food/plans?babyId=${babyId}&date=2026-09-19`, { cookie: activeCookie }), 200, "same-day recipes"));
  assert.equal(dayRecipes.length, 2);
  assert.equal(allRecipes.some(row => "supplementState" in row || "webRecipes" in row), false);

  const pendingBody = { babyId, clientId: randomUUID(), name: "test_pending_vaccine", dose: "第1剂", scheduledDate: "2026-09-20", isCompleted: false };
  const pending = expectStatus(await request(webOrigin, "/api/vaccines", { method: "POST", cookie: activeCookie, origin: webOrigin, body: pendingBody }), 201, "pending vaccine create");
  assert.equal(pending.record.isCompleted, false);
  assert.equal(pending.record.completedDate, null);
  const repeatedPending = expectStatus(await request(webOrigin, "/api/vaccines", { method: "POST", cookie: activeCookie, origin: webOrigin, body: pendingBody }), 201, "pending vaccine idempotent retry");
  assert.deepEqual(repeatedPending, pending);
  const pendingId = idFromBody(pending.record);
  const reminders = listFromBody(expectStatus(await request(webOrigin, `/api/notifications?babyId=${babyId}`, { cookie: activeCookie }), 200, "pending vaccine reminder"));
  assert.ok(reminders.some(row => row.id === `vaccine-${pendingId}`), "a real saved pending record must produce its reminder");
  expectStatus(await request(webOrigin, `/api/vaccines?id=${pendingId}&babyId=${babyId}`, { method: "DELETE", cookie: activeCookie, origin: webOrigin }), 200, "pending vaccine delete");
  const afterPendingDelete = listFromBody(expectStatus(await request(webOrigin, `/api/notifications?babyId=${babyId}`, { cookie: activeCookie }), 200, "pending reminder removed"));
  assert.equal(afterPendingDelete.some(row => row.id === `vaccine-${pendingId}`), false);
  const preservedRecipes = listFromBody(expectStatus(await request(webOrigin, `/api/food/plans?babyId=${babyId}`, { cookie: activeCookie }), 200, "recipe history after pending mutation"));
  assert.deepEqual(preservedRecipes, allRecipes);

  const invite = await request(webOrigin, "/api/family/invite", {
    method: "POST", cookie: activeCookie, origin: webOrigin,
    body: { familyId: aFamilyId, expiresInDays: 7 },
  });
  const inviteBody = expectStatus(invite, 200, "family invite");
  assert.match(String(inviteBody?.inviteCode), /^[A-F0-9]{12}$/, "invite code must be six-byte uppercase hex");
  const preview = await request(webOrigin, `/api/family/preview?code=${encodeURIComponent(inviteBody.inviteCode)}`);
  expectStatus(preview, 200, "family invite preview");

  const registrationB = await request(webOrigin, "/api/auth/register", {
    method: "POST", origin: webOrigin,
    body: { username: bUsername, password: TEST_PASSWORD, displayName: "test_http_parity_b" },
  });
  const registrationBBody = expectStatus(registrationB, 201, "register B");
  const bCookie = sessionCookie(registrationB, "register B");
  assert.equal(typeof registrationBBody?.user?.id, "string", "register B response missing user id");
  const bFamilyId = registrationBBody?.family?.id ?? registrationBBody?.families?.[0]?.id;
  assert.equal(typeof bFamilyId, "string", "register B response missing family id");
  users.push(registrationBBody.user.id);
  families.push(bFamilyId);

  const foreignBaby = await request(webOrigin, `/api/baby?babyId=${encodeURIComponent(babyId)}`, { cookie: bCookie });
  assert.ok([403, 404].includes(foreignBaby.status), `foreign baby read must be denied: ${bodySummary(foreignBaby.body)}`);
  const foreignRecipes = await request(webOrigin, `/api/food/plans?babyId=${babyId}`, { cookie: bCookie });
  assert.ok([403, 404].includes(foreignRecipes.status), "foreign recipe history must be denied");
  const foreignFeed = await request(webOrigin, `/api/records/feeding?babyId=${encodeURIComponent(babyId)}`, { cookie: bCookie });
  assert.ok([403, 404].includes(foreignFeed.status), `foreign record read must be denied: ${bodySummary(foreignFeed.body)}`);
  const foreignWrite = await request(webOrigin, "/api/records/feeding", {
    method: "POST", cookie: bCookie, origin: webOrigin,
    body: { babyId, type: "formula", timestamp: "2026-09-19T13:00:00Z", amountMl: 30, clientId: randomUUID() },
  });
  assert.ok([403, 404].includes(foreignWrite.status), `foreign record write must be denied: ${bodySummary(foreignWrite.body)}`);

  const aiCreate = await request(webOrigin, "/api/ai/sessions", {
    method: "POST", cookie: activeCookie, origin: webOrigin,
    body: { babyId, title: "test_http_ai", contextType: "food" },
  });
  // The legacy route historically returns 200 for this JSON resource create.
  const aiCreateBody = expectStatus(aiCreate, 200, "AI session create");
  const aiSessionId = idFromBody(aiCreateBody?.session);
  assert.equal(aiCreateBody?.session?.babyId, babyId, "AI session lost baby scope");

  // The POST crosses into canonical API storage. Verify that persisted row over
  // the Fastify TCP listener before exercising the legacy local CRUD adapter.
  const apiLogin = await request(apiOrigin, "/api/v1/auth/login", {
    method: "POST", body: { username: aUsername, password: TEST_PASSWORD },
  });
  const apiToken = expectStatus(apiLogin, 200, "canonical API login")?.data?.accessToken;
  assert.equal(typeof apiToken, "string", "canonical API login did not return an access token");
  const canonicalSessions = await request(apiOrigin, "/api/v1/ai/sessions?limit=100", { authorization: `Bearer ${apiToken}` });
  const canonicalBody = expectStatus(canonicalSessions, 200, "canonical AI session list");
  assert.ok((canonicalBody?.data ?? []).some((session: any) => session.id === aiSessionId), "AI session was not persisted by the API");

  // Medical and vaccine services already maintain timeline projections with
  // their own entity types. Exercise the production Fastify serializer over
  // TCP, then the Web adapter, so the compatibility layer cannot hide a
  // schema rejection or silently drop either projection.
  const medicalCreate = await request(apiOrigin, `/api/v1/babies/${encodeURIComponent(babyId)}/medical/reports`, {
    method: "POST",
    authorization: `Bearer ${apiToken}`,
    headers: { "idempotency-key": randomUUID() },
    body: {
      reportDate: "2026-09-18",
      title: "test_http_medical",
      hospital: "test_http_hospital",
      department: "checkup",
      diagnosis: "test_http_doctor",
      notes: "test_http_medical_notes",
    },
  });
  const medicalId = idFromBody(expectStatus(medicalCreate, 201, "canonical medical create")?.data);
  const vaccineCreate = await request(apiOrigin, `/api/v1/babies/${encodeURIComponent(babyId)}/vaccines/records`, {
    method: "POST",
    authorization: `Bearer ${apiToken}`,
    body: {
      vaccineCode: "HepB",
      administeredDate: "2026-09-18",
      clinic: "test_http_clinic",
      batchNumber: "test_http_batch",
      notes: "test_http_vaccine_notes",
    },
  });
  const vaccineId = idFromBody(expectStatus(vaccineCreate, 201, "canonical vaccine create")?.data);

  const canonicalTimeline = await request(apiOrigin, `/api/v1/babies/${encodeURIComponent(babyId)}/timeline?limit=200`, {
    authorization: `Bearer ${apiToken}`,
  });
  const canonicalTimelineBody = expectStatus(canonicalTimeline, 200, "canonical timeline with medical and vaccine projections");
  const canonicalTimelineRows = Array.isArray(canonicalTimelineBody?.data) ? canonicalTimelineBody.data : [];
  const canonicalTimelineSummary = canonicalTimelineRows.map((entry: any) => ({
    id: entry?.id,
    entityId: entry?.entityId,
    entityType: entry?.entityType,
    summary: entry?.summary,
  }));
  assert.ok(canonicalTimelineRows.some((entry: any) => entry.entityId === medicalId && entry.entityType === "medical"), `canonical timeline omitted medical projection (${bodySummary({ medicalId, rows: canonicalTimelineSummary })})`);
  assert.ok(canonicalTimelineRows.some((entry: any) => entry.entityId === vaccineId && entry.entityType === "vaccine"), `canonical timeline omitted vaccine projection (${bodySummary({ vaccineId, rows: canonicalTimelineSummary })})`);

  const webTimeline = await request(webOrigin, `/api/records/timeline?babyId=${encodeURIComponent(babyId)}&date=2026-09-18`, { cookie: activeCookie });
  const webTimelineRows = listFromBody(expectStatus(webTimeline, 200, "Web timeline with medical and vaccine projections"));
  const webMedical = webTimelineRows.find((entry: any) => entry?.entityId === medicalId || entry?.recordId === medicalId || entry?.id === medicalId);
  const webVaccine = webTimelineRows.find((entry: any) => entry?.entityId === vaccineId || entry?.recordId === vaccineId || entry?.id === vaccineId);
  assert.equal(webMedical?.type, "medical", "Web timeline dropped the medical discriminator");
  assert.match(String(webMedical?.detail), /test_http_medical/, "Web timeline dropped the medical summary");
  assert.equal(webVaccine?.type, "vaccine", "Web timeline dropped the vaccine discriminator");
  assert.match(String(webVaccine?.detail), /HepB/, "Web timeline dropped the vaccine summary");

  const aiList = await request(webOrigin, "/api/ai/sessions?babyId=" + encodeURIComponent(babyId), { cookie: activeCookie });
  const aiListBody = expectStatus(aiList, 200, "AI session list");
  assert.ok((aiListBody?.sessions ?? []).some((session: any) => session.id === aiSessionId), "AI list omitted the created session");

  const aiGet = await request(webOrigin, `/api/ai/sessions/${encodeURIComponent(aiSessionId)}`, { cookie: activeCookie });
  expectStatus(aiGet, 200, "AI session get");
  const aiPatch = await request(webOrigin, `/api/ai/sessions/${encodeURIComponent(aiSessionId)}`, {
    method: "PATCH", cookie: activeCookie, origin: webOrigin, body: { title: "test_http_ai_renamed" },
  });
  const aiPatchBody = expectStatus(aiPatch, 200, "AI session patch");
  assert.equal(aiPatchBody?.session?.title, "test_http_ai_renamed", "AI session title did not update");
  const aiDelete = await request(webOrigin, `/api/ai/sessions/${encodeURIComponent(aiSessionId)}`, {
    method: "DELETE", cookie: activeCookie, origin: webOrigin,
  });
  expectStatus(aiDelete, 200, "AI session delete");
  const deletedAi = await request(webOrigin, `/api/ai/sessions/${encodeURIComponent(aiSessionId)}`, { cookie: activeCookie });
  expectStatus(deletedAi, 404, "deleted AI session read");

  const legacyRootValue = process.env.GROWDESK_LEGACY_WEB_ROOT;
  if (legacyRootValue) {
    assert.ok(path.isAbsolute(legacyRootValue), "legacy Web root must be absolute");
    const legacyRoot = fs.realpathSync(legacyRootValue);
    assert.ok(fs.statSync(path.join(legacyRoot, ".next", "standalone", "server.js")).isFile(), "legacy Web standalone server.js is missing");
    const golden = await import("./legacy-golden-fixture.js");
    assert.equal(typeof golden.runLegacyGolden, "function", "legacy golden fixture export is missing");
    await golden.runLegacyGolden({ database, run, webRoot, legacyRoot, webOrigin, apiOrigin });
  }

  // Keep the UI acceptance on the same owned stack, but run it after the
  // protocol assertions so a browser failure cannot mask HTTP evidence.
  await runFixedUiHook();
});
