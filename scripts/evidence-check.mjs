import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const taskIndex = process.argv.indexOf("--task");
const task = taskIndex >= 0 ? process.argv[taskIndex + 1] : undefined;
if (!task || !/^[A-Z0-9][A-Z0-9_-]*$/.test(task)) {
  console.error("Usage: npm run backend:evidence:check -- --task BOOT-02");
  process.exitCode = 2;
} else {
  const directory = path.join(root, "evidence", "tasks", task);
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    if (!files.includes("REPORT.md")) {
      throw new Error(`${directory}/REPORT.md is required`);
    }
    const suspicious = [];
    for (const file of files) {
      const content = await fs.readFile(path.join(directory, file), "utf8");
      if (/postgres(?:ql)?:\/\/[^\s/]+:[^\s@]+@/i.test(content) || /(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*[^<\s`]+/i.test(content)) {
        suspicious.push(file);
      }
    }
    if (suspicious.length > 0) {
      throw new Error(`possible secret material in evidence: ${suspicious.join(", ")}`);
    }
    console.log(`Evidence shape check passed for ${task} (${files.length} files).`);
  } catch (error) {
    console.error(`Evidence check failed for ${task}: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
}
