import * as fs from 'fs';
import * as path from 'path';

interface CacheEntry<T> {
  mtimeMs: number;
  data: T;
  cachedAt: number;
}

export class FileCache {
  private static cache = new Map<string, CacheEntry<any>>();
  private static readonly MAX_CACHE_ENTRIES = 100;

  private static setBounded(key: string, entry: CacheEntry<any>): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.MAX_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, entry);
  }

  /**
   * Reads a JSON file with automatic cache invalidation based on file modification timestamp.
   */
  public static readJsonSync<T>(filePath: string): T {
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File does not exist: ${resolvedPath}`);
    }

    const stats = fs.statSync(resolvedPath);
    const existing = this.cache.get(resolvedPath);

    if (existing && existing.mtimeMs === stats.mtimeMs) {
      return existing.data as T;
    }

    const raw = fs.readFileSync(resolvedPath, 'utf-8');
    const parsed = JSON.parse(raw) as T;

    this.setBounded(resolvedPath, {
      mtimeMs: stats.mtimeMs,
      data: parsed,
      cachedAt: Date.now(),
    });

    return parsed;
  }

  /**
   * Reads a JSON file asynchronously with cache invalidation based on stat mtimeMs.
   */
  public static async readJson<T>(filePath: string): Promise<T> {
    const resolvedPath = path.resolve(filePath);
    try {
      const stats = await fs.promises.stat(resolvedPath);
      const existing = this.cache.get(resolvedPath);

      if (existing && existing.mtimeMs === stats.mtimeMs) {
        return existing.data as T;
      }

      const raw = await fs.promises.readFile(resolvedPath, 'utf-8');
      const parsed = JSON.parse(raw) as T;

      this.setBounded(resolvedPath, {
        mtimeMs: stats.mtimeMs,
        data: parsed,
        cachedAt: Date.now(),
      });

      return parsed;
    } catch (err: any) {
      throw new Error(`Failed to read file ${resolvedPath}: ${err.message}`);
    }
  }

  /**
   * Atomically writes JSON to disk, ensuring directory exists, and updates in-memory cache immediately.
   */
  public static async writeJson(
    filePath: string,
    data: any,
    preSerializedJson?: string
  ): Promise<void> {
    const resolvedPath = path.resolve(filePath);
    const dir = path.dirname(resolvedPath);

    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
    }

    const jsonString = preSerializedJson ?? JSON.stringify(data, null, 2);
    const tempPath = `${resolvedPath}.tmp.${Date.now()}.${Math.random().toString(36).substring(7)}`;

    await fs.promises.writeFile(tempPath, jsonString, 'utf-8');
    await fs.promises.rename(tempPath, resolvedPath);

    const stats = await fs.promises.stat(resolvedPath);
    this.setBounded(resolvedPath, {
      mtimeMs: stats.mtimeMs,
      data,
      cachedAt: Date.now(),
    });
  }

  /**
   * Reads a binary buffer file asynchronously with automatic mtimeMs cache validation.
   * Ideal for gzip-compressed whiteboard artifacts (`whiteboard.json`) so repeated reads
   * by 1,000+ students never hit disk after the first read.
   */
  public static async readBuffer(filePath: string): Promise<Buffer> {
    const resolvedPath = path.resolve(filePath);
    try {
      const stats = await fs.promises.stat(resolvedPath);
      const existing = this.cache.get(resolvedPath);

      if (existing && existing.mtimeMs === stats.mtimeMs && Buffer.isBuffer(existing.data)) {
        return existing.data as Buffer;
      }

      const buf = await fs.promises.readFile(resolvedPath);
      this.setBounded(resolvedPath, {
        mtimeMs: stats.mtimeMs,
        data: buf,
        cachedAt: Date.now(),
      });

      return buf;
    } catch (err: any) {
      throw new Error(`Failed to read binary file ${resolvedPath}: ${err.message}`);
    }
  }

  /**
   * Atomically writes a binary buffer to disk and immediately updates the in-memory `FileCache`.
   */
  public static async writeBuffer(filePath: string, buffer: Buffer): Promise<void> {
    const resolvedPath = path.resolve(filePath);
    const dir = path.dirname(resolvedPath);

    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
    }

    const tempPath = `${resolvedPath}.tmp.${Date.now()}.${Math.random().toString(36).substring(7)}`;
    await fs.promises.writeFile(tempPath, buffer);
    await fs.promises.rename(tempPath, resolvedPath);

    const stats = await fs.promises.stat(resolvedPath);
    this.setBounded(resolvedPath, {
      mtimeMs: stats.mtimeMs,
      data: buffer,
      cachedAt: Date.now(),
    });
  }

  /**
   * Checks whether a resolved file path is currently warm in the in-memory cache.
   */
  public static has(filePath: string): boolean {
    return this.cache.has(path.resolve(filePath));
  }

  /**
   * Returns current number of cached file entries.
   */
  public static size(): number {
    return this.cache.size;
  }

  /**
   * Manually invalidate a cached file or entire cache.
   */
  public static invalidate(filePath?: string): void {
    if (filePath) {
      this.cache.delete(path.resolve(filePath));
    } else {
      this.cache.clear();
    }
  }
}
