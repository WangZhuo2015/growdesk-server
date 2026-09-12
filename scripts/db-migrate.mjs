import { execSync } from "node:child_process";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required to deploy migrations.");
    process.exit(1);
  }

  console.log("Applying database migrations with Prisma...");
  try {
    execSync("npx prisma migrate deploy", { stdio: "inherit" });
    console.log("Database migrations applied successfully.");
  } catch {
    console.error("Database migration deploy failed.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Migration error:", err);
  process.exit(1);
});
