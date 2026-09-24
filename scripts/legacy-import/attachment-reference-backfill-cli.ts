/** Execute the canonical attachment-reference backfill from a private report. */

import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { createDatabaseContext } from "@growdesk/database";
import {
  backfillAttachmentReferences,
  planAttachmentReferenceBackfill,
} from "./attachment-reference-backfill.js";

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function writeReport(path: string, value: unknown): Promise<void> {
  const handle = await fs.open(path, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n", "utf8");
  } finally {
    await handle.close();
  }
}

function safeFailure(error: unknown): { code: string } {
  return { code: error instanceof Error && error.name ? error.name : "REFERENCE_BACKFILL_FAILED" };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const promotionReport = optionValue(argv, "--promotion-report");
  const output = optionValue(argv, "--report");
  if (!promotionReport || !output || !argv.includes("--execute")) {
    throw new Error("--promotion-report, --report and --execute are required");
  }
  const raw = JSON.parse(await fs.readFile(resolve(promotionReport), "utf8")) as never;
  const plan = planAttachmentReferenceBackfill(raw);
  if (plan.status !== "planned") {
    await writeReport(resolve(output), {
      mappingVersion: "attachment-reference-backfill-v1",
      status: "quarantined",
      receipts: [],
      quarantine: plan.quarantine,
      counts: { planned: plan.references.length, committed: 0, replayed: 0, reconciled: 0, quarantined: plan.quarantine.length },
      storage: { database: "not_written", objectStore: "not_written" },
    });
    return 1;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const database = createDatabaseContext({ url: databaseUrl });
  try {
    const report = await backfillAttachmentReferences(database.prisma, plan);
    await writeReport(resolve(output), report);
    console.log(JSON.stringify({ status: report.status, counts: report.counts }));
    return report.status === "completed" ? 0 : 1;
  } finally {
    await database.close();
  }
}

main().catch(async (error: unknown) => {
  const output = optionValue(process.argv.slice(2), "--report");
  if (output) {
    try {
      await writeReport(resolve(output), { status: "failed", ...safeFailure(error) });
    } catch {
      // Keep the failure source-free if the report path itself is unavailable.
    }
  }
  console.error(`Attachment reference backfill failed: ${safeFailure(error).code}`);
  process.exitCode = 1;
});
