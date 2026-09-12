import { defineConfig } from "prisma/config";

// Prisma CLI resolves this URL, but migration validation and client generation
// use only a safe loopback URL when DATABASE_URL is not set.
const url = process.env.DATABASE_URL || "postgresql://test_runner:dummy@127.0.0.1:5433/test_growdesk";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url,
  },
});

