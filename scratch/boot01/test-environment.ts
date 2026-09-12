import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface TestEnvironment {
  token: string; directory: string; pgPort: number; redisPort: number;
  database: string; user: string; password: string;
}
export function readTestEnvironment(): TestEnvironment {
  const file = process.env.BOOT01_ENV_FILE;
  if (!file) throw new Error('Guard: run through infra-test-env.sh run');
  const real = fs.realpathSync(file);
  const dir = path.dirname(real);
  if (path.dirname(dir) !== fs.realpathSync(os.tmpdir()) || !path.basename(dir).startsWith('growdesk-boot01-')) {
    throw new Error('Guard: environment must belong to a private temporary run');
  }
  const stat = fs.statSync(real);
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error('Guard: unsafe environment permissions');
  const env = JSON.parse(fs.readFileSync(real, 'utf8')) as TestEnvironment;
  if (env.directory !== dir || !/^[a-f0-9]{32}$/.test(env.token) ||
      env.database !== 'test_growdesk_boot01' || env.user !== 'test_boot01' ||
      !/^[a-f0-9]{48}$/.test(env.password) ||
      ![env.pgPort, env.redisPort].every(p => Number.isInteger(p) && p > 1024 && p <= 65535) || env.pgPort === env.redisPort) {
    throw new Error('Guard: invalid run identity');
  }
  const pid = fs.readFileSync(path.join(dir, 'pg', 'postmaster.pid'), 'utf8').split('\n');
  if (pid[1] !== path.join(dir, 'pg') || Number(pid[3]) !== env.pgPort || !/^\d+$/.test(pid[0])) {
    throw new Error('Guard: PostgreSQL PID manifest does not match this run');
  }
  process.kill(Number(pid[0]), 0);
  return env;
}
export function verifyDatabaseUrl(raw: string, env: TestEnvironment): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error('Guard: malformed database URL'); }
  if (u.protocol !== 'postgresql:' || u.hostname !== '127.0.0.1' || u.port !== String(env.pgPort) ||
      u.pathname !== `/${env.database}` || u.username !== env.user || u.password !== env.password || u.hash ||
      [...u.searchParams].some(([k,v]) => k !== 'sslmode' || v !== 'disable')) {
    throw new Error('Guard: database URL does not match owned test instance');
  }
  return raw;
}
export function databaseUrl(env: TestEnvironment): string {
  return verifyDatabaseUrl(process.env.TEST_DATABASE_URL ??
    `postgresql://${env.user}:${env.password}@127.0.0.1:${env.pgPort}/${env.database}?sslmode=disable`, env);
}
