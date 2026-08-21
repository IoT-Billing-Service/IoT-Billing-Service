import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getRedis, setRedisClient, closeRedis } from '../../../src/database/redis.js';
import { Redis } from 'ioredis';

vi.mock('ioredis', () => {
  const RedisMock = vi.fn().mockImplementation(() => {
    return {
      on: vi.fn(),
      quit: vi.fn().mockResolvedValue('OK'),
      disconnect: vi.fn(),
    };
  });
  return { Redis: RedisMock, default: RedisMock };
});

vi.mock('../../../src/config/env.js', () => ({
  getEnv: vi.fn(() => ({ REDIS_URL: 'redis://localhost:6379' })),
}));

describe('redis client', () => {
  beforeEach(async () => {
    await closeRedis();
    vi.clearAllMocks();
  });

  it('should initialize redis client and return it', () => {
    const client = getRedis();
    expect(client).toBeDefined();
    expect(Redis).toHaveBeenCalledWith('redis://localhost:6379', expect.any(Object));
  });

  it('should return cached client on subsequent calls', () => {
    const client1 = getRedis();
    const client2 = getRedis();
    expect(client1).toBe(client2);
    expect(Redis).toHaveBeenCalledTimes(1);
  });

  it('should allow setting a custom redis client', () => {
    const customClient = {
      on: vi.fn(),
      quit: vi.fn().mockResolvedValue('OK'),
      disconnect: vi.fn(),
    } as unknown as Redis;
    setRedisClient(customClient);
    expect(getRedis()).toBe(customClient);
  });

  it('should close the redis client', async () => {
    const client = getRedis();
    await closeRedis();
    expect(client.quit).toHaveBeenCalled();
  });

  it('should disconnect if quit throws', async () => {
    const client = getRedis();
    client.quit = vi.fn().mockRejectedValue(new Error('quit error'));
    await closeRedis();
    expect(client.disconnect).toHaveBeenCalled();
  });
});
