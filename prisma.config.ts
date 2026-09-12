import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Prisma CLI resolves this URL, but migration validation below uses only a
    // fake loopback URL and never opens a production connection.
    url: env("DATABASE_URL"),
  },
});
