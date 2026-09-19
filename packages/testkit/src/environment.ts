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

/** Object storage credentials are supplied only by the owned process manifest. */
export interface TestObjectStorageIdentity {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
  readonly pid: number;
}
export function requireTestObjectStorage(identity: TestObjectStorageIdentity, runToken: string): TestObjectStorageIdentity {
  let endpoint: URL;
  try { endpoint = new URL(identity.endpoint); } catch { throw new Error('TEST_S3_GUARD: invalid endpoint'); }
  if (!/^[a-f0-9]{32}$/.test(runToken) || endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' ||
      !/^\d+$/.test(endpoint.port) || Number(endpoint.port) <= 1024 || Number(endpoint.port) > 65535 ||
      endpoint.pathname !== '/' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password ||
      identity.bucket !== `test-s3-${runToken}` || identity.region !== 'us-east-1' ||
      !/^test_[a-f0-9]{24}$/.test(identity.accessKeyId) || !/^[a-f0-9]{48}$/.test(identity.secretAccessKey) ||
      !Number.isSafeInteger(identity.pid) || identity.pid <= 0) {
    throw new Error('TEST_S3_GUARD: rejected object storage identity');
  }
  return identity;
}
