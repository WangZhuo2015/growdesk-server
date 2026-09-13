import { test } from 'node:test';
import { buildApiApp } from '../../apps/api/src/app.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import pg from 'pg';
import { Redis } from 'ioredis';
import { requireTestDatabaseUrl } from '../../packages/testkit/src/environment.js';

interface OwnedRun { directory: string; token: string; database: string; user: string; password: string; pgPort: number; redisPort: number }
function readRun(): OwnedRun {
  const file = process.env.BOOT02_RUN_FILE;
  if (!file) throw new Error('Integration tests require the managed test runner');
  const real = fs.realpathSync(file);
  const parent = path.dirname(real);
  if (path.dirname(parent) !== fs.realpathSync(os.tmpdir()) || !path.basename(parent).startsWith('growdesk-integration-')) {
    throw new Error('Integration manifest is outside its private run');
  }
  const stat = fs.statSync(real);
  if (stat.uid !== process.getuid?.() || stat.mode & 0o077) throw new Error('Unsafe manifest permissions');
  const directoryStat = fs.statSync(parent);
  if (!directoryStat.isDirectory() || directoryStat.uid !== stat.uid || directoryStat.mode & 0o077) {
    throw new Error('Unsafe run directory permissions');
  }
  const run = JSON.parse(fs.readFileSync(real,'utf8')) as OwnedRun;
  if (run.directory !== parent || !/^[a-f0-9]{32}$/.test(run.token) ||
      !/^[a-f0-9]{48}$/.test(run.password) || run.database !== 'test_growdesk_integration' ||
      run.user !== 'test_runner' || !Number.isInteger(run.pgPort) ||
      !Number.isInteger(run.redisPort) || run.pgPort < 1025 || run.pgPort > 65535 ||
      run.redisPort < 1025 || run.redisPort > 65535 || run.redisPort === 6379 ||
      run.pgPort === run.redisPort) throw new Error('Invalid instance identity');
  return run;
}

test('isolated PostgreSQL enforces role, ownership, constraints and rollback', async () => {
  const run = readRun();
  const identity = { host: '127.0.0.1' as const, port: run.pgPort, database: run.database, role: run.user, password: run.password };
  const url = requireTestDatabaseUrl(`postgresql://${run.user}:${run.password}@127.0.0.1:${run.pgPort}/${run.database}?sslmode=disable`,identity);
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 3000 });
  try {
    const client = await pool.connect();
    try {
      const { rows } = await client.query(`SELECT current_user AS role, current_database() AS db,
        current_setting('cluster_name') AS token, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`);
      assert.equal(rows[0]?.role,run.user);assert.equal(rows[0]?.db,run.database);
      assert.ok(rows[0]?.token === run.token, 'PostgreSQL instance identity mismatch');
      assert.equal(rows[0]?.superuser,false);
      await client.query('CREATE TABLE test_records(id text PRIMARY KEY, owner_id text NOT NULL)');
      await client.query('BEGIN');
      await client.query("INSERT INTO test_records VALUES ('test_record_1', 'test_user_1')");
      await client.query('ROLLBACK');
      assert.equal((await client.query('SELECT count(*)::int AS count FROM test_records')).rows[0]?.count,0);
      await client.query("INSERT INTO test_records VALUES ('test_record_2', 'test_user_2')");
      await assert.rejects(client.query("INSERT INTO test_records VALUES ('test_record_2', 'test_user_2')"),
        (error: { code?: string }) => error.code === '23505');
    } finally { client.release(); }
  } finally { await pool.end(); }
});

test('isolated authenticated Redis has working expiry and atomic NX writes', async () => {
  const run = readRun();
  const redis = new Redis({ host: '127.0.0.1', port: run.redisPort, password: run.password,
    retryStrategy: () => null, maxRetriesPerRequest: 1, connectTimeout: 3000 });
  const key = `test_${run.token}:lease`;
  try {
    assert.equal(await redis.set(key,'test_owner','PX',10000,'NX'),'OK');
    assert.equal(await redis.set(key,'test_other','PX',10000,'NX'),null);
    assert.equal(await redis.get(key),'test_owner');
    assert.ok(await redis.pttl(key) > 0);
  } finally { redis.disconnect(); }
});


test('foundation HTTP readiness checks owned PostgreSQL and Redis with real drivers', async () => {
  const run = readRun();
  const identity = { host: '127.0.0.1' as const, port: run.pgPort, database: run.database, role: run.user, password: run.password };
  const databaseUrl = requireTestDatabaseUrl(`postgresql://${run.user}:${run.password}@127.0.0.1:${run.pgPort}/${run.database}?sslmode=disable`, identity);
  // Prove the target is the cluster created by our runner before constructing
  // runtime probes; an address/name convention alone is not ownership proof.
  const guard = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 });
  try {
    const { rows } = await guard.query("SELECT current_user AS role, current_database() AS db, current_setting('cluster_name') AS token");
    assert.equal(rows[0]?.role, run.user);
    assert.equal(rows[0]?.db, run.database);
    assert.ok(rows[0]?.token === run.token, 'PostgreSQL instance identity mismatch');
  } finally { await guard.end(); }

  const redisUrl = `redis://:${run.password}@127.0.0.1:${run.redisPort}/0`;
  const app = buildApiApp({ databaseUrl, redisUrl });
  try {
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'ok', service: 'growdesk-api', stage: 'foundation',
      dependencies: { postgres: 'ok', redis: 'ok' },
    });
    assert.equal((await fetch(`${origin}/health/live`)).status, 200);
    assert.equal((await fetch(`${origin}/api/v1/babies`)).status, 404);
  } finally { await app.close(); }

  const degraded = buildApiApp({ databaseUrl, redisUrl: `redis://:test_wrong_password@127.0.0.1:${run.redisPort}/0` });
  try {
    const response = await degraded.inject({ method: 'GET', url: '/health/ready' });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json().dependencies, { postgres: 'ok', redis: 'unavailable' });
    assert.equal((await degraded.inject({ method: 'GET', url: '/health/live' })).statusCode, 200);
    assert.ok(!response.body.includes(run.password));
    assert.ok(!response.body.includes('127.0.0.1'));
  } finally { await degraded.close(); }
});
