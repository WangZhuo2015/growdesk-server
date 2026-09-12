import { execSync } from "node:child_process";

try {
  execSync("npx prisma generate", { stdio: "inherit" });
  console.log("Database client generation complete.");
} catch {
  console.error("Database client generation failed.");
  process.exit(1);
}
