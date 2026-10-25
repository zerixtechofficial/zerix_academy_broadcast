import { Redis, RedisOptions } from 'ioredis';
import { env } from './env';

const redisOptions: RedisOptions = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD || undefined,
  db: env.REDIS_DB,
  retryStrategy: (times: number) => {
    const delay = Math.min(times * 100, 3000);
    return delay;
  },
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

export const redis = new Redis(redisOptions);

export const createRedisClient = (customName = 'client'): Redis => {
  const client = new Redis(redisOptions);
  client.on('error', (err) => {
    console.error(`[Redis:${customName}] Connection error:`, err.message);
  });
  return client;
};

export const pubClient = createRedisClient('pub');
export const subClient = createRedisClient('sub');

redis.on('connect', () => {
  console.log(`[Redis] Connected to ${env.REDIS_HOST}:${env.REDIS_PORT} (DB: ${env.REDIS_DB})`);
});

redis.on('error', (err) => {
  console.error('[Redis] Main client error:', err.message);
});
