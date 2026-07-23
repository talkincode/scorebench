export function audioAssetCacheKey(
  root: string,
  relPath: string,
  sizeBytes: number | null,
  modifiedMs: number | null,
): string {
  return JSON.stringify([root, relPath, sizeBytes, modifiedMs]);
}

/** Small promise-aware LRU so concurrent playback and prewarm requests decode once. */
export class AsyncLruCache<T> {
  private readonly entries = new Map<string, Promise<T>>();

  constructor(private readonly maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("maxEntries must be a positive integer");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  getOrCreate(key: string, create: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }

    let pending: Promise<T>;
    try {
      pending = create();
    } catch (error) {
      return Promise.reject(error);
    }
    this.entries.set(key, pending);
    this.trim();
    void pending.catch(() => {
      if (this.entries.get(key) === pending) this.entries.delete(key);
    });
    return pending;
  }

  clear(): void {
    this.entries.clear();
  }

  private trim(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}
