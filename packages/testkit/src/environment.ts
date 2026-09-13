/** Pure preconnection guard for isolated test runners; never reads .env. */
export interface TestConnectionIdentity {
  readonly host: '127.0.0.1'; readonly port: number; readonly database: string;
  readonly role: string; readonly password: string;
}
export function requireTestDatabaseUrl(raw: string, identity: TestConnectionIdentity): string {
  if (identity.host !== '127.0.0.1' || !Number.isSafeInteger(identity.port) || identity.port <= 1024 || identity.port > 65535 ||
      !/^test_[a-z0-9_]+$/.test(identity.database) || !/^test_[a-z0-9_]+$/.test(identity.role) || !identity.password) {
    throw new Error('TEST_DATABASE_GUARD: invalid runner identity');
  }
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('TEST_DATABASE_GUARD: invalid connection URL'); }
  if (url.protocol !== 'postgresql:' || url.hostname !== identity.host || url.port !== String(identity.port) ||
      url.pathname !== `/${identity.database}` || url.username !== identity.role ||
      url.password !== encodeURIComponent(identity.password) || url.hash ||
      [...url.searchParams].some(([key, value]) => key !== 'sslmode' || value !== 'disable')) {
    throw new Error('TEST_DATABASE_GUARD: rejected connection identity');
  }
  return raw;
}
