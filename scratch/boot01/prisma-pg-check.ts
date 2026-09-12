import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '@prisma/client';
import { readTestEnvironment, databaseUrl } from './test-environment.js';

async function runPrismaPgCheck() {
  const env = readTestEnvironment();
  const connectionString = databaseUrl(env);
  console.log('Connecting to owned PostgreSQL test instance (credentials omitted)');
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000 });
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(`SELECT current_database() AS db, current_user AS role,
        current_setting('cluster_name') AS token, current_setting('server_version_num') AS version,
        (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser`);
      const row = result.rows[0];
      if (row.db !== env.database || row.role !== env.user || row.token !== env.token ||
          row.superuser || Math.floor(Number(row.version) / 10000) !== 18) {
        throw new Error('Guard: server identity mismatch before DDL');
      }
      await client.query(`CREATE TABLE test_boot01_records (
        id TEXT PRIMARY KEY, family_id TEXT NOT NULL, version INT NOT NULL,
        payload JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_family_version UNIQUE(family_id, version)
      )`);
    } finally { client.release(); }
    // 4. Instantiate PrismaClient with PrismaPg adapter
    console.log("Initializing PrismaClient with @prisma/adapter-pg...");
    const adapter = new PrismaPg(pool);
    const prisma = new PrismaClient({ adapter });

    try {
      // 5. Test Transaction Commit via prisma.$transaction
      console.log("Executing transaction commit test with prisma.$transaction...");
      const committedRecord = await prisma.$transaction(async (tx) => {
        return await tx.testBoot01Record.create({
          data: {
            id: "rec_prisma_01",
            familyId: "test_family_01",
            version: 1,
            payload: { height: 75.0, source: "prisma_adapter_pg" },
          },
        });
      });

      if (!committedRecord || committedRecord.id !== "rec_prisma_01") {
        throw new Error("Failed to create record inside prisma.$transaction");
      }

      const fetched = await prisma.testBoot01Record.findUnique({
        where: { id: "rec_prisma_01" },
      });
      if (!fetched) {
        throw new Error("Could not find committed record via prisma.findUnique");
      }
      console.log("Prisma 7 adapter-pg Transaction Commit: PASSED");

      // 6. Test Unique Constraint Violation (P2002) via Prisma
      console.log("Executing unique constraint violation test via Prisma...");
      let caughtP2002 = false;
      try {
        await prisma.testBoot01Record.create({
          data: {
            id: "rec_prisma_duplicate",
            familyId: "test_family_01",
            version: 1, // Duplicate (familyId, version)
            payload: { height: 76.0 },
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          caughtP2002 = true;
          console.log(`Successfully caught expected Prisma P2002 error: ${err.message.split("\n")[0]}`);
        } else {
          throw new Error("Expected PrismaClientKnownRequestError P2002");
        }
      }
      if (!caughtP2002) {
        throw new Error("Expected P2002 unique constraint error but insert succeeded!");
      }
      console.log("Prisma 7 adapter-pg Unique Constraint Enforcement (P2002): PASSED");

      // 7. Test Transaction Rollback via prisma.$transaction
      console.log("Executing transaction rollback test via prisma.$transaction...");
      let rollbackErrorCaught = false;
      try {
        await prisma.$transaction(async (tx) => {
          await tx.testBoot01Record.create({
            data: {
              id: "rec_prisma_rollback",
              familyId: "test_family_01",
              version: 2,
              payload: { height: 77.0 },
            },
          });
          throw new Error("Intentional error to trigger rollback");
        });
      } catch (err) {
        if (err instanceof Error && err.message === "Intentional error to trigger rollback") {
          rollbackErrorCaught = true;
        } else {
          throw err;
        }
      }
      if (!rollbackErrorCaught) {
        throw new Error("Rollback error was not thrown as expected");
      }

      const checkRollback = await prisma.testBoot01Record.findUnique({
        where: { id: "rec_prisma_rollback" },
      });
      if (checkRollback !== null) {
        throw new Error("Record was committed despite transaction error rollback!");
      }
      console.log("Prisma 7 adapter-pg Transaction Rollback: PASSED");

      console.log("Prisma 7 + @prisma/adapter-pg + PG 18 Check: ALL PASSED!");
    } finally {
      await prisma.$disconnect();
    }

  } finally { await pool.end(); }
}
runPrismaPgCheck().catch(() => {
  console.error('Prisma/PG verification failed; connection details suppressed');
  process.exitCode = 1;
});
