/** Same logical synthetic records in owned PG and owned legacy SQLite. Never reads a live database. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import type { DatabaseContext } from "../../packages/database/src/client.js";
import { goldenClockArgs, GOLDEN_NOW } from "./golden-clock.js";

const id = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const date = "2026-09-19";
const stamp = "2026-09-19T00:00:00.000Z";
const password = "TestGoldenPassword123!";
type Row = Record<string, any>;
interface Options {
  database: DatabaseContext;
  run: { directory: string; token?: string; database: string; user: string; pgPort: number };
  webRoot: string; legacyRoot: string; webOrigin: string; apiOrigin: string;
}

function fixtures(passwordHash: string) {
  const legacy: Record<string, Row[]> = {};
  const canonical: Record<string, Row[]> = {};
  const pair = (oldTable: string, newTable: string, old: Row, current: Row) => {
    (legacy[oldTable] ??= []).push(old);
    (canonical[newTable] ??= []).push(current);
  };
  const times = { createdAt: stamp, updatedAt: stamp };
  pair("User", "user", { id: id(1), username: "test_golden_user", displayName: "test_golden_parent", passwordHash, ...times },
    { id: id(1), username: "test_golden_user", displayName: "test_golden_parent", passwordHash, ...times });
  pair("Family", "family", { id: id(2), name: "test_golden_family", inviteCode: "TESTGOLDEN", ...times },
    { id: id(2), name: "test_golden_family", timezone: "Asia/Shanghai", ...times });
  pair("FamilyMember", "familyMember", { id: id(3), familyId: id(2), userId: id(1), role: "admin", relation: "parent", createdAt: stamp },
    { id: id(3), familyId: id(2), userId: id(1), role: "admin", relation: "parent", ...times });
  pair("Baby", "baby", { id: id(4), familyId: id(2), nickname: "test_golden_baby", gender: "female", birthDate: "2026-01-01", gestationalAge: 38, avatarUrl: null, ...times },
    // Legacy SQLite stores gestational age in weeks; canonical Baby stores days.
    { id: id(4), familyId: id(2), nickname: "test_golden_baby", gender: "girl", birthDate: "2026-01-01", gestationalAge: 266, avatarUrl: null, ...times });
  canonical.babyMember = [{ id: id(5), familyId: id(2), babyId: id(4), userId: id(1), role: "admin", ...times }];
  const common = { familyId: id(2), babyId: id(4), ...times };
  const formulaId = id(500);
  const supplementId = id(501);
  const scheduleId = id(502);
  const supplementRecordId = id(503);
  const foodPlanId = id(504);
  const vaccineRecordId = id(505);
  const vaccineSelectionId = id(506);
  const formulaNutrients = {
    energy: { amount: 68, unit: "kcal" },
    protein: { amount: 1.4, unit: "g" },
  };
  const supplementNutrients = {
    vitamin_d: { amount: 400, unit: "IU" },
  };
  // Keep the old SQLite columns and the new PG fields semantically aligned.
  // The new formula adapter derives this ratio from scoop/water values.
  pair("FormulaProduct", "formulaProduct", {
    id: formulaId, familyId: id(2), name: "test_golden_formula", brand: "test_golden_brand", stage: 1,
    scoopWeightG: 4.3, waterPerScoopMl: 30, reconstitutionRatio: 0.1433,
    servingSizeUnit: "per_100g", nutrientsJson: JSON.stringify(formulaNutrients), notes: null,
    isActive: true, isDefault: true, ...times,
  }, {
    id: formulaId, familyId: id(2), name: "test_golden_formula", brand: "test_golden_brand", stage: "1",
    scoopWeightG: "4.3", waterPerScoopMl: "30", reconstitutionRatio: "0.1433",
    servingSizeUnit: "per_100g", nutrientsJson: formulaNutrients, notes: null,
    isActive: true, isDefault: true, isArchived: false, ...times,
  });
  const supplementProduct = {
    id: supplementId, familyId: id(2), name: "test_golden_vitamin_d", brand: "test_golden_brand",
    dosageForm: "drops", unitName: "滴", defaultDose: 1.5, nutrients: supplementNutrients,
    notes: "test_supplement_notes", isActive: true, createdAt: stamp, updatedAt: stamp,
  };
  legacy.SupplementProduct = [{
    id: supplementId, familyId: id(2), name: supplementProduct.name, brand: supplementProduct.brand,
    dosageForm: supplementProduct.dosageForm, unitName: supplementProduct.unitName,
    defaultDose: supplementProduct.defaultDose, nutrientsJson: JSON.stringify(supplementNutrients),
    notes: supplementProduct.notes, isActive: true, ...times,
  }];
  const timeline: Row[] = [];
  function entry(n: number, entityType: string, entityId: string, occurredAt: string, summary: string) {
    timeline.push({ id: id(8000 + n), ...common, entityType, entityId, occurredAt, summary, source: "ui_manual" });
  }
  // More than one canonical page; boundary rows have distinct nonzero values.
  for (let n = 0; n < 205; n++) {
    const timestamp = new Date(Date.parse("2026-09-18T16:00:00Z") + n * 60_000).toISOString();
    const record = { id: id(100 + n), babyId: id(4), timestamp, type: n % 2 ? "formula" : "bottle_breast", amountMl: 30 + n, leftMinutes: null, rightMinutes: null, spitUp: false, formulaProductId: n % 2 ? formulaId : null, notes: `test_feeding_${n}`, source: "ui_manual", sourceAgent: null, recordedById: id(1), createdAt: stamp };
    pair("FeedingRecord", "feedingRecord", record, { id: record.id, ...common, feedingType: n % 2 ? "formula" : "bottle", formulaProductId: record.formulaProductId, occurredAt: timestamp, amountMl: String(record.amountMl), spitUp: "false", notes: record.notes, source: "ui_manual", recordedByUserId: id(1) });
    entry(n, "feeding", record.id, timestamp, `Feeding: ${n % 2 ? "formula" : "bottle"} ${record.amountMl}ml`);
  }
  pair("SleepRecord", "sleepRecord", { id: id(400), babyId: id(4), type: "night", startTime: "2026-09-18T14:00:00.000Z", endTime: "2026-09-18T22:00:00.000Z", nightWakingCount: 2, notes: "test_sleep", source: "ui_manual", recordedById: id(1), createdAt: stamp },
    { id: id(400), ...common, sleepType: "night", startedAt: "2026-09-18T14:00:00.000Z", endedAt: "2026-09-18T22:00:00.000Z", nightWakingCount: 2, notes: "test_sleep", source: "ui_manual", recordedByUserId: id(1) });
  entry(400, "sleep", id(400), "2026-09-18T14:00:00.000Z", "Sleep: night");
  pair("DiaperRecord", "diaperRecord", { id: id(401), babyId: id(4), type: "both", timestamp: "2026-09-19T01:00:00.000Z", poopColor: "yellow", poopConsistency: "paste", notes: "test_diaper", source: "ui_manual", recordedById: id(1), createdAt: stamp },
    { id: id(401), ...common, diaperType: "both", occurredAt: "2026-09-19T01:00:00.000Z", poopColor: "yellow", poopConsistency: "paste", notes: "test_diaper", source: "ui_manual", recordedByUserId: id(1) });
  entry(401, "diaper", id(401), "2026-09-19T01:00:00.000Z", "Diaper: both");
  pair("GrowthMeasurement", "growthMeasurement", { id: id(402), babyId: id(4), date, ageInMonths: 8, ageLabel: "8月18天", weightKg: 7.25, heightCm: 66.5, headCircumferenceCm: 42.5, createdAt: stamp },
    { id: id(402), ...common, measurementDate: date, weightKg: "7.25", heightCm: "66.5", headCircumferenceCm: "42.5", notes: null });
  entry(402, "growth", id(402), stamp, "Growth measurement");
  const observations = { acceptance: 3, babyState: "happy", hasAbnormal: true, abnormalNotes: "test_observation" };
  pair("FoodLogRecord", "foodRecord", { id: id(403), babyId: id(4), date, time: "12:00", foods: JSON.stringify(["test_carrot"]), portion: "test_small", ...observations, createdAt: stamp },
    { id: id(403), ...common, recordDate: date, occurredAt: "2026-09-19T04:00:00Z", mealType: "lunch", foodItemIds: ["test_carrot"], portionDescription: "test_small", reaction: "normal", notes: "[growdesk-web-food:v1]" + JSON.stringify({ notes: null, observations }) });
  entry(403, "food", id(403), "2026-09-19T04:00:00Z", "Food: lunch");
  pair("MedicalReport", "medicalReport", { id: id(404), babyId: id(4), date, title: "test_medical", category: "checkup", hospital: "test_hospital", doctorNotes: "test_doctor", aiSummary: null, itemsJson: "[]", imageUrl: null, createdAt: stamp, updatedAt: stamp },
    { id: id(404), ...common, caregiverId: id(1), reportDate: date, title: "test_medical", hospital: "test_hospital", department: "checkup", diagnosis: "test_doctor", items: [] });
  legacy.SupplementSchedule = [{
    id: scheduleId, babyId: id(4), productId: supplementId, frequency: "daily", customDaysJson: JSON.stringify([1, 3, 5]),
    targetDose: 1.5, reminderTime: "09:00", isActive: true, startDate: date, notes: "test_schedule", ...times,
  }];
  legacy.SupplementRecord = [{
    id: supplementRecordId, babyId: id(4), productId: supplementId, clientId: null, recordedById: id(1),
    source: "ui_manual", sourceAgent: null, date, time: "09:00", dose: 1.5, unitName: "滴",
    notes: "test_supplement_record", createdAt: stamp,
  }];
  canonical.supplementRecord = [{
    id: supplementRecordId, ...common, supplementName: supplementProduct.name,
    occurredAt: "2026-09-19T01:00:00.000Z", amount: "1.5 滴", notes: "test_supplement_record", version: 1,
  }];
  const planData = {
    date,
    name: "test_golden_food_plan",
    tags: ["test_tag"],
    nutrition: "test_nutrition",
    ingredients: ["test_carrot"],
    steps: ["test_step"],
    supplementState: {
      supplementProducts: [supplementProduct],
      supplementSchedules: [{
        id: scheduleId, babyId: id(4), productId: supplementId, product: supplementProduct,
        frequency: "daily", customDays: [1, 3, 5], targetDose: 1.5, reminderTime: "09:00",
        isActive: true, startDate: date, notes: "test_schedule", createdAt: stamp, updatedAt: stamp,
      }],
      defaultFormulaId: formulaId,
      customFormulaNutrients: { [formulaId]: formulaNutrients },
    },
    vaccineSelections: { "vac_hepb-1": { selected: true, completed: true } },
  };
  legacy.FoodPlan = [{
    id: foodPlanId, babyId: id(4), date, name: planData.name, tags: JSON.stringify(planData.tags),
    nutrition: planData.nutrition, ingredients: JSON.stringify(planData.ingredients), steps: JSON.stringify(planData.steps), createdAt: stamp,
  }];
  canonical.babyFoodPlan = [{ id: foodPlanId, familyId: id(2), babyId: id(4), planData, ...times }];
  legacy.VaccineRecord = [{
    id: vaccineRecordId, babyId: id(4), name: "vac_hepb", dose: "第1剂", scheduledDate: date,
    completedDate: date, isCompleted: true,
  }];
  legacy.VaccineSelection = [{
    id: vaccineSelectionId, babyId: id(4), vaccineId: "vac_hepb", doseNumber: 1, selected: true, completed: true, updatedAt: stamp,
  }];
  canonical.vaccineRecord = [{
    id: vaccineRecordId, familyId: id(2), babyId: id(4), caregiverId: id(1), vaccineCode: "vac_hepb",
    administeredDate: date, clinic: "test_clinic", batchNumber: "test_batch", notes: "第1剂", version: 1, ...times,
  }];
  entry(503, "supplement", supplementRecordId, "2026-09-19T01:00:00.000Z", "补剂: test_golden_vitamin_d");
  canonical.timelineEntry = timeline;
  return { legacy, canonical, identity: { userId: id(1), familyId: id(2), babyId: id(4), date, month: "8", regionCode: "CN-JS" }, logicalVersion: 3, sqliteDateTimeFormat: "iso8601-plus-offset" };
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

interface ProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * The collector must be asynchronous: the Fastify listener used by the
 * golden run lives in this test process. spawnSync would block its event loop
 * while the child waits for the very HTTP responses this process must serve.
 */
async function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
  timeoutMs: number,
): Promise<ProcessResult> {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const result = await new Promise<ProcessResult>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.exitCode === null) child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 5_000).unref();
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr: `${stderr}\nPROCESS_SPAWN_FAILED` });
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      resolve({ status: status ?? null, stdout, stderr });
    });
  });
  if (timedOut && result.status === 0) return { ...result, status: null, stderr: `${result.stderr}\nPROCESS_TIMEOUT` };
  if (timedOut && !result.stderr.includes("PROCESS_TIMEOUT")) return { ...result, status: null, stderr: `${result.stderr}\nPROCESS_TIMEOUT` };
  return result;
}

export async function runLegacyGolden(options: Options) {
  const { database, run, webRoot, legacyRoot, webOrigin } = options;
  const root = fs.realpathSync(run.directory);
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("growdesk-integration-"));
  assert.equal(run.database, "test_growdesk_integration");
  const proof = await database.pool.query("SELECT current_database() AS db, current_user AS role, current_setting('cluster_name') AS token");
  assert.deepEqual(proof.rows[0], { db: run.database, role: run.user, token: run.token });
  const sqlite = path.join(root, "dev_test.db");
  assert.ok(!fs.existsSync(sqlite), "Never adopt an existing legacy database");
  const fixture = fixtures(await bcrypt.hash(password, 10));
  const fixtureFile = path.join(root, "golden-fixture.json");
  fs.writeFileSync(fixtureFile, JSON.stringify(fixture), { mode: 0o600 });
  const python = `import sqlite3,json,sys,pathlib\nroot=pathlib.Path(sys.argv[1]); target=pathlib.Path(sys.argv[2]); f=json.loads(pathlib.Path(sys.argv[3]).read_text())\nassert target.name=='dev_test.db' and not target.exists()\nc=sqlite3.connect(target)\nfor p in sorted((root/'prisma/migrations').glob('*/migration.sql')): c.executescript(p.read_text())\nfor table,rows in f['legacy'].items():\n for row in rows:\n  for k in ('createdAt','updatedAt'):\n   if k in row: row[k]=row[k].replace('Z','+00:00')\n  keys=list(row); c.execute('INSERT INTO "'+table+'" ('+','.join('"'+k+'"' for k in keys)+') VALUES ('+','.join('?' for k in keys)+')',list(row.values()))\nc.commit();c.close()\n`;
  const seeded = spawnSync("python3", ["-c", python, legacyRoot, sqlite, fixtureFile], { encoding: "utf8" });
  assert.equal(seeded.status, 0, seeded.stderr);
  const dateFields = new Set(["createdAt", "updatedAt", "birthDate", "occurredAt", "startedAt", "endedAt", "measurementDate", "reportDate", "administeredDate"]);
  const prisma = database.prisma as any;
  let child: ChildProcess | undefined;
  try {
    for (const [model, rows] of Object.entries(fixture.canonical)) for (const row of rows) {
      const data = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, dateFields.has(key) && typeof value === "string" ? new Date(value) : value]));
      // The canonical contract uses girl; the current Prisma babies table stores its
      // internal female value and exposes girl through family-baby-service.
      if (model === "baby" && data.gender === "girl") data.gender = "female";
      await prisma[model].create({ data });
    }
    const listener = net.createServer();
    await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
    const port = (listener.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => listener.close(() => resolve()));
    assert.notEqual(port, 3088);
    const origin = `http://127.0.0.1:${port}`;
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, NODE_ENV: "production", PORT: String(port), HOSTNAME: "127.0.0.1", GROWDESK_ENABLED: "false", DATABASE_URL: `file:${sqlite}`, JWT_SECRET: "test_golden_012345678901234567890123456789", AI_API_KEY: "", AI_BASE_URL: "http://127.0.0.1:1", SEED_DEMO: "0" };
    const foodReference = JSON.parse(fs.readFileSync(path.join(legacyRoot, "data/04_foods.json"), "utf8"));
    assert.equal(await prisma.foodLibraryItem.count({ where: {
      id: { in: foodReference.foodItems.map((food: any) => food.id) }, isCustom: false, familyId: null,
    } }), foodReference.foodItems.length, "Fresh migrations must install the public food catalogue");
    const references = spawnSync(process.execPath, ["--import", "tsx", "prisma/seed.ts"], { cwd: legacyRoot, env, encoding: "utf8", timeout: 60_000 });
    assert.equal(references.status, 0, references.stderr);
    const referenceScript = fileURLToPath(new URL("./legacy-golden-reference-fixture.py", import.meta.url));
    const stabilize = spawnSync("python3", [referenceScript, sqlite, fixtureFile], { encoding: "utf8" });
    assert.equal(stabilize.status, 0, stabilize.stderr);
    const log = fs.openSync(path.join(root, "legacy-next.log"), "w", 0o600);
    child = spawn(process.execPath, [...goldenClockArgs(root), path.join(legacyRoot, ".next/standalone/server.js")], { cwd: root, env, stdio: ["ignore", log, log] });
    fs.closeSync(log);
    for (let n = 0; n < 100; n++) {
      if (child.exitCode !== null) throw new Error("Legacy Next exited before readiness");
      try { if ((await fetch(origin + "/api/app-config", { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
      if (n === 99) throw new Error("Legacy Next readiness timed out");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    async function login(base: string) {
      const response = await fetch(base + "/api/auth/login", { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ username: "test_golden_user", password }), signal: AbortSignal.timeout(10_000) });
      if (response.status !== 200) {
        let message = "unavailable";
        let code = "unavailable";
        try {
          const payload = await response.clone().json() as unknown;
          if (payload && typeof payload === "object") {
            const record = payload as Record<string, unknown>;
            const error = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : undefined;
            if (typeof record.message === "string") message = record.message;
            else if (typeof record.error === "string") message = record.error;
            else if (typeof error?.message === "string") message = error.message;
            if (typeof record.code === "string") code = record.code;
            else if (typeof record.errorCode === "string") code = record.errorCode;
            else if (typeof error?.code === "string") code = error.code;
          }
        } catch {}
        assert.fail(`Golden login failed at owned port: ${response.status}; message=${message}; code=${code}`);
      }
      const cookie = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
      assert.ok(cookie); return cookie;
    }
    const [oldCookie, newCookie] = await Promise.all([login(origin), login(webOrigin)]);
    const source = spawnSync("git", ["rev-parse", "HEAD"], { cwd: legacyRoot, encoding: "utf8" });
    assert.equal(source.status, 0);
    const collector = path.join(webRoot, "scripts/review/golden-parity.mjs");
    const manifest = {
      schemaVersion: 1, sourceGitSha: source.stdout.trim(),
      fixtureSha: createHash("sha256").update(JSON.stringify({ now: GOLDEN_NOW, fixture: fixtures("test_hash_excluded_from_provenance"), referenceScript: fs.readFileSync(referenceScript, "utf8") })).digest("hex"),
      legacyOrigin: origin, newOrigin: webOrigin,
      tenant: { username: "test_golden_user", familyName: "test_golden_family", babyName: "test_golden_baby" },
      context: fixture.identity,
      headers: { legacy: { cookie: oldCookie }, new: { cookie: newCookie } },
      endpoints: [
        ["auth.me", "auth", "/api/auth/me", {}],
        ["baby", "family", "/api/baby", { babyId: id(4) }],
        ["family.members", "family", "/api/family/members", { familyId: id(2) }],
        ...["feeding", "sleep", "diaper", "timeline", "daily-summary"].map(type => ["records." + type, type === "timeline" ? "timeline" : "records", "/api/records/" + type, { babyId: id(4), date }]),
        ["feeding.history", "records", "/api/records/feeding", { babyId: id(4), limit: "500" }],
        ["food.logs", "food", "/api/food/logs", { babyId: id(4), date }],
        ["food.items", "food", "/api/food/items", { status: "all" }],
        ["food.plans", "food", "/api/food/plans", { babyId: id(4), date }],
        ["knowledge.food-guidelines", "knowledge", "/api/food/feeding-guidelines", { month: "8" }],
        ["growth", "growth", "/api/growth", { babyId: id(4) }],
        ["growth.chart", "growth", "/api/growth/chart", { babyId: id(4) }],
        ["medical.reports", "medical", "/api/medical/reports", { babyId: id(4) }],
        ["nutrition.products", "nutrition", "/api/nutrition/products", { babyId: id(4) }],
        ["nutrition.products.formula", "nutrition", "/api/nutrition/products", { babyId: id(4), type: "formula" }],
        ["nutrition.products.supplement", "nutrition", "/api/nutrition/products", { babyId: id(4), type: "supplement" }],
        ["nutrition.records", "nutrition", "/api/nutrition/records", { babyId: id(4), date, limit: "100" }],
        ["nutrition.schedules", "nutrition", "/api/nutrition/schedules", { babyId: id(4) }],
        ["nutrition.analysis.day", "nutrition", "/api/nutrition/analysis", { babyId: id(4), date }],
        ["nutrition.analysis.week", "nutrition", "/api/nutrition/analysis", { babyId: id(4), date, days: "7" }],
        ["vaccines", "vaccine", "/api/vaccines", { regionCode: "CN-JS" }],
        ["vaccines.selections", "vaccine", "/api/vaccines/selections", { babyId: id(4) }],
        ...["milestones", "activities", "warning-signs"].map(type => ["development." + type, "knowledge", "/api/development/" + type, {}]),
        ["knowledge.books", "knowledge", "/api/books", { tab: "all" }],
        ["notifications.list", "family", "/api/notifications", {}],
        ["app.config", "knowledge", "/api/app-config", {}],
      ].map(([key, category, endpoint, query]) => ({ id: key, category, path: endpoint, query })),
    };
    const manifestPath = path.join(root, "golden-manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    const golden = path.join(root, "legacy.golden.json");
    const report = path.join(root, "golden-report.json");
    let result = await runProcess(process.execPath, [collector, "--mode", "collect", "--manifest", manifestPath, "--golden", golden, "--output", report], { cwd: webRoot }, 180_000);
    if (result.status === 0) {
      fs.renameSync(report, path.join(root, "golden-collection-report.json"));
      result = await runProcess(process.execPath, [collector, "--mode", "compare", "--manifest", manifestPath, "--golden", golden, "--output", report], { cwd: webRoot }, 180_000);
    }
    if (fs.existsSync(report)) {
      const provenance = path.join(webRoot, ".next/standalone/build-provenance.json");
      const payload = JSON.parse(fs.readFileSync(report, "utf8"));
      payload.testedBuild = fs.existsSync(provenance) ? JSON.parse(fs.readFileSync(provenance, "utf8")) : null;
      fs.writeFileSync(report, JSON.stringify(payload, null, 2) + "\n");
    }
    const evidence = path.join(webRoot, "evidence/tasks/WEB_PARITY_20260919/golden");
    fs.mkdirSync(evidence, { recursive: true });
    const archive = path.join(evidence, new Date().toISOString().replace(/[:.]/g, "-"));
    fs.mkdirSync(archive, { recursive: true });
    for (const file of [golden, report]) if (fs.existsSync(file)) fs.copyFileSync(file, path.join(evidence, path.basename(file)));
    fs.writeFileSync(path.join(evidence, "runner.txt"), `exit=${result.status}\n${result.stdout}\n${result.stderr}`);
    for (const name of ["legacy.golden.json", "golden-report.json", "runner.txt"]) {
      if (fs.existsSync(path.join(evidence, name))) fs.copyFileSync(path.join(evidence, name), path.join(archive, name));
    }
    assert.equal(result.status, 0, `Golden parity failed; see ${evidence}/golden-report.json. ${result.stderr}`);
  } finally {
    if (child) await stop(child);
    await prisma.family.deleteMany({ where: { id: id(2), name: "test_golden_family" } });
    await prisma.user.deleteMany({ where: { id: id(1), username: "test_golden_user" } });
  }
}
