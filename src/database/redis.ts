import { Redis } from 'ioredis';
import { getEnv } from '../config/env.js';

let cached: Redis | null = null;

export function getRedis(): Redis {
  if (cached !== null) {
    return cached;
  }
  const env = getEnv();
  cached = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  cached.on('error', (err: Error) => {
    console.error('Redis client error:', err.message);
  });
  return cached;
}

export function setRedisClient(client: Redis): void {
  cached = client;
}

export async function closeRedis(): Promise<void> {
  if (cached === null) {
    return;
  }
  try {
    await cached.quit();
  } catch {
    cached.disconnect();
  }
  cached = null;
}
