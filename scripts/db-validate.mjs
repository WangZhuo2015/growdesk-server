import { execSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";

async function main() {
  console.log("Validating Prisma schema...");
  try {
    execSync("npx prisma validate", { stdio: "inherit" });
  } catch {
    console.error("Prisma schema validation failed.");
    process.exit(1);
  }

  console.log("Verifying migration directory integrity...");
  const migrationsDir = path.resolve("prisma/migrations");
  const entries = await fsp.readdir(migrationsDir, { withFileTypes: true });

  const migrationFolders = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  if (migrationFolders.length === 0) {
    console.error("No migrations found in prisma/migrations.");
    process.exit(1);
  }

  for (const folder of migrationFolders) {
    const sqlPath = path.join(migrationsDir, folder, "migration.sql");
    try {
      const stat = await fsp.stat(sqlPath);
      if (stat.size === 0) {
        console.error(`Migration ${folder}/migration.sql is empty.`);
        process.exit(1);
      }
    } catch {
      console.error(`Missing migration.sql in ${folder}.`);
      process.exit(1);
    }
  }

  const lockPath = path.join(migrationsDir, "migration_lock.toml");
  try {
    const lockStat = await fsp.stat(lockPath);
    if (lockStat.size === 0) {
      console.error("migration_lock.toml is empty.");
      process.exit(1);
    }
  } catch {
    console.error("Missing migration_lock.toml in prisma/migrations.");
    process.exit(1);
  }

  console.log(`Database validation passed: ${migrationFolders.length} migrations verified.`);
}

main().catch((err) => {
  console.error("Database validation failed:", err);
  process.exit(1);
});
