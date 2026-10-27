import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { cacheBackend, FILE_CACHE_DIR, LIMITS } from "../config";

/**
 * Pluggable server-side cache for Qloo responses.
 * Qloo data may be cached privately on the server but must never be committed:
 * the file backend writes under .cache/ which is git-ignored.
 *
 * To add Upstash Redis later: implement CacheStore with get/set over its REST API
 * and return it from getCache() when e.g. PRETASTE_CACHE=upstash. No dependency is added now.
 */
export interface CacheStore {
  readonly name: string;
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class MemoryCache implements CacheStore {
  readonly name = "memory";
  private store = new Map<string, Entry<unknown>>();

  async get<T>(key: string): Promise<T | null> {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return e.value as T;
  }

  async set<T>(key: string, value: T, ttlMs = LIMITS.cacheTtlMs): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}

export class FileCache implements CacheStore {
  readonly name = "file";
  constructor(private dir: string) {}

  private file(key: string) {
    return path.join(this.dir, `${createHash("sha256").update(key).digest("hex")}.json`);
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await fs.readFile(this.file(key), "utf8");
      const e = JSON.parse(raw) as Entry<T>;
      if (e.expiresAt < Date.now()) return null;
      return e.value;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlMs = LIMITS.cacheTtlMs): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const e: Entry<T> = { value, expiresAt: Date.now() + ttlMs };
    await fs.writeFile(this.file(key), JSON.stringify(e), "utf8");
  }
}

let singleton: CacheStore | null = null;

export function getCache(): CacheStore {
  if (singleton) return singleton;
  singleton =
    cacheBackend() === "file"
      ? // Runtime-only cache dir: keep it out of build output tracing.
        new FileCache(path.join(/*turbopackIgnore: true*/ process.cwd(), FILE_CACHE_DIR))
      : new MemoryCache();
  return singleton;
}

/** Stable key: path + sorted params. The API key is never part of the key. */
export function cacheKey(apiPath: string, params: Record<string, string>): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return `qloo:${apiPath}?${sorted}`;
}
