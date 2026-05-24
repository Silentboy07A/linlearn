// src/security/rateLimiter.ts
import { RateLimitExceededError } from "../lib/errors";

interface RateLimitRecord {
  timestamps: number[];
}

const limitStore = new Map<string, RateLimitRecord>();

export interface RateLimiterConfig {
  limit: number;
  windowMs: number;
}

export class RateLimiter {
  public static check(key: string, config: RateLimiterConfig): void {
    const now = Date.now();
    const windowStart = now - config.windowMs;

    let record = limitStore.get(key);
    if (!record) {
      record = { timestamps: [] };
      limitStore.set(key, record);
    }

    record.timestamps = record.timestamps.filter((ts) => ts > windowStart);

    if (record.timestamps.length >= config.limit) {
      throw new RateLimitExceededError(`Rate limit exceeded. Max ${config.limit} requests per ${config.windowMs / 1000}s.`);
    }

    record.timestamps.push(now);
  }

  public static reset(key: string): void {
    limitStore.delete(key);
  }

  public static prune(): void {
    const now = Date.now();
    limitStore.forEach((record, key) => {
      const freshest = record.timestamps[record.timestamps.length - 1];
      if (!freshest || now - freshest > 60 * 60 * 1000) {
        limitStore.delete(key);
      }
    });
  }
}
