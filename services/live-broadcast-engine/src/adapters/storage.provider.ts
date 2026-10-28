import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import {
  S3Client,
  S3ClientConfig,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { StorageDriverType } from '../config/env';
import { FileCache } from '../utils/fileCache';
import {
  ExcalidrawWhiteboardArtifact,
  RelationalLessonContext,
  SessionSnapshot,
} from '../types/broadcast.types';
import { SessionAttendanceSummary } from '../types/attendance.types';

export interface VideoChunkAppendResult {
  sessionId: string;
  chunkIndex: number;
  bytesAppended: number;
  totalBytesWritten: number;
  chunksReceivedCount: number;
  nextExpectedChunkIndex: number;
  bufferedOutOfOrderCount: number;
  duplicateIgnored: boolean;
  videoKey: string;
  cachePath: string;
}

export interface VideoByteRangeStreamResult {
  found: boolean;
  statusCode: 200 | 206 | 302 | 404 | 416;
  headers: Record<string, string | number>;
  stream?: fs.ReadStream;
  redirectUrl?: string;
  totalSizeBytes: number;
  startByte?: number;
  endByte?: number;
}

interface SessionVideoRecordingState {
  sessionId: string;
  videoKey: string;
  cachePath: string;
  mirrorPath: string;
  mimeType: string;
  extension: 'webm' | 'mp4';
  nextExpectedChunkIndex: number;
  processedChunks: Set<number>;
  pendingChunks: Map<number, Buffer>;
  totalBytesWritten: number;
  startedAt: number;
  lastChunkAt: number;
  finalized: boolean;
  startingRelationalContext?: Partial<RelationalLessonContext>;
}

export interface StorageProviderConfig {
  driver: StorageDriverType;
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  publicCdnUrl?: string;
  cacheDir: string;
}

export interface StorageWriteResult {
  key: string;
  cachePath: string;
  publicUrl: string;
  driver: StorageDriverType;
  backend: 'local_disk' | 'cloudflare_r2' | 'aws_s3';
  syncedToCloud: boolean;
}

/**
 * Unified Cloud-Agnostic Storage Adapter (Cloudflare R2 <-> AWS S3 <-> Local Disk)
 *
 * Driven entirely by `.env` variables:
 * - `STORAGE_DRIVER=local_disk | s3_compatible`
 * - `STORAGE_ENDPOINT` (e.g. `https://<account>.r2.cloudflarestorage.com` for R2, or empty for AWS S3)
 * - `STORAGE_REGION` (e.g. `auto` for R2, or `ap-south-1` for AWS S3)
 * - `STORAGE_BUCKET`
 * - `STORAGE_ACCESS_KEY_ID`
 * - `STORAGE_SECRET_ACCESS_KEY`
 * - `STORAGE_PUBLIC_CDN_URL`
 *
 * Maintains a local file-cache mirror (`storage_cache/`) that automatically updates/invalidates
 * whenever session state changes, and serves as the default storage when `STORAGE_DRIVER=local_disk`.
 */
export class StorageProvider {
  private config: StorageProviderConfig;
  private s3Client: S3Client | null = null;
  private s3ClientConfigSnapshot: S3ClientConfig | null = null;
  private workspaceMirrorCacheDir: string;

  constructor(overrides?: Partial<StorageProviderConfig>) {
    this.config = StorageProvider.resolveConfigFromEnv(overrides);
    this.workspaceMirrorCacheDir = path.resolve(__dirname, '../../../../storage_cache');
    this.ensureCacheDirectories();
    if (this.config.driver === 's3_compatible') {
      this.initS3Client();
    }
  }

  /**
   * Resolves configuration dynamically from `process.env` (with optional overrides)
   * so switching between Local Disk, Cloudflare R2, and AWS S3 requires zero code changes.
   */
  public static resolveConfigFromEnv(
    overrides?: Partial<StorageProviderConfig>
  ): StorageProviderConfig {
    const rawDriver = (overrides?.driver || process.env.STORAGE_DRIVER || 'local_disk')
      .trim()
      .toLowerCase();
    const driver: StorageDriverType =
      rawDriver === 's3_compatible' ? 's3_compatible' : 'local_disk';

    const rawEndpoint =
      overrides?.endpoint !== undefined
        ? overrides.endpoint
        : process.env.STORAGE_ENDPOINT !== undefined
        ? process.env.STORAGE_ENDPOINT
        : process.env.R2_ENDPOINT ||
          (process.env.R2_ACCOUNT_ID?.trim()
            ? `https://${process.env.R2_ACCOUNT_ID.trim()}.r2.cloudflarestorage.com`
            : '');

    const endpoint = rawEndpoint && rawEndpoint.trim().length > 0 ? rawEndpoint.trim() : undefined;

    // When STORAGE_ENDPOINT is set to Cloudflare R2, default region to "auto".
    // When STORAGE_ENDPOINT is empty, use STORAGE_REGION (e.g. "ap-south-1") for native AWS S3.
    const rawRegion = (overrides?.region ?? process.env.STORAGE_REGION ?? '').trim();
    const region = rawRegion || (endpoint ? 'auto' : 'ap-south-1');

    const bucket =
      (
        overrides?.bucket ||
        process.env.STORAGE_BUCKET ||
        process.env.R2_BUCKET_NAME ||
        'broadcast-sessions'
      ).trim() || 'broadcast-sessions';

    const accessKeyId =
      (
        overrides?.accessKeyId ??
        process.env.STORAGE_ACCESS_KEY_ID ??
        process.env.R2_ACCESS_KEY_ID ??
        ''
      ).trim() || undefined;

    const secretAccessKey =
      (
        overrides?.secretAccessKey ??
        process.env.STORAGE_SECRET_ACCESS_KEY ??
        process.env.R2_SECRET_ACCESS_KEY ??
        ''
      ).trim() || undefined;

    const publicCdnUrl =
      (overrides?.publicCdnUrl ?? process.env.STORAGE_PUBLIC_CDN_URL ?? '')
        .trim()
        .replace(/\/+$/, '') || undefined;

    const cacheDir =
      overrides?.cacheDir ||
      process.env.STORAGE_CACHE_DIR?.trim() ||
      path.resolve(__dirname, '../../../../storage_cache');

    return {
      driver,
      endpoint,
      region,
      bucket,
      accessKeyId,
      secretAccessKey,
      publicCdnUrl,
      cacheDir: path.resolve(cacheDir),
    };
  }

  private ensureCacheDirectories(): void {
    try {
      if (!fs.existsSync(this.config.cacheDir)) {
        fs.mkdirSync(this.config.cacheDir, { recursive: true });
      }
      if (
        this.workspaceMirrorCacheDir !== this.config.cacheDir &&
        !fs.existsSync(this.workspaceMirrorCacheDir)
      ) {
        fs.mkdirSync(this.workspaceMirrorCacheDir, { recursive: true });
      }
    } catch {
      // Ignore directory pre-creation warnings if read-only mount
    }
  }

  /**
   * Initializes `@aws-sdk/client-s3` S3Client:
   * - If `STORAGE_ENDPOINT` is provided (e.g. `https://<account>.r2.cloudflarestorage.com`),
   *   connects to Cloudflare R2 (or custom S3-compatible endpoint) with `region: "auto"`.
   * - If `STORAGE_ENDPOINT` is empty and `STORAGE_REGION` is set (e.g. `ap-south-1`),
   *   omits custom `endpoint` so `@aws-sdk/client-s3` routes directly to AWS S3 (`ap-south-1`).
   */
  private initS3Client(): S3Client {
    const s3Config: S3ClientConfig = {
      region: this.config.region,
    };

    if (this.config.endpoint) {
      s3Config.endpoint = this.config.endpoint;
    }

    if (this.config.accessKeyId && this.config.secretAccessKey) {
      s3Config.credentials = {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      };
    }

    this.s3ClientConfigSnapshot = s3Config;
    this.s3Client = new S3Client(s3Config);
    return this.s3Client;
  }

  /**
   * Returns active storage backend classification (`local_disk`, `cloudflare_r2`, or `aws_s3`).
   */
  public getBackendType(): 'local_disk' | 'cloudflare_r2' | 'aws_s3' {
    if (this.config.driver === 'local_disk') {
      return 'local_disk';
    }
    if (this.config.endpoint) {
      return 'cloudflare_r2';
    }
    return 'aws_s3';
  }

  /**
   * Returns current resolved configuration & S3Client parameters for inspection/health checks.
   */
  public getConfig(): StorageProviderConfig & {
    backend: 'local_disk' | 'cloudflare_r2' | 'aws_s3';
    s3ClientConfig: S3ClientConfig | null;
  } {
    return {
      ...this.config,
      backend: this.getBackendType(),
      s3ClientConfig: this.s3ClientConfigSnapshot,
    };
  }

  public getS3Client(): S3Client | null {
    return this.s3Client;
  }

  /**
   * Sanitizes an object storage key into safe path segments, stripping any
   * raw or URL-encoded parent traversal (`..`, `%2e%2e`, backslashes, or null bytes).
   */
  private normalizeSafeObjectKey(key: string): string {
    let decoded = String(key || '').replace(/\0/g, '');
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // Ignore malformed percent-encoding and sanitize raw string below
    }
    const safeSegments = decoded
      .replace(/%2e/gi, '.')
      .replace(/%2f/gi, '/')
      .replace(/%5c/gi, '/')
      .split(/[\\/]+/)
      .map((seg) => seg.replace(/\.\.+/g, '').trim())
      .filter((seg) => seg.length > 0 && seg !== '.' && seg !== '..');

    return safeSegments.join('/');
  }

  /**
   * Normalizes an object key and resolves its local `storage_cache/` file path.
   */
  public resolveCachePath(key: string): string {
    const cleanKey = this.normalizeSafeObjectKey(key);
    return path.join(this.config.cacheDir, cleanKey);
  }

  private resolveWorkspaceMirrorPath(key: string): string {
    const cleanKey = this.normalizeSafeObjectKey(key);
    return path.join(this.workspaceMirrorCacheDir, cleanKey);
  }

  /**
   * Resolves public URL for an object key using `STORAGE_PUBLIC_CDN_URL`, S3/R2 URL, or local cache path.
   */
  public getPublicUrl(key: string): string {
    const cleanKey = this.normalizeSafeObjectKey(key);
    if (this.config.publicCdnUrl) {
      return `${this.config.publicCdnUrl}/${cleanKey}`;
    }
    if (this.config.driver === 's3_compatible') {
      if (this.config.endpoint) {
        return `${this.config.endpoint.replace(/\/+$/, '')}/${this.config.bucket}/${cleanKey}`;
      }
      return `https://${this.config.bucket}.s3.${this.config.region}.amazonaws.com/${cleanKey}`;
    }
    return `/storage_cache/${cleanKey}`;
  }

  /**
   * Invalidates local `FileCache` entry (and removes cached file if `removeFromDisk` is true)
   * whenever session state changes or a key is invalidated.
   */
  public async invalidateCache(key?: string, removeFromDisk = false): Promise<void> {
    if (!key) {
      FileCache.invalidate();
      return;
    }
    const cachePath = this.resolveCachePath(key);
    const mirrorPath = this.resolveWorkspaceMirrorPath(key);
    FileCache.invalidate(cachePath);
    if (mirrorPath !== cachePath) {
      FileCache.invalidate(mirrorPath);
    }

    if (removeFromDisk) {
      try {
        if (fs.existsSync(cachePath)) {
          await fs.promises.unlink(cachePath);
        }
        if (mirrorPath !== cachePath && fs.existsSync(mirrorPath)) {
          await fs.promises.unlink(mirrorPath);
        }
      } catch {
        // Ignore if concurrently removed
      }
    }
  }

  /**
   * Writes JSON to the local `storage_cache/` mirror (invalidating any stale cache entry first)
   * and, when `STORAGE_DRIVER=s3_compatible`, uploads to Cloudflare R2 or AWS S3 via `@aws-sdk/client-s3`.
   */
  public async putJson(key: string, data: any): Promise<StorageWriteResult> {
    const cleanKey = key.replace(/^\/+/, '');
    const cachePath = this.resolveCachePath(cleanKey);
    const mirrorPath = this.resolveWorkspaceMirrorPath(cleanKey);

    // 1. Invalidate stale cache & atomically write updated JSON to local storage_cache/ mirror
    FileCache.invalidate(cachePath);
    await FileCache.writeJson(cachePath, data);

    if (mirrorPath !== cachePath) {
      FileCache.invalidate(mirrorPath);
      await FileCache.writeJson(mirrorPath, data);
    }

    let syncedToCloud = false;

    // 2. If STORAGE_DRIVER=s3_compatible, upload to Cloudflare R2 or AWS S3
    if (this.config.driver === 's3_compatible') {
      const client = this.s3Client || this.initS3Client();
      if (this.config.accessKeyId && this.config.secretAccessKey) {
        try {
          const bodyString = JSON.stringify(data, null, 2);
          await client.send(
            new PutObjectCommand({
              Bucket: this.config.bucket,
              Key: cleanKey,
              Body: bodyString,
              ContentType: 'application/json',
            })
          );
          syncedToCloud = true;
        } catch (err: any) {
          console.warn(
            `[StorageProvider] Cloud upload warning (${this.getBackendType()}) for key "${cleanKey}" — local storage_cache/ mirror is up-to-date: ${err.message}`
          );
        }
      }
    }

    return {
      key: cleanKey,
      cachePath,
      publicUrl: this.getPublicUrl(cleanKey),
      driver: this.config.driver,
      backend: this.getBackendType(),
      syncedToCloud,
    };
  }

  /**
   * Reads JSON from the local `storage_cache/` mirror first, or falls back to fetching
   * from Cloudflare R2 / AWS S3 via `GetObjectCommand` and hydrating `storage_cache/`.
   */
  public async getJson<T>(
    key: string,
    options?: { bypassCache?: boolean }
  ): Promise<T | null> {
    const cleanKey = key.replace(/^\/+/, '');
    const cachePath = this.resolveCachePath(cleanKey);

    if (options?.bypassCache) {
      FileCache.invalidate(cachePath);
    } else if (fs.existsSync(cachePath)) {
      try {
        return await FileCache.readJson<T>(cachePath);
      } catch {
        FileCache.invalidate(cachePath);
      }
    }

    if (
      this.config.driver === 's3_compatible' &&
      this.config.accessKeyId &&
      this.config.secretAccessKey
    ) {
      const client = this.s3Client || this.initS3Client();
      try {
        const response = await client.send(
          new GetObjectCommand({
            Bucket: this.config.bucket,
            Key: cleanKey,
          })
        );
        if (response.Body) {
          const rawText = await response.Body.transformToString('utf-8');
          const parsed = JSON.parse(rawText) as T;
          await FileCache.writeJson(cachePath, parsed);
          const mirrorPath = this.resolveWorkspaceMirrorPath(cleanKey);
          if (mirrorPath !== cachePath) {
            await FileCache.writeJson(mirrorPath, parsed);
          }
          return parsed;
        }
      } catch {
        // Fallback to local cache if present
      }
    }

    if (fs.existsSync(cachePath)) {
      try {
        return await FileCache.readJson<T>(cachePath);
      } catch {
        return null;
      }
    }

    return null;
  }

  /**
   * Writes binary/raw object to `storage_cache/` and (if `s3_compatible`) to R2 / AWS S3.
   */
  public async putObject(
    key: string,
    body: Buffer | Uint8Array | string,
    contentType = 'application/octet-stream'
  ): Promise<StorageWriteResult> {
    const cleanKey = key.replace(/^\/+/, '');
    const cachePath = this.resolveCachePath(cleanKey);
    const mirrorPath = this.resolveWorkspaceMirrorPath(cleanKey);

    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
    FileCache.invalidate(cachePath);
    await fs.promises.writeFile(cachePath, body);

    if (mirrorPath !== cachePath) {
      const mirrorDir = path.dirname(mirrorPath);
      if (!fs.existsSync(mirrorDir)) {
        await fs.promises.mkdir(mirrorDir, { recursive: true });
      }
      FileCache.invalidate(mirrorPath);
      await fs.promises.writeFile(mirrorPath, body);
    }

    let syncedToCloud = false;
    if (
      this.config.driver === 's3_compatible' &&
      this.config.accessKeyId &&
      this.config.secretAccessKey
    ) {
      const client = this.s3Client || this.initS3Client();
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: this.config.bucket,
            Key: cleanKey,
            Body: body,
            ContentType: contentType,
          })
        );
        syncedToCloud = true;
      } catch (err: any) {
        console.warn(
          `[StorageProvider] Binary upload warning (${this.getBackendType()}) for "${cleanKey}": ${err.message}`
        );
      }
    }

    return {
      key: cleanKey,
      cachePath,
      publicUrl: this.getPublicUrl(cleanKey),
      driver: this.config.driver,
      backend: this.getBackendType(),
      syncedToCloud,
    };
  }

  /**
   * Deletes an object from `storage_cache/` and (if `s3_compatible`) from R2 / AWS S3.
   */
  public async deleteObject(key: string): Promise<void> {
    const cleanKey = key.replace(/^\/+/, '');
    await this.invalidateCache(cleanKey, true);

    if (
      this.config.driver === 's3_compatible' &&
      this.config.accessKeyId &&
      this.config.secretAccessKey
    ) {
      const client = this.s3Client || this.initS3Client();
      try {
        await client.send(
          new DeleteObjectCommand({
            Bucket: this.config.bucket,
            Key: cleanKey,
          })
        );
      } catch {
        // Ignore remote deletion errors
      }
    }
  }

  /**
   * Checks whether an object exists in `storage_cache/` or remote S3/R2 bucket.
   */
  public async exists(key: string): Promise<boolean> {
    const cleanKey = key.replace(/^\/+/, '');
    const cachePath = this.resolveCachePath(cleanKey);
    if (fs.existsSync(cachePath)) {
      return true;
    }

    if (
      this.config.driver === 's3_compatible' &&
      this.config.accessKeyId &&
      this.config.secretAccessKey
    ) {
      const client = this.s3Client || this.initS3Client();
      try {
        await client.send(
          new HeadObjectCommand({
            Bucket: this.config.bucket,
            Key: cleanKey,
          })
        );
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }

  /**
   * Automatically updates & invalidates the local `storage_cache/` mirror whenever session state changes.
   */
  public async syncSessionState(sessionId: string, snapshot: SessionSnapshot): Promise<void> {
    const stateKey = `sessions/${sessionId}/session_state.json`;
    const latestKey = `sessions/${sessionId}/autosave_latest.json`;

    const cachePathState = this.resolveCachePath(stateKey);
    const cachePathLatest = this.resolveCachePath(latestKey);
    const mirrorPathState = this.resolveWorkspaceMirrorPath(stateKey);
    const mirrorPathLatest = this.resolveWorkspaceMirrorPath(latestKey);

    const serialized = JSON.stringify(snapshot, null, 2);

    FileCache.invalidate(cachePathState);
    FileCache.invalidate(cachePathLatest);
    await FileCache.writeJson(cachePathState, snapshot, serialized);
    await FileCache.writeJson(cachePathLatest, snapshot, serialized);

    if (mirrorPathState !== cachePathState) {
      FileCache.invalidate(mirrorPathState);
      FileCache.invalidate(mirrorPathLatest);
      await FileCache.writeJson(mirrorPathState, snapshot, serialized);
      await FileCache.writeJson(mirrorPathLatest, snapshot, serialized);
    }
  }

  /**
   * Saves a session checkpoint to `storage_cache/` and (when `STORAGE_DRIVER=s3_compatible`) to R2 / AWS S3.
   * Automatically prunes old local checkpoint files so at most the latest 3 checkpoints are retained per session.
   */
  public async saveCheckpoint(sessionId: string, snapshot: SessionSnapshot): Promise<void> {
    const latestKey = `sessions/${sessionId}/autosave_latest.json`;
    const historyKey = `sessions/${sessionId}/checkpoints/checkpoint_${Date.now()}.json`;

    await this.putJson(latestKey, snapshot);
    await this.putJson(historyKey, snapshot);
    await this.syncSessionState(sessionId, snapshot);
    await this.pruneOldCheckpoints(this.resolveCachePath(`sessions/${sessionId}/checkpoints`), 3);
    const mirrorCheckpointsDir = this.resolveWorkspaceMirrorPath(`sessions/${sessionId}/checkpoints`);
    if (mirrorCheckpointsDir !== this.resolveCachePath(`sessions/${sessionId}/checkpoints`)) {
      await this.pruneOldCheckpoints(mirrorCheckpointsDir, 3);
    }
  }

  private async pruneOldCheckpoints(checkpointsDir: string, maxKeep = 3): Promise<void> {
    try {
      if (!fs.existsSync(checkpointsDir)) return;
      const files = (await fs.promises.readdir(checkpointsDir))
        .filter((f) => f.startsWith('checkpoint_') && f.endsWith('.json'))
        .sort();
      if (files.length <= maxKeep) return;
      const toDelete = files.slice(0, files.length - maxKeep);
      for (const file of toDelete) {
        const fullPath = path.join(checkpointsDir, file);
        FileCache.invalidate(fullPath);
        await fs.promises.unlink(fullPath).catch(() => {});
      }
    } catch {
      // Ignore cleanup race conditions
    }
  }

  /**
   * Saves finalized session attendance summary to `storage_cache/` and (when `STORAGE_DRIVER=s3_compatible`) to R2 / AWS S3.
   */
  public async saveSessionSummary(summary: SessionAttendanceSummary): Promise<void> {
    const summaryKey = `sessions/${summary.sessionId}/session_completed_summary.json`;
    await this.putJson(summaryKey, summary);
  }

  // ============================================================================
  // PHASE 1: DETERMINISTIC RELATIONAL STORAGE KEYS, CONTINUOUS 720p VIDEO CHUNK
  // ENGINE, GZIPPED WHITEBOARD ARTIFACTS & HTTP 206 BYTE-RANGE STREAMING
  // ============================================================================

  private videoRecordings = new Map<string, SessionVideoRecordingState>();
  private sessionMutexLocks = new Map<string, Promise<any>>();
  public static readonly MAX_PENDING_CHUNKS = 50;

  /**
   * Executes an async operation inside a per-session FIFO mutex lock so concurrent
   * jittered chunk uploads for the same `sessionId` never interleave or corrupt bytes.
   */
  private async withSessionLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.sessionMutexLocks.get(sessionId) || Promise.resolve();
    let releaseLock!: () => void;
    const currentLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const chainedLock = previous.then(() => currentLock).catch(() => currentLock);
    this.sessionMutexLocks.set(sessionId, chainedLock);

    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      releaseLock();
      if (this.sessionMutexLocks.get(sessionId) === chainedLock) {
        this.sessionMutexLocks.delete(sessionId);
      }
    }
  }

  /**
   * Converts numeric or alphanumeric IDs (e.g. `101`, `"101"`, `"chap_electricity"`, `"les_ohms_law"`)
   * into a deterministic positive integer (`>= 1`, never `NaN`).
   */
  public static toNumericId(value: unknown, fallback = 1): number {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length === 0) return fallback;
      if (/^\d+$/.test(trimmed)) {
        const parsed = Number(trimmed);
        if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
      }
      let hash = 2166136261;
      for (let i = 0; i < trimmed.length; i++) {
        hash ^= trimmed.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return ((hash >>> 0) % 900000) + 100000;
    }
    return fallback;
  }

  public static toNullableNumericId(value: unknown): number | null {
    if (value === null || value === undefined || value === '') {
      return null;
    }
    return this.toNumericId(value, 1);
  }

  /**
   * Normalizes a partial `RelationalLessonContext` with safe defaults so deterministic
   * storage paths are always generated consistently across Academic, Exam, and Skill courses.
   */
  public static normalizeRelationalContext(
    ctx: Partial<RelationalLessonContext> & { sessionId: string }
  ): RelationalLessonContext {
    const resolvedCourseId = this.toNumericId(ctx.courseId, 1);
    return {
      sessionId: ctx.sessionId,
      liveClassSessionId: ctx.liveClassSessionId ?? null,
      contextType: ctx.contextType || 'course_lesson',
      branchId: this.toNumericId(ctx.branchId, 1),
      batchId: this.toNumericId(ctx.batchId, 101),
      programId: ctx.programId ?? null,
      boardId: ctx.boardId !== undefined && ctx.boardId !== null ? this.toNumericId(ctx.boardId, 1) : null,
      examId: ctx.examId !== undefined && ctx.examId !== null ? this.toNumericId(ctx.examId, 1) : null,
      languageId: this.toNumericId(ctx.languageId, 1),
      courseId: resolvedCourseId,
      linkedVodCourseId:
        ctx.linkedVodCourseId !== undefined && ctx.linkedVodCourseId !== null
          ? this.toNumericId(ctx.linkedVodCourseId, resolvedCourseId)
          : resolvedCourseId,
      subjectId: ctx.subjectId !== undefined && ctx.subjectId !== null ? this.toNumericId(ctx.subjectId, 1) : 1,
      learningStageId: ctx.learningStageId ?? null,
      chapterId: this.toNumericId(ctx.chapterId, 1),
      chapterNumber: this.toNumericId(ctx.chapterNumber, 1),
      chapterTitle: ctx.chapterTitle || 'Chapter 1',
      lessonId: this.toNumericId(ctx.lessonId, 1),
      lessonNumber: String(ctx.lessonNumber ?? '1'),
      lessonTitle: ctx.lessonTitle || 'Lesson 1',
      topicId: ctx.topicId !== undefined ? this.toNullableNumericId(ctx.topicId) : null,
      topicTitle: ctx.topicTitle ?? undefined,
      assessmentId: ctx.assessmentId ?? null,
      teacherId: this.toNumericId(ctx.teacherId, 1),
      academicYear: this.toNumericId(ctx.academicYear, 2026),
      version: this.toNumericId(ctx.version, 1),
      publishToVodCourse: ctx.publishToVodCourse ?? true,
      isPrimaryVod: ctx.isPrimaryVod ?? true,
    };
  }

  /**
   * Builds the deterministic relational storage key for a lesson's 720p video artifact:
   * `courses/course_${courseId}/board_${boardId}_lang_${languageId}/ch_${chapterId}/lesson_${lessonId}/v${version}_${academicYear}/video_720p.${ext}`
   */
  public static buildLessonVideoKey(
    ctx: Partial<RelationalLessonContext> & { sessionId: string },
    extension: 'webm' | 'mp4' = 'webm'
  ): string {
    const norm = this.normalizeRelationalContext(ctx);
    const boardSegment = norm.boardId ?? norm.examId ?? 0;
    return `courses/course_${norm.courseId}/board_${boardSegment}_lang_${norm.languageId}/ch_${norm.chapterId}/lesson_${norm.lessonId}/v${norm.version}_${norm.academicYear}/video_720p.${extension}`;
  }

  /**
   * Builds the deterministic session-level storage key organized by Session, Course, and Language only
   * (no chapter, lesson, or topic segmentation required):
   * `sessions/session_${sessionId}/course_${courseId}/lang_${languageId}/video_720p.${ext}`
   */
  public static buildSessionCourseLanguageVideoKey(
    ctx: Partial<RelationalLessonContext> & { sessionId: string; languageCode?: string },
    extension: 'webm' | 'mp4' = 'webm'
  ): string {
    const norm = this.normalizeRelationalContext(ctx);
    const rawLang =
      ctx.languageCode ||
      (typeof ctx.languageId === 'string' &&
      String(ctx.languageId).trim().length > 0 &&
      !/^\d+$/.test(String(ctx.languageId).trim())
        ? String(ctx.languageId).trim().toLowerCase()
        : String(norm.languageId));
    const cleanSession = String(ctx.sessionId || norm.sessionId || 'default').replace(
      /[^a-zA-Z0-9_-]/g,
      '_'
    );
    const cleanLang = String(rawLang || '1').replace(/[^a-zA-Z0-9_-]/g, '_');
    return `sessions/session_${cleanSession}/course_${norm.courseId}/lang_${cleanLang}/video_720p.${extension}`;
  }

  /**
   * Builds the deterministic relational storage key for a continuous live session video:
   * `courses/course_${courseId}/board_${boardId}_lang_${languageId}/batch_${batchId}/session_${sessionId}/v${version}_${academicYear}/video_720p.${ext}`
   */
  public static buildSessionVideoKey(
    ctx: Partial<RelationalLessonContext> & { sessionId: string },
    extension: 'webm' | 'mp4' = 'webm'
  ): string {
    const norm = this.normalizeRelationalContext(ctx);
    const boardSegment = norm.boardId ?? norm.examId ?? 0;
    return `courses/course_${norm.courseId}/board_${boardSegment}_lang_${norm.languageId}/batch_${norm.batchId}/session_${norm.sessionId}/v${norm.version}_${norm.academicYear}/video_720p.${extension}`;
  }

  /**
   * Builds the deterministic relational storage key for a lesson/topic's `whiteboard.json` artifact:
   * `courses/course_${courseId}/board_${boardId}_lang_${languageId}/ch_${chapterId}/lesson_${lessonId}/v${version}_${academicYear}/whiteboard.json`
   * (or includes `/topic_${topicId}` when `includeTopicSegment` is true and `topicId` is present).
   */
  public static buildTopicWhiteboardKey(
    ctx: Partial<RelationalLessonContext> & { sessionId: string },
    includeTopicSegment = false
  ): string {
    const norm = this.normalizeRelationalContext(ctx);
    const boardSegment = norm.boardId ?? norm.examId ?? 0;
    if (includeTopicSegment && norm.topicId !== null && norm.topicId !== undefined) {
      return `courses/course_${norm.courseId}/board_${boardSegment}_lang_${norm.languageId}/ch_${norm.chapterId}/lesson_${norm.lessonId}/topic_${norm.topicId}/v${norm.version}_${norm.academicYear}/whiteboard.json`;
    }
    return `courses/course_${norm.courseId}/board_${boardSegment}_lang_${norm.languageId}/ch_${norm.chapterId}/lesson_${norm.lessonId}/v${norm.version}_${norm.academicYear}/whiteboard.json`;
  }

  private getVideoRecordingStateMetaPath(sessionId: string): string {
    return this.resolveCachePath(`sessions/${sessionId}/video_recording_state.json`);
  }

  private persistVideoRecordingStateSync(state: SessionVideoRecordingState): void {
    try {
      const metaPath = this.getVideoRecordingStateMetaPath(state.sessionId);
      const dir = path.dirname(metaPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const payload = {
        sessionId: state.sessionId,
        videoKey: state.videoKey,
        cachePath: state.cachePath,
        mirrorPath: state.mirrorPath,
        mimeType: state.mimeType,
        extension: state.extension,
        nextExpectedChunkIndex: state.nextExpectedChunkIndex,
        processedChunks: Array.from(state.processedChunks),
        totalBytesWritten: state.totalBytesWritten,
        startedAt: state.startedAt,
        lastChunkAt: state.lastChunkAt,
        finalized: state.finalized,
        startingRelationalContext: state.startingRelationalContext,
      };
      fs.writeFileSync(metaPath, JSON.stringify(payload, null, 2), 'utf-8');
    } catch {
      // Non-blocking metadata persistence
    }
  }

  private rehydrateVideoRecordingStateSync(sessionId: string): SessionVideoRecordingState | undefined {
    const inMemory = this.videoRecordings.get(sessionId);
    if (inMemory) return inMemory;
    try {
      const metaPath = this.getVideoRecordingStateMetaPath(sessionId);
      if (!fs.existsSync(metaPath)) return undefined;
      const raw = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      if (!raw || typeof raw !== 'object' || !raw.videoKey) return undefined;
      const cachePath = this.resolveCachePath(raw.videoKey);
      const mirrorPath = this.resolveWorkspaceMirrorPath(raw.videoKey);
      const diskBytes = fs.existsSync(cachePath) ? fs.statSync(cachePath).size : 0;
      const restored: SessionVideoRecordingState = {
        sessionId,
        videoKey: String(raw.videoKey),
        cachePath,
        mirrorPath,
        mimeType: String(raw.mimeType || 'video/webm;codecs=vp9,opus'),
        extension: raw.extension === 'mp4' ? 'mp4' : 'webm',
        nextExpectedChunkIndex: Number(raw.nextExpectedChunkIndex || 0),
        processedChunks: new Set<number>(
          Array.isArray(raw.processedChunks) ? raw.processedChunks.map(Number) : []
        ),
        pendingChunks: new Map<number, Buffer>(),
        totalBytesWritten: diskBytes > 0 ? diskBytes : Number(raw.totalBytesWritten || 0),
        startedAt: Number(raw.startedAt || Date.now()),
        lastChunkAt: Number(raw.lastChunkAt || Date.now()),
        finalized: Boolean(raw.finalized),
        startingRelationalContext: raw.startingRelationalContext,
      };
      this.videoRecordings.set(sessionId, restored);
      return restored;
    } catch {
      return undefined;
    }
  }

  /**
   * Appends a compressed 720p video chunk (`10000ms` + random `150ms–1850ms` jitter)
   * into the session's single continuous recording (`video_720p.webm` or `.mp4`).
   *
   * Key Guarantees:
   * 1. **Single Continuous Session Video:** Switching lessons or topics mid-session never resets
   *    or splits the video file.
   * 2. **Out-of-Order Reassembly:** If network jitter causes `chunkIndex=2` to arrive before
   *    `chunkIndex=1`, `chunkIndex=2` is buffered in memory and flushed immediately once
   *    `chunkIndex=1` arrives.
   * 3. **Idempotent Retry & Rejoin Resume Handling:** Duplicate `chunkIndex` uploads are safely
   *    ignored, while rejoined instructors (`resume: true`) seamlessly append to the existing
   *    continuous session recording without restarting from 00:00.
   */
  public async appendVideoChunk(
    sessionId: string,
    chunkBuffer: Buffer,
    options: {
      chunkIndex: number;
      mimeType?: string;
      relationalContext?: Partial<RelationalLessonContext>;
      videoKeyOverride?: string;
      reset?: boolean;
      resume?: boolean;
    }
  ): Promise<VideoChunkAppendResult> {
    if (!Buffer.isBuffer(chunkBuffer) || chunkBuffer.length === 0) {
      throw new Error('Video chunk payload must be a non-empty binary Buffer');
    }
    const rawChunkIndex = Number(options.chunkIndex);
    if (!Number.isInteger(rawChunkIndex) || rawChunkIndex < 0) {
      throw new Error(`Invalid chunkIndex "${options.chunkIndex}": must be a non-negative integer`);
    }

    return this.withSessionLock(sessionId, async () => {
      let state = this.rehydrateVideoRecordingStateSync(sessionId);
      const shouldResetExistingState =
        Boolean(options.reset) || (rawChunkIndex === 0 && Boolean(state?.finalized) && !options.resume);

      if (state && shouldResetExistingState) {
        if (fs.existsSync(state.cachePath)) {
          await fs.promises.unlink(state.cachePath).catch(() => {});
        }
        if (state.mirrorPath !== state.cachePath && fs.existsSync(state.mirrorPath)) {
          await fs.promises.unlink(state.mirrorPath).catch(() => {});
        }
        const metaPath = this.getVideoRecordingStateMetaPath(sessionId);
        if (fs.existsSync(metaPath)) {
          await fs.promises.unlink(metaPath).catch(() => {});
        }
        FileCache.invalidate(state.cachePath);
        if (state.mirrorPath !== state.cachePath) {
          FileCache.invalidate(state.mirrorPath);
        }
        this.videoRecordings.delete(sessionId);
        state = undefined;
      }

      if (!state) {
        const mimeType = options.mimeType || 'video/webm;codecs=vp9,opus';
        const extension: 'webm' | 'mp4' = mimeType.includes('mp4') ? 'mp4' : 'webm';
        const lockedRelCtx = options.relationalContext
          ? { ...options.relationalContext }
          : undefined;
        const hasExplicitLessonHierarchy = Boolean(
          lockedRelCtx &&
            lockedRelCtx.chapterId !== undefined &&
            lockedRelCtx.chapterId !== null &&
            lockedRelCtx.lessonId !== undefined &&
            lockedRelCtx.lessonId !== null
        );
        const videoKey =
          options.videoKeyOverride ||
          (lockedRelCtx
            ? hasExplicitLessonHierarchy
              ? StorageProvider.buildLessonVideoKey(
                  { ...lockedRelCtx, sessionId },
                  extension
                )
              : StorageProvider.buildSessionCourseLanguageVideoKey(
                  { ...lockedRelCtx, sessionId },
                  extension
                )
            : `sessions/${sessionId}/video_720p.${extension}`);

        const cachePath = this.resolveCachePath(videoKey);
        const mirrorPath = this.resolveWorkspaceMirrorPath(videoKey);

        const dir = path.dirname(cachePath);
        if (!fs.existsSync(dir)) {
          await fs.promises.mkdir(dir, { recursive: true });
        }
        // Reset file on chunk 0 of a newly started session recording (unless resuming an existing file)
        if (rawChunkIndex === 0 && !options.resume && fs.existsSync(cachePath)) {
          await fs.promises.unlink(cachePath).catch(() => {});
        }
        if (mirrorPath !== cachePath) {
          const mirrorDir = path.dirname(mirrorPath);
          if (!fs.existsSync(mirrorDir)) {
            await fs.promises.mkdir(mirrorDir, { recursive: true });
          }
          if (rawChunkIndex === 0 && !options.resume && fs.existsSync(mirrorPath)) {
            await fs.promises.unlink(mirrorPath).catch(() => {});
          }
        }

        const existingFileBytes =
          options.resume && fs.existsSync(cachePath) ? fs.statSync(cachePath).size : 0;

        state = {
          sessionId,
          videoKey,
          cachePath,
          mirrorPath,
          mimeType,
          extension,
          nextExpectedChunkIndex: 0,
          processedChunks: new Set<number>(),
          pendingChunks: new Map<number, Buffer>(),
          totalBytesWritten: existingFileBytes,
          startedAt: Date.now(),
          lastChunkAt: Date.now(),
          finalized: false,
          startingRelationalContext: lockedRelCtx,
        };
        this.videoRecordings.set(sessionId, state);
      } else if (state.finalized && options.resume) {
        state.finalized = false;
      }

      // If instructor rejoined and resumed recording (`options.resume === true`) and sent chunk 0..N
      // from a newly created MediaRecorder instance, seamlessly map to `nextExpectedChunkIndex`
      const chunkIndex =
        options.resume && rawChunkIndex < state.nextExpectedChunkIndex
          ? state.nextExpectedChunkIndex
          : rawChunkIndex;

      // Idempotently ignore duplicate chunk retries
      if (state.processedChunks.has(chunkIndex) || chunkIndex < state.nextExpectedChunkIndex) {
        return {
          sessionId,
          chunkIndex,
          bytesAppended: 0,
          totalBytesWritten: state.totalBytesWritten,
          chunksReceivedCount: state.processedChunks.size,
          nextExpectedChunkIndex: state.nextExpectedChunkIndex,
          bufferedOutOfOrderCount: state.pendingChunks.size,
          duplicateIgnored: true,
          videoKey: state.videoKey,
          cachePath: state.cachePath,
        };
      }

      // Guard against unbounded out-of-order chunk buffering (OOM DoS protection)
      if (
        chunkIndex > state.nextExpectedChunkIndex &&
        (chunkIndex - state.nextExpectedChunkIndex > StorageProvider.MAX_PENDING_CHUNKS ||
          (!state.pendingChunks.has(chunkIndex) &&
            state.pendingChunks.size >= StorageProvider.MAX_PENDING_CHUNKS))
      ) {
        throw new Error(
          `Out-of-order video chunk #${chunkIndex} exceeds maximum pending buffer limit (${StorageProvider.MAX_PENDING_CHUNKS}) relative to expected chunk #${state.nextExpectedChunkIndex}.`
        );
      }

      // Buffer chunk in map and flush all contiguous chunks starting from nextExpectedChunkIndex
      state.pendingChunks.set(chunkIndex, chunkBuffer);
      let bytesAppendedNow = 0;

      while (state.pendingChunks.has(state.nextExpectedChunkIndex)) {
        const nextIdx = state.nextExpectedChunkIndex;
        const bufToAppend = state.pendingChunks.get(nextIdx)!;
        state.pendingChunks.delete(nextIdx);

        await fs.promises.appendFile(state.cachePath, bufToAppend);
        if (state.mirrorPath !== state.cachePath) {
          await fs.promises.appendFile(state.mirrorPath, bufToAppend);
        }

        FileCache.invalidate(state.cachePath);
        if (state.mirrorPath !== state.cachePath) {
          FileCache.invalidate(state.mirrorPath);
        }

        state.processedChunks.add(nextIdx);
        state.totalBytesWritten += bufToAppend.length;
        bytesAppendedNow += bufToAppend.length;
        state.nextExpectedChunkIndex += 1;
        state.lastChunkAt = Date.now();
      }

      this.persistVideoRecordingStateSync(state);

      return {
        sessionId,
        chunkIndex,
        bytesAppended: bytesAppendedNow,
        totalBytesWritten: state.totalBytesWritten,
        chunksReceivedCount: state.processedChunks.size,
        nextExpectedChunkIndex: state.nextExpectedChunkIndex,
        bufferedOutOfOrderCount: state.pendingChunks.size,
        duplicateIgnored: false,
        videoKey: state.videoKey,
        cachePath: state.cachePath,
      };
    });
  }

  /**
   * Returns current recording state for a session's continuous 720p video stream.
   */
  public getSessionVideoState(sessionId: string): {
    exists: boolean;
    videoKey?: string;
    cachePath?: string;
    totalBytesWritten: number;
    chunksReceivedCount: number;
    nextExpectedChunkIndex: number;
    bufferedOutOfOrderCount: number;
    finalized: boolean;
    durationSec?: number;
    startingRelationalContext?: Partial<RelationalLessonContext>;
  } {
    const state = this.rehydrateVideoRecordingStateSync(sessionId);
    if (!state) {
      return {
        exists: false,
        totalBytesWritten: 0,
        chunksReceivedCount: 0,
        nextExpectedChunkIndex: 0,
        bufferedOutOfOrderCount: 0,
        finalized: false,
        durationSec: 0,
      };
    }
    return {
      exists: true,
      videoKey: state.videoKey,
      cachePath: state.cachePath,
      totalBytesWritten: state.totalBytesWritten,
      chunksReceivedCount: state.processedChunks.size,
      nextExpectedChunkIndex: state.nextExpectedChunkIndex,
      bufferedOutOfOrderCount: state.pendingChunks.size,
      finalized: state.finalized,
      durationSec: Math.max(0, state.processedChunks.size * 10),
      startingRelationalContext: state.startingRelationalContext,
    };
  }

  /**
   * Patches or injects the EBML Float64 Duration element (`0x4489`) in a WebM header buffer
   * so browsers opening the finalized `video_720p.webm` immediately know the exact video duration
   * for seeking and `1x / 1.25x / 1.5x / 2x` variable-speed playback.
   */
  public static patchWebmDurationHeader(buffer: Buffer, durationMs: number): Buffer {
    if (!Buffer.isBuffer(buffer) || buffer.length < 16 || durationMs <= 0) {
      return buffer;
    }
    const patched = Buffer.from(buffer);
    // Search within the first 4 KB (WebM Segment Info header) for EBML Duration ID [0x44, 0x89]
    const searchLimit = Math.min(patched.length - 10, 4096);
    for (let i = 0; i < searchLimit; i++) {
      if (patched[i] === 0x44 && patched[i + 1] === 0x89) {
        const sizeByte = patched[i + 2];
        // 0x88 = 8-byte float64, 0x84 = 4-byte float32
        if (sizeByte === 0x88 && i + 11 <= patched.length) {
          patched.writeDoubleBE(durationMs, i + 3);
          return patched;
        }
        if (sizeByte === 0x84 && i + 7 <= patched.length) {
          patched.writeFloatBE(durationMs, i + 3);
          return patched;
        }
      }
    }
    return patched;
  }

  /**
   * Patches the EBML Float64/Float32 Duration element (`0x4489`) in-place within the first 4 KB
   * of a WebM file on disk using a bounded file descriptor read/write, avoiding reading multi-hundred-MB
   * recordings into the V8 heap.
   */
  public static async patchWebmDurationHeaderInPlace(
    filePath: string,
    durationMs: number
  ): Promise<boolean> {
    if (!filePath || durationMs <= 0 || !fs.existsSync(filePath)) {
      return false;
    }
    const handle = await fs.promises.open(filePath, 'r+');
    try {
      const stat = await handle.stat();
      if (stat.size < 16) {
        return false;
      }
      const headerLen = Math.min(stat.size, 4096);
      const headerBuf = Buffer.allocUnsafe(headerLen);
      const { bytesRead } = await handle.read(headerBuf, 0, headerLen, 0);
      if (bytesRead < 16) {
        return false;
      }
      const slice = headerBuf.subarray(0, bytesRead);
      const patched = StorageProvider.patchWebmDurationHeader(slice, durationMs);
      if (patched.equals(slice)) {
        return false;
      }
      await handle.write(patched, 0, patched.length, 0);
      return true;
    } finally {
      await handle.close();
    }
  }

  /**
   * Finalizes the session's continuous 720p video recording:
   * 1. Flushes any out-of-order buffered chunks in ascending index order.
   * 2. Patches the WebM EBML duration header if `durationSec` is known.
   * 3. Copies/links the finalized video to all taught lessons' deterministic hierarchy paths
   *    (`courses/course_${courseId}/board_${boardId}_lang_${languageId}/ch_${chapterId}/lesson_${lessonId}/v${version}_${academicYear}/video_720p.webm`)
   *    and syncs to Cloudflare R2 / AWS S3 if `STORAGE_DRIVER=s3_compatible`.
   */
  public async finalizeVideoRecording(
    sessionId: string,
    ctx: Partial<RelationalLessonContext> & { sessionId: string },
    options?: {
      durationSec?: number;
      additionalLessonContexts?: Array<Partial<RelationalLessonContext> & { sessionId: string }>;
    }
  ): Promise<
    StorageWriteResult & {
      totalBytes: number;
      chunksCount: number;
      durationSec: number;
      linkedKeys: string[];
    }
  > {
    return this.withSessionLock(sessionId, async () => {
      const state = this.rehydrateVideoRecordingStateSync(sessionId);
      const effectivePrimaryCtx =
        state?.startingRelationalContext && Object.keys(state.startingRelationalContext).length > 0
          ? { ...ctx, ...state.startingRelationalContext, sessionId: ctx.sessionId || sessionId }
          : ctx;
      const sessionCourseLangKey = StorageProvider.buildSessionCourseLanguageVideoKey(
        effectivePrimaryCtx,
        state?.extension || 'webm'
      );
      const hasExplicitLessonHierarchy = Boolean(
        effectivePrimaryCtx.chapterId !== undefined &&
          effectivePrimaryCtx.chapterId !== null &&
          effectivePrimaryCtx.lessonId !== undefined &&
          effectivePrimaryCtx.lessonId !== null
      );
      const primaryLessonKey = hasExplicitLessonHierarchy
        ? StorageProvider.buildLessonVideoKey(
            effectivePrimaryCtx,
            state?.extension || 'webm'
          )
        : sessionCourseLangKey;
      const currentLessonKey = hasExplicitLessonHierarchy
        ? StorageProvider.buildLessonVideoKey(ctx, state?.extension || 'webm')
        : sessionCourseLangKey;

      if (!state) {
        // Check if file already exists at primaryLessonKey
        const existingCachePath = this.resolveCachePath(primaryLessonKey);
        const existingBytes = fs.existsSync(existingCachePath)
          ? (await fs.promises.stat(existingCachePath)).size
          : 0;
        return {
          key: primaryLessonKey,
          cachePath: existingCachePath,
          publicUrl: this.getPublicUrl(primaryLessonKey),
          driver: this.config.driver,
          backend: this.getBackendType(),
          syncedToCloud: false,
          totalBytes: existingBytes,
          chunksCount: 0,
          durationSec: options?.durationSec ?? 0,
          linkedKeys: [primaryLessonKey],
        };
      }

      // 1. Flush any remaining pending chunks in ascending order
      if (state.pendingChunks.size > 0) {
        const sortedPending = Array.from(state.pendingChunks.entries()).sort((a, b) => a[0] - b[0]);
        for (const [idx, buf] of sortedPending) {
          await fs.promises.appendFile(state.cachePath, buf);
          if (state.mirrorPath !== state.cachePath) {
            await fs.promises.appendFile(state.mirrorPath, buf);
          }
          state.processedChunks.add(idx);
          state.totalBytesWritten += buf.length;
          state.nextExpectedChunkIndex = Math.max(state.nextExpectedChunkIndex, idx + 1);
        }
        state.pendingChunks.clear();
      }

      const computedDurationSec =
        options?.durationSec ?? Math.max(1, state.processedChunks.size * 10);

      // 2. Patch WebM EBML duration header in-place (first 4 KB only) if WebM format
      if (state.extension === 'webm' && fs.existsSync(state.cachePath)) {
        await StorageProvider.patchWebmDurationHeaderInPlace(
          state.cachePath,
          computedDurationSec * 1000
        );
        if (state.mirrorPath !== state.cachePath && fs.existsSync(state.mirrorPath)) {
          await StorageProvider.patchWebmDurationHeaderInPlace(
            state.mirrorPath,
            computedDurationSec * 1000
          );
        }
      }

      state.finalized = true;
      this.persistVideoRecordingStateSync(state);
      FileCache.invalidate(state.cachePath);

      // 3. Ensure session-course-language key, primary key, and any additional taught lesson keys point to the finalized video
      const targetKeys = new Set<string>([
        state.videoKey,
        sessionCourseLangKey,
        primaryLessonKey,
        currentLessonKey,
      ]);
      if (options?.additionalLessonContexts) {
        for (const extraCtx of options.additionalLessonContexts) {
          targetKeys.add(StorageProvider.buildLessonVideoKey(extraCtx, state.extension));
        }
      }

      let syncedToCloud = false;
      const cacheFileBytes = fs.existsSync(state.cachePath)
        ? (await fs.promises.stat(state.cachePath)).size
        : 0;

      for (const targetKey of Array.from(targetKeys)) {
        const targetCachePath = this.resolveCachePath(targetKey);
        const targetMirrorPath = this.resolveWorkspaceMirrorPath(targetKey);

        if (targetCachePath !== state.cachePath && cacheFileBytes > 0) {
          const targetDir = path.dirname(targetCachePath);
          if (!fs.existsSync(targetDir)) {
            await fs.promises.mkdir(targetDir, { recursive: true });
          }
          await fs.promises.copyFile(state.cachePath, targetCachePath);
          FileCache.invalidate(targetCachePath);
        }

        if (
          targetMirrorPath !== targetCachePath &&
          targetMirrorPath !== state.mirrorPath &&
          cacheFileBytes > 0
        ) {
          const mirrorDir = path.dirname(targetMirrorPath);
          if (!fs.existsSync(mirrorDir)) {
            await fs.promises.mkdir(mirrorDir, { recursive: true });
          }
          await fs.promises.copyFile(state.cachePath, targetMirrorPath);
          FileCache.invalidate(targetMirrorPath);
        }

        if (
          this.config.driver === 's3_compatible' &&
          this.config.accessKeyId &&
          this.config.secretAccessKey &&
          cacheFileBytes > 0
        ) {
          const client = this.s3Client || this.initS3Client();
          try {
            await client.send(
              new PutObjectCommand({
                Bucket: this.config.bucket,
                Key: targetKey,
                Body: fs.createReadStream(state.cachePath),
                ContentLength: cacheFileBytes,
                ContentType: state.mimeType,
              })
            );
            syncedToCloud = true;
          } catch (err: any) {
            console.warn(
              `[StorageProvider] Video upload warning (${this.getBackendType()}) for "${targetKey}": ${err.message}`
            );
          }
        }
      }

      return {
        key: primaryLessonKey,
        cachePath: this.resolveCachePath(primaryLessonKey),
        publicUrl: this.getPublicUrl(primaryLessonKey),
        driver: this.config.driver,
        backend: this.getBackendType(),
        syncedToCloud,
        totalBytes: state.totalBytesWritten,
        chunksCount: state.processedChunks.size,
        durationSec: computedDurationSec,
        linkedKeys: Array.from(targetKeys),
      };
    });
  }

  /**
   * Strictly sanitizes a Whiteboard artifact before persistence so Content Mode pen/laser strokes
   * or transient annotations are NEVER stored on disk or cloud storage.
   */
  public static sanitizeWhiteboardArtifact(
    artifact: Partial<ExcalidrawWhiteboardArtifact> & Record<string, any>
  ): ExcalidrawWhiteboardArtifact {
    const filterValidElements = (elements: any[] | undefined): any[] => {
      if (!Array.isArray(elements)) return [];
      return elements.filter((el) => {
        if (!el || typeof el !== 'object') return false;
        // Strip deleted elements and any accidental Content Mode or Laser strokes
        if (el.isDeleted === true) return false;
        if (el.isContentAnnotation === true || el.mode === 'CONTENT') return false;
        if (el.type === 'laser' || el.tool === 'LASER') return false;
        return true;
      });
    };

    const sanitizedPages = Array.isArray(artifact.pages)
      ? artifact.pages.map((p: any, idx: number) => ({
          pageId: String(p.pageId || `page_${idx + 1}`),
          pageNumber: typeof p.pageNumber === 'number' ? p.pageNumber : idx + 1,
          title: p.title,
          elements: filterValidElements(p.elements),
          appState: p.appState && typeof p.appState === 'object' ? p.appState : {},
          files: p.files && typeof p.files === 'object' ? p.files : {},
          updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : Date.now(),
        }))
      : [];

    const sessionId = String(artifact.sessionId || artifact.relationalContext?.sessionId || 'unknown-session');
    const relCtx = StorageProvider.normalizeRelationalContext({
      ...(artifact.relationalContext || {}),
      sessionId,
      courseId: Number(artifact.courseId ?? artifact.relationalContext?.courseId ?? 1),
      chapterId: Number(artifact.chapterId ?? artifact.relationalContext?.chapterId ?? 1),
      lessonId: Number(artifact.lessonId ?? artifact.relationalContext?.lessonId ?? 1),
      topicId:
        artifact.topicId !== undefined
          ? artifact.topicId
          : artifact.relationalContext?.topicId ?? null,
      version: Number(artifact.version ?? artifact.relationalContext?.version ?? 1),
      academicYear: Number(
        artifact.academicYear ?? artifact.relationalContext?.academicYear ?? 2026
      ),
    });

    return {
      schemaVersion: 2,
      sessionId,
      relationalContext: relCtx,
      savedAt: artifact.savedAt || new Date().toISOString(),
      elements: filterValidElements(artifact.elements),
      appState:
        artifact.appState && typeof artifact.appState === 'object'
          ? {
              viewBackgroundColor: '#ffffff',
              ...artifact.appState,
            }
          : { viewBackgroundColor: '#ffffff' },
      files: artifact.files && typeof artifact.files === 'object' ? artifact.files : {},
      pages: sanitizedPages,
      timelineMarkers: Array.isArray(artifact.timelineMarkers) ? artifact.timelineMarkers : [],
    };
  }

  /**
   * Compresses `whiteboard.json` with `gzip` (`Content-Encoding: gzip`), persists both the
   * JSON cache and `.gz` binary buffer in `FileCache` + `storage_cache/`, and syncs to R2/S3.
   *
   * Enforces the strict rule: **ZERO Content Mode pen or laser strokes are ever stored.**
   */
  public async putGzippedWhiteboard(
    key: string,
    rawArtifact: Partial<ExcalidrawWhiteboardArtifact> & Record<string, any>
  ): Promise<
    StorageWriteResult & {
      uncompressedBytes: number;
      gzippedBytes: number;
      compressionRatio: number;
    }
  > {
    const cleanKey = key.replace(/^\/+/, '');
    const gzKey = cleanKey.endsWith('.gz') ? cleanKey : `${cleanKey}.gz`;

    const sanitized = StorageProvider.sanitizeWhiteboardArtifact(rawArtifact);
    const jsonString = JSON.stringify(sanitized);
    const uncompressedBytes = Buffer.byteLength(jsonString, 'utf-8');
    const gzippedBuffer = zlib.gzipSync(Buffer.from(jsonString, 'utf-8'), { level: 6 });
    const gzippedBytes = gzippedBuffer.length;

    const cachePath = this.resolveCachePath(cleanKey);
    const gzCachePath = this.resolveCachePath(gzKey);
    const mirrorPath = this.resolveWorkspaceMirrorPath(cleanKey);
    const gzMirrorPath = this.resolveWorkspaceMirrorPath(gzKey);

    // 1. Update JSON and Gzip buffers atomically in FileCache + storage_cache/
    FileCache.invalidate(cachePath);
    FileCache.invalidate(gzCachePath);
    await FileCache.writeJson(cachePath, sanitized, jsonString);
    await FileCache.writeBuffer(gzCachePath, gzippedBuffer);

    if (mirrorPath !== cachePath) {
      FileCache.invalidate(mirrorPath);
      FileCache.invalidate(gzMirrorPath);
      await FileCache.writeJson(mirrorPath, sanitized, jsonString);
      await FileCache.writeBuffer(gzMirrorPath, gzippedBuffer);
    }

    let syncedToCloud = false;
    if (
      this.config.driver === 's3_compatible' &&
      this.config.accessKeyId &&
      this.config.secretAccessKey
    ) {
      const client = this.s3Client || this.initS3Client();
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: this.config.bucket,
            Key: cleanKey,
            Body: gzippedBuffer,
            ContentType: 'application/json',
            ContentEncoding: 'gzip',
          })
        );
        syncedToCloud = true;
      } catch (err: any) {
        console.warn(
          `[StorageProvider] Gzipped whiteboard upload warning (${this.getBackendType()}) for "${cleanKey}": ${err.message}`
        );
      }
    }

    return {
      key: cleanKey,
      cachePath,
      publicUrl: this.getPublicUrl(cleanKey),
      driver: this.config.driver,
      backend: this.getBackendType(),
      syncedToCloud,
      uncompressedBytes,
      gzippedBytes,
      compressionRatio:
        uncompressedBytes > 0 ? Number((gzippedBytes / uncompressedBytes).toFixed(4)) : 1,
    };
  }

  /**
   * Retrieves a persisted `whiteboard.json` artifact in either parsed JSON form or
   * pre-compressed `gzip` Buffer form (for zero-CPU HTTP `Content-Encoding: gzip` serving).
   */
  public async getGzippedWhiteboard(key: string): Promise<{
    artifact: ExcalidrawWhiteboardArtifact;
    gzippedBuffer: Buffer;
  } | null> {
    const cleanKey = key.replace(/^\/+/, '').replace(/\.gz$/, '');
    const gzKey = `${cleanKey}.gz`;
    const cachePath = this.resolveCachePath(cleanKey);
    const gzCachePath = this.resolveCachePath(gzKey);

    if (fs.existsSync(cachePath) && fs.existsSync(gzCachePath)) {
      try {
        const [artifact, gzippedBuffer] = await Promise.all([
          FileCache.readJson<ExcalidrawWhiteboardArtifact>(cachePath),
          FileCache.readBuffer(gzCachePath),
        ]);
        return { artifact, gzippedBuffer };
      } catch {
        FileCache.invalidate(cachePath);
        FileCache.invalidate(gzCachePath);
      }
    }

    // Fallback if only .json exists or only .gz exists
    if (fs.existsSync(gzCachePath)) {
      try {
        const gzippedBuffer = await FileCache.readBuffer(gzCachePath);
        const decompressed = zlib.gunzipSync(gzippedBuffer).toString('utf-8');
        const artifact = JSON.parse(decompressed) as ExcalidrawWhiteboardArtifact;
        await FileCache.writeJson(cachePath, artifact, decompressed);
        return { artifact, gzippedBuffer };
      } catch {
        FileCache.invalidate(gzCachePath);
      }
    }

    const fromJson = await this.getJson<ExcalidrawWhiteboardArtifact>(cleanKey);
    if (fromJson) {
      const jsonStr = JSON.stringify(fromJson);
      const gzippedBuffer = zlib.gzipSync(Buffer.from(jsonStr, 'utf-8'), { level: 6 });
      await FileCache.writeBuffer(gzCachePath, gzippedBuffer);
      return { artifact: fromJson, gzippedBuffer };
    }

    return null;
  }

  /**
   * Implements RFC 7233 HTTP 206 Byte-Range Video Streaming (`GET /api/v1/stream/video/*`):
   * - Supports `Range: bytes=start-end` (`206 Partial Content`) for instant video seeking
   *   to any topic timestamp (`videoStartOffsetSec`) and `1x / 1.25x / 1.5x / 2x` playback.
   * - Returns `416 Range Not Satisfiable` when the requested byte range is out of bounds.
   * - Returns `200 OK` with full stream when no `Range` header is supplied.
   * - When `STORAGE_DRIVER=s3_compatible` and file is not cached locally, returns `302` redirect
   *   to the public CDN / R2 / S3 URL (which natively supports HTTP 206 byte ranges).
   */
  public async createVideoByteRangeStream(
    key: string,
    rangeHeader?: string
  ): Promise<VideoByteRangeStreamResult> {
    const cleanKey = key.replace(/^\/+/, '').replace(/\.\./g, '');
    const cachePath = this.resolveCachePath(cleanKey);
    const contentType = cleanKey.endsWith('.mp4') ? 'video/mp4' : 'video/webm';

    if (!fs.existsSync(cachePath)) {
      if (this.config.driver === 's3_compatible' || this.config.publicCdnUrl) {
        return {
          found: true,
          statusCode: 302,
          redirectUrl: this.getPublicUrl(cleanKey),
          headers: {
            Location: this.getPublicUrl(cleanKey),
            'Accept-Ranges': 'bytes',
          },
          totalSizeBytes: 0,
        };
      }
      return {
        found: false,
        statusCode: 404,
        headers: {},
        totalSizeBytes: 0,
      };
    }

    const stats = await fs.promises.stat(cachePath);
    const totalSize = stats.size;

    if (totalSize === 0) {
      return {
        found: false,
        statusCode: 404,
        headers: {},
        totalSizeBytes: 0,
      };
    }

    // No Range header -> 200 OK full stream with Accept-Ranges: bytes
    if (!rangeHeader || !rangeHeader.trim().startsWith('bytes=')) {
      return {
        found: true,
        statusCode: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Length': totalSize,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=3600',
        },
        stream: fs.createReadStream(cachePath),
        totalSizeBytes: totalSize,
        startByte: 0,
        endByte: totalSize - 1,
      };
    }

    // Parse RFC 7233 Range header: e.g. "bytes=0-1048575" or "bytes=5000-" or "bytes=-500"
    const rangeSpec = rangeHeader.trim().replace(/^bytes=/, '').split(',')[0].trim();
    const [rawStart, rawEnd] = rangeSpec.split('-');

    let startByte: number;
    let endByte: number;

    if (rawStart === '' && rawEnd !== '') {
      // Suffix byte-range-spec: "bytes=-500" (last 500 bytes)
      const suffixLength = parseInt(rawEnd, 10);
      if (isNaN(suffixLength) || suffixLength <= 0) {
        return {
          found: true,
          statusCode: 416,
          headers: {
            'Content-Range': `bytes */${totalSize}`,
            'Accept-Ranges': 'bytes',
          },
          totalSizeBytes: totalSize,
        };
      }
      startByte = Math.max(0, totalSize - suffixLength);
      endByte = totalSize - 1;
    } else {
      startByte = parseInt(rawStart, 10);
      // Cap open-ended range chunks to 2 MB (2 * 1024 * 1024) for smooth progressive buffering
      const defaultChunkEnd = Math.min(startByte + 2 * 1024 * 1024 - 1, totalSize - 1);
      endByte = rawEnd ? parseInt(rawEnd, 10) : defaultChunkEnd;
    }

    if (
      isNaN(startByte) ||
      isNaN(endByte) ||
      startByte < 0 ||
      endByte < startByte ||
      startByte >= totalSize
    ) {
      return {
        found: true,
        statusCode: 416,
        headers: {
          'Content-Range': `bytes */${totalSize}`,
          'Accept-Ranges': 'bytes',
        },
        totalSizeBytes: totalSize,
      };
    }

    const clampedEnd = Math.min(endByte, totalSize - 1);
    const chunkLength = clampedEnd - startByte + 1;

    return {
      found: true,
      statusCode: 206,
      headers: {
        'Content-Range': `bytes ${startByte}-${clampedEnd}/${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkLength,
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
      },
      stream: fs.createReadStream(cachePath, { start: startByte, end: clampedEnd }),
      totalSizeBytes: totalSize,
      startByte,
      endByte: clampedEnd,
    };
  }
}

let activeStorageProvider: StorageProvider | null = null;

export function getStorageProvider(): StorageProvider {
  if (!activeStorageProvider) {
    activeStorageProvider = new StorageProvider();
    const cfg = activeStorageProvider.getConfig();
    console.log(
      `[StorageProvider] Initialized driver=${cfg.driver} backend=${cfg.backend} region=${cfg.region} bucket=${cfg.bucket} cacheDir=${cfg.cacheDir}`
    );
  }
  return activeStorageProvider;
}

export function setStorageProvider(provider: StorageProvider | null): void {
  activeStorageProvider = provider;
}
