import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findArchitectureViolations } from "./architecture-rules.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = ["apps", "packages"].map((relative) => path.join(root, relative));

async function tsFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build" || entry.name === "generated") continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await tsFiles(full));
    else if (entry.isFile() && full.endsWith(".ts")) files.push(full);
  }
  return files;
}

const allFiles = (await Promise.all(sourceRoots.map(tsFiles))).flat();
const violations = [];
for (const file of allFiles) {
  const relative = path.relative(root, file);
  const source = await fs.readFile(file, "utf8");
  violations.push(...findArchitectureViolations(relative, source));
}

if (violations.length > 0) {
  console.error("Architecture check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`Architecture check passed (${allFiles.length} TypeScript source files).`);
}
