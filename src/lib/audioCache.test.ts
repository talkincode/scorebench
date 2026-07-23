import { describe, expect, it } from "vitest";
import { AsyncLruCache, audioAssetCacheKey } from "./audioCache";

describe("AsyncLruCache", () => {
  it("coalesces concurrent work and reuses the resolved value", async () => {
    const cache = new AsyncLruCache<number>(2);
    let calls = 0;
    const create = async () => {
      calls++;
      return 42;
    };

    const first = cache.getOrCreate("asset", create);
    const second = cache.getOrCreate("asset", create);

    expect(first).toBe(second);
    await expect(first).resolves.toBe(42);
    await expect(cache.getOrCreate("asset", create)).resolves.toBe(42);
    expect(calls).toBe(1);
  });

  it("evicts the least recently used entry", async () => {
    const cache = new AsyncLruCache<string>(2);
    await cache.getOrCreate("a", async () => "a");
    await cache.getOrCreate("b", async () => "b");
    await cache.getOrCreate("a", async () => "unused");
    await cache.getOrCreate("c", async () => "c");

    let reloaded = false;
    await expect(
      cache.getOrCreate("b", async () => {
        reloaded = true;
        return "b2";
      }),
    ).resolves.toBe("b2");
    expect(reloaded).toBe(true);
    expect(cache.size).toBe(2);
  });

  it("drops failed work so a later request can retry", async () => {
    const cache = new AsyncLruCache<number>(2);
    await expect(
      cache.getOrCreate("asset", async () => Promise.reject(new Error("decode failed"))),
    ).rejects.toThrow("decode failed");
    await expect(cache.getOrCreate("asset", async () => 7)).resolves.toBe(7);
  });
});

describe("audioAssetCacheKey", () => {
  it("invalidates when the file revision changes", () => {
    const before = audioAssetCacheKey("/project", "out/demo.ogg", 1024, 100);
    expect(audioAssetCacheKey("/project", "out/demo.ogg", 1024, 101)).not.toBe(before);
    expect(audioAssetCacheKey("/project", "out/demo.ogg", 2048, 100)).not.toBe(before);
  });
});
