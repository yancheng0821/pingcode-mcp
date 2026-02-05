import { logger } from '../utils/logger.js';
import { metrics } from '../utils/metrics.js';

interface CacheEntry<T> {
  value: T;
  expireAt: number;
}

/**
 * 简单的内存缓存
 */
class MemoryCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  async connect(): Promise<void> {
    // 启动定期清理过期数据
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60 * 1000); // 每分钟清理一次

    logger.info('Memory cache initialized');
  }

  async disconnect(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.store.clear();
    logger.info('Memory cache cleared');
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key) as CacheEntry<T> | undefined;

    if (!entry) {
      logger.debug({ key }, 'Cache miss');
      metrics.recordCacheMiss();
      return null;
    }

    if (Date.now() > entry.expireAt) {
      this.store.delete(key);
      logger.debug({ key }, 'Cache expired');
      metrics.recordCacheMiss();
      return null;
    }

    logger.debug({ key }, 'Cache hit');
    metrics.recordCacheHit();
    return entry.value;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const ttl = ttlSeconds || 3600; // 默认 1 小时
    const expireAt = Date.now() + ttl * 1000;

    this.store.set(key, { value, expireAt });
    logger.debug({ key, ttl }, 'Cache set');
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
    logger.debug({ key }, 'Cache delete');
  }

  async mget<T>(keys: string[]): Promise<Map<string, T>> {
    const result = new Map<string, T>();

    for (const key of keys) {
      const value = await this.get<T>(key);
      if (value !== null) {
        result.set(key, value);
      }
    }

    logger.debug({
      keysCount: keys.length,
      hitCount: result.size
    }, 'Cache mget');

    return result;
  }

  async mset<T>(entries: Array<{ key: string; value: T; ttl?: number }>): Promise<void> {
    for (const { key, value, ttl } of entries) {
      await this.set(key, value, ttl);
    }
    logger.debug({ count: entries.length }, 'Cache mset');
  }

  isConnected(): boolean {
    return true;
  }

  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expireAt) {
        this.store.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug({ cleaned }, 'Cache cleanup');
    }
  }
}

// Singleton instance
export const cache = new MemoryCache();

// Cache key helpers
export const CacheKeys = {
  usersList: () => 'users:list',
  user: (id: string) => `users:${id}`,
  workItem: (id: string) => `work_items:${id}`,
};
