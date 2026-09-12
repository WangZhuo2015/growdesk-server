import type { Redis } from "ioredis";

export interface ReplayPayload {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly rotationId: string;
}

export class ReplayStore {
  private readonly memoryCache = new Map<string, { payload: ReplayPayload; expiresAt: number }>();
  private readonly redis?: Redis;

  constructor(redis?: Redis) {
    this.redis = redis;
  }

  async saveReplay(key: string, payload: ReplayPayload, ttlSeconds = 60): Promise<void> {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.memoryCache.set(key, { payload, expiresAt });
    if (this.redis) {
      try {
        await this.redis.set(key, JSON.stringify(payload), "EX", ttlSeconds);
      } catch {
        // Safe fallback to in-memory store
      }
    }
  }

  async getReplay(key: string): Promise<ReplayPayload | null> {
    if (this.redis) {
      try {
        const raw = await this.redis.get(key);
        if (raw) {
          return JSON.parse(raw) as ReplayPayload;
        }
      } catch {
        // Fall back to memoryCache
      }
    }

    const item = this.memoryCache.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      this.memoryCache.delete(key);
      return null;
    }
    return item.payload;
  }
}
