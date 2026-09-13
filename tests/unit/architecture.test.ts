import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { findArchitectureViolations } from "../../scripts/architecture-rules.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("backend import boundaries are enforced", () => {
  execFileSync(process.execPath, [path.join(root, "scripts/check-architecture.mjs")], {
    cwd: root,
    stdio: "pipe",
  });
});

test("architecture rules catch package subpaths and relative boundary bypasses", () => {
  assert.deepEqual(
    findArchitectureViolations("packages/domain/src/leak.ts", 'import { PrismaClient } from "@prisma/client";'),
    ["packages/domain/src/leak.ts: domain imports forbidden module @prisma/client"],
  );
  assert.deepEqual(
    findArchitectureViolations("packages/contracts/src/leak.ts", 'export * from "../../database/src/index.js";'),
    ["packages/contracts/src/leak.ts: contracts reaches another layer through ../../database/src/index.js"],
  );
  assert.deepEqual(
    findArchitectureViolations("packages/domain/src/leak.ts", "export const value: any = 1;"),
    ["packages/domain/src/leak.ts: unbounded any crosses a package boundary"],
  );
});
