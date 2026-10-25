import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export type StorageDriverType = 'local_disk' | 's3_compatible';

export interface AppEnv {
  PORT: number;
  HOST: string;
  NODE_ENV: string;
  DATA_SOURCE_MODE: 'mock_json' | 'laravel_api';
  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_PASSWORD?: string;
  REDIS_DB: number;
  LIVEKIT_URL: string;
  LIVEKIT_API_KEY: string;
  LIVEKIT_API_SECRET: string;
  LIVEKIT_PUBLIC_URL: string;
  TEACHER_GRACE_TIMEOUT_SECONDS: number;
  CHECKPOINT_INTERVAL_SECONDS: number;
  LARAVEL_API_BASE_URL: string;
  LARAVEL_INTERNAL_API_SECRET: string;
  // Unified Cloud-Agnostic Storage Adapter Configuration (Cloudflare R2 <-> AWS S3 <-> Local Disk)
  STORAGE_DRIVER: StorageDriverType;
  STORAGE_ENDPOINT?: string;
  STORAGE_REGION: string;
  STORAGE_BUCKET: string;
  STORAGE_ACCESS_KEY_ID?: string;
  STORAGE_SECRET_ACCESS_KEY?: string;
  STORAGE_PUBLIC_CDN_URL?: string;
  STORAGE_CACHE_DIR: string;
  // Legacy R2 aliases preserved for backward compatibility
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME: string;
  R2_ENDPOINT?: string;
}

const resolvedEndpoint =
  process.env.STORAGE_ENDPOINT !== undefined
    ? process.env.STORAGE_ENDPOINT.trim() || undefined
    : process.env.R2_ENDPOINT?.trim() ||
      (process.env.R2_ACCOUNT_ID?.trim()
        ? `https://${process.env.R2_ACCOUNT_ID.trim()}.r2.cloudflarestorage.com`
        : undefined);

const resolvedRegion =
  process.env.STORAGE_REGION?.trim() || (resolvedEndpoint ? 'auto' : 'ap-south-1');

const resolvedBucket =
  process.env.STORAGE_BUCKET?.trim() || process.env.R2_BUCKET_NAME?.trim() || 'broadcast-sessions';

export const env: AppEnv = {
  PORT: parseInt(process.env.PORT || '4000', 10),
  HOST: process.env.HOST || '0.0.0.0',
  NODE_ENV: process.env.NODE_ENV || 'development',
  DATA_SOURCE_MODE: (process.env.DATA_SOURCE_MODE as 'mock_json' | 'laravel_api') || 'mock_json',
  REDIS_HOST: process.env.REDIS_HOST || '127.0.0.1',
  REDIS_PORT: parseInt(process.env.REDIS_PORT || '6379', 10),
  REDIS_PASSWORD: process.env.REDIS_PASSWORD || undefined,
  REDIS_DB: parseInt(process.env.REDIS_DB || '0', 10),
  LIVEKIT_URL: process.env.LIVEKIT_URL || 'http://127.0.0.1:7880',
  LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY || 'devkey',
  LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET || 'secret',
  LIVEKIT_PUBLIC_URL: process.env.LIVEKIT_PUBLIC_URL || 'ws://127.0.0.1:7880',
  TEACHER_GRACE_TIMEOUT_SECONDS: parseInt(process.env.TEACHER_GRACE_TIMEOUT_SECONDS || '300', 10),
  CHECKPOINT_INTERVAL_SECONDS: parseInt(process.env.CHECKPOINT_INTERVAL_SECONDS || '30', 10),
  LARAVEL_API_BASE_URL: process.env.LARAVEL_API_BASE_URL || 'http://127.0.0.1:8000',
  LARAVEL_INTERNAL_API_SECRET:
    process.env.LARAVEL_INTERNAL_API_SECRET ||
    process.env.BROADCAST_INTERNAL_SECRET ||
    'zerix_internal_broadcast_secret_2026',
  STORAGE_DRIVER:
    (process.env.STORAGE_DRIVER as StorageDriverType) === 's3_compatible'
      ? 's3_compatible'
      : 'local_disk',
  STORAGE_ENDPOINT: resolvedEndpoint,
  STORAGE_REGION: resolvedRegion,
  STORAGE_BUCKET: resolvedBucket,
  STORAGE_ACCESS_KEY_ID:
    process.env.STORAGE_ACCESS_KEY_ID?.trim() ||
    process.env.R2_ACCESS_KEY_ID?.trim() ||
    undefined,
  STORAGE_SECRET_ACCESS_KEY:
    process.env.STORAGE_SECRET_ACCESS_KEY?.trim() ||
    process.env.R2_SECRET_ACCESS_KEY?.trim() ||
    undefined,
  STORAGE_PUBLIC_CDN_URL: process.env.STORAGE_PUBLIC_CDN_URL?.trim() || undefined,
  STORAGE_CACHE_DIR:
    process.env.STORAGE_CACHE_DIR?.trim() ||
    path.resolve(__dirname, '../../../../storage_cache'),
  R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID || undefined,
  R2_ACCESS_KEY_ID:
    process.env.R2_ACCESS_KEY_ID || process.env.STORAGE_ACCESS_KEY_ID || undefined,
  R2_SECRET_ACCESS_KEY:
    process.env.R2_SECRET_ACCESS_KEY || process.env.STORAGE_SECRET_ACCESS_KEY || undefined,
  R2_BUCKET_NAME: resolvedBucket,
  R2_ENDPOINT: resolvedEndpoint,
};
