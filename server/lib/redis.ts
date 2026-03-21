/**
 * Redis Client
 * 
 * Shared Redis connection for caching and rate limiting.
 * Gracefully degrades to no-op when Redis is unavailable.
 */

import Redis from 'ioredis';
import { config } from '../config';
import { createLogger } from './logger';

const logger = createLogger('redis');

let redisClient: Redis | null = null;
let isConnected = false;

/**
 * Get or create the Redis client singleton.
 * Returns null if Redis is not configured or unavailable.
 */
export function getRedisClient(): Redis | null {
  if (redisClient) return redisClient;

  try {
    redisClient = new Redis(config.redis.url, {
      keyPrefix: config.redis.keyPrefix,
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 5) {
          logger.warn('Redis max retries reached, stopping reconnection');
          return null; // stop retrying
        }
        return Math.min(times * 200, 2000);
      },
      lazyConnect: true,
      enableReadyCheck: true,
      connectTimeout: 5000,
    });

    redisClient.on('connect', () => {
      isConnected = true;
      logger.info('Redis connected');
    });

    redisClient.on('ready', () => {
      isConnected = true;
      logger.info('Redis ready');
    });

    redisClient.on('error', (err) => {
      isConnected = false;
      logger.warn({ err: err.message }, 'Redis error');
    });

    redisClient.on('close', () => {
      isConnected = false;
      logger.info('Redis connection closed');
    });

    // Connect asynchronously — don't block server startup
    redisClient.connect().catch((err) => {
      logger.warn({ err: err.message }, 'Redis initial connection failed — caching disabled');
      isConnected = false;
    });

    return redisClient;
  } catch (err) {
    logger.warn({ err }, 'Failed to create Redis client');
    return null;
  }
}

/**
 * Check if Redis is connected and available
 */
export function isRedisAvailable(): boolean {
  return isConnected && redisClient !== null;
}

/**
 * Gracefully close the Redis connection
 */
export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    isConnected = false;
    logger.info('Redis connection closed gracefully');
  }
}

// ============================================
// CACHE HELPERS
// ============================================

/**
 * Get a cached value by key. Returns null on miss or error.
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!isRedisAvailable() || !redisClient) return null;

  try {
    const value = await redisClient.get(key);
    if (!value) return null;
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/**
 * Set a cached value with TTL in seconds.
 */
export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (!isRedisAvailable() || !redisClient) return;

  try {
    await redisClient.setex(key, ttlSeconds, JSON.stringify(value));
  } catch {
    // Cache write failure is non-critical
  }
}

/**
 * Delete cached entries matching a pattern (e.g. "wallet:*").
 * Uses SCAN to avoid blocking Redis.
 */
export async function cacheInvalidate(pattern: string): Promise<void> {
  if (!isRedisAvailable() || !redisClient) return;

  try {
    const fullPattern = `${config.redis.keyPrefix}${pattern}`;
    const stream = redisClient.scanStream({ match: fullPattern, count: 100 });
    const pipeline = redisClient.pipeline();
    let count = 0;

    for await (const keys of stream) {
      for (const key of keys as string[]) {
        // Remove the prefix since ioredis adds it automatically on get/set
        const unprefixed = key.startsWith(config.redis.keyPrefix)
          ? key.slice(config.redis.keyPrefix.length)
          : key;
        pipeline.del(unprefixed);
        count++;
      }
    }

    if (count > 0) {
      await pipeline.exec();
      logger.debug({ pattern, count }, 'Cache invalidated');
    }
  } catch {
    // Invalidation failure is non-critical
  }
}

/**
 * Delete a single cache key
 */
export async function cacheDel(key: string): Promise<void> {
  if (!isRedisAvailable() || !redisClient) return;

  try {
    await redisClient.del(key);
  } catch {
    // Deletion failure is non-critical
  }
}
