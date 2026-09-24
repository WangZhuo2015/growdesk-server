/**
 * Production attachment-promotion boundary.
 *
 * The Python planner is read-only. This command is the explicit write step:
 * it consumes that machine-readable plan, verifies each archive file and S3
 * object, and commits the private Attachment row plus replay receipt. It
 * refuses to execute unless --execute is present and never prints connection
 * strings or credentials.
 */

import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import { createDatabaseContext } from "@growdesk/database";
import {
  LegacyAttachmentPromotionRuntime,
  type PlannedAttachmentReport,
  type PromotionExecutionReport,
} from "./attachment-promotion-runtime.js";

type Mode = "promote" | "reconcile";

interface Options {
  readonly archive: string;
  readonly plan: string;
  readonly report: string;
  readonly bucket: string;
  readonly mode: Mode;
  readonly execute: boolean;
}

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseOptions(argv: readonly string[]): Options {
  const mode = optionValue(argv, "--mode") ?? "promote";
  if (mode !== "promote" && mode !== "reconcile") throw new Error("--mode must be promote or reconcile");
  const archive = optionValue(argv, "--archive");
  const plan = optionValue(argv, "--plan");
  const report = optionValue(argv, "--report");
  const bucket = optionValue(argv, "--bucket") ?? process.env.S3_BUCKET;
  if (!archive || !plan || !report || !bucket) throw new Error("--archive, --plan, --report and --bucket are required");
  return {
    archive: resolve(archive),
    plan: resolve(plan),
    report: resolve(report),
    bucket,
    mode,
    execute: argv.includes("--execute"),
  };
}

async function readPlan(path: string): Promise<PlannedAttachmentReport> {
  const raw = JSON.parse(await fs.readFile(path, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("attachment plan must be a JSON object");
  return raw as PlannedAttachmentReport;
}

async function writeReport(path: string, report: unknown): Promise<void> {
  const handle = await fs.open(path, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(report, null, 2) + "\n", "utf8");
  } finally {
    await handle.close();
  }
}

function safeFailure(error: unknown): { code: string; message: string } {
  if (error instanceof Error) return { code: error.name || "PROMOTION_FAILED", message: error.message };
  return { code: "PROMOTION_FAILED", message: "attachment promotion failed" };
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  if (!options.execute) {
    await writeReport(options.report, {
      status: "execution_required",
      mode: options.mode,
      mappingVersion: "attachment-promotion-v1",
      message: "Planner output was not executed. Re-run with --execute after reviewing the private plan.",
    });
    console.error("Attachment promotion plan written; pass --execute to perform the private DB/object-store write.");
    return 2;
  }

  const plan = await readPlan(options.plan);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const endpoint = process.env.S3_ENDPOINT;
  const s3 = new S3Client({
    endpoint,
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: Boolean(endpoint),
    credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
      : undefined,
  });
  const database = createDatabaseContext({ url: databaseUrl });
  try {
    const runtime = new LegacyAttachmentPromotionRuntime({
      prisma: database.prisma,
      s3,
      bucket: options.bucket,
      archiveRoot: options.archive,
    });
    const result: PromotionExecutionReport = options.mode === "reconcile"
      ? await runtime.reconcile(plan)
      : await runtime.promote(plan);
    await writeReport(options.report, result);
    console.log(JSON.stringify({ status: result.status, mode: result.mode, counts: result.counts }));
    return result.status === "completed" ? 0 : 1;
  } finally {
    await database.close();
    s3.destroy();
  }
}

main().catch(async (error: unknown) => {
  const output = optionValue(process.argv.slice(2), "--report");
  if (output) {
    try {
      await writeReport(resolve(output), { status: "failed", ...safeFailure(error) });
    } catch {
      // The original error remains represented by the exit code; do not print
      // a path or connection value when report creation itself fails.
    }
  }
  console.error(`Attachment promotion failed: ${safeFailure(error).code}`);
  process.exitCode = 1;
});
