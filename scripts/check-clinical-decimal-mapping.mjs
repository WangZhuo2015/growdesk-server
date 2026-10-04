import { promises as fsp } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const schemaPath = path.resolve("prisma/schema.prisma");
const contractPath = path.resolve("packages/contracts/src/common.ts");
const migrationDir = path.resolve("prisma/migrations");
const migration033 = path.join(migrationDir, "202610040033_clinical_formula_decimal_precision", "migration.sql");

const fields = [
  ["FormulaProduct", "reconstitutionRatio", "reconstitution_ratio"],
  ["GrowthMeasurement", "weightKg", "weight_kg"],
  ["GrowthMeasurement", "heightCm", "height_cm"],
  ["GrowthMeasurement", "headCircumferenceCm", "head_circumference_cm"],
];

function fail(message) {
  console.error(`Clinical decimal mapping validation failed: ${message}`);
  process.exit(1);
}

const schema = await fsp.readFile(schemaPath, "utf8");
const contract = await fsp.readFile(contractPath, "utf8");
const migration = await fsp.readFile(migration033, "utf8");
const generatedDdl = execFileSync(process.execPath, [
  path.resolve("node_modules/prisma/build/index.js"),
  "migrate", "diff", "--from-empty", "--to-schema", schemaPath, "--script",
], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

if (!contract.includes(String.raw`DecimalString = Type.String({ pattern: "^-?\\d+(\\.\\d+)?$"`)) {
  fail("DecimalString pattern changed; review whether the accepted range or scale is now bounded");
}
if (!contract.includes("Arbitrary-precision decimal represented as string")) {
  fail("DecimalString no longer declares arbitrary precision");
}

for (const [model, field, column] of fields) {
  const modelMatch = schema.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`));
  if (!modelMatch) fail(`missing Prisma model ${model}`);
  const declaration = modelMatch[1].split("\n").find((line) => new RegExp(`^\\s*${field}\\s+Decimal\\?(?=\\s|$)`).test(line));
  if (!declaration || declaration.includes("@db.Decimal(")) {
    fail(`${model}.${field} must remain a Decimal client scalar without a bounded native Decimal(p,s) annotation`);
  }
  const generatedBoundedDecimal = new RegExp(`"${column}"\\s+DECIMAL\\(65,30\\)`, "i");
  if (!generatedBoundedDecimal.test(generatedDdl)) {
    fail(`Prisma Decimal default mapping changed for ${model}.${field}; re-audit migration 033 SQL override`);
  }
  const unboundedAlter = new RegExp(`ALTER\\s+COLUMN\\s+"${column}"\\s+TYPE\\s+NUMERIC\\s+USING`, "i");
  if (!unboundedAlter.test(migration)) fail(`migration 033 does not widen ${column} to unconstrained NUMERIC`);
}

const migrationEntries = (await fsp.readdir(migrationDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name > "202610040033_clinical_formula_decimal_precision")
  .sort((a, b) => a.name.localeCompare(b.name));
for (const entry of migrationEntries) {
  const sql = await fsp.readFile(path.join(migrationDir, entry.name, "migration.sql"), "utf8");
  for (const [, , column] of fields) {
    const boundedAlter = new RegExp(
      `ALTER\\s+COLUMN\\s+"${column}"\\s+(?:TYPE|SET\\s+DATA\\s+TYPE)\\s+(?:DECIMAL|NUMERIC)\\s*\\(`,
      "i",
    );
    if (boundedAlter.test(sql)) {
      fail(`${entry.name} reintroduces bounded precision/scale for ${column}`);
    }
  }
}

console.log("Unbounded clinical decimal mapping verified: Prisma 7 generates DECIMAL(65,30) for these client scalars; migration 033 overrides that with unbounded NUMERIC, and later migrations may not restore a typmod.");
