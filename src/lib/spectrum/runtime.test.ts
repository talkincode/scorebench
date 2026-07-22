import { describe, expect, it, vi } from "vitest";
import { drawWithFallback, FrameBudgetMeter, ThreeInstanceCache } from "./runtime";
import type { ThreeInstance } from "./three/types";
import type { SpectrumFrame, SpectrumStyle } from "./types";

describe("drawWithFallback", () => {
  it("logs once and falls back without propagating draw errors", () => {
    const fallbackDraw = vi.fn();
    const fallback: SpectrumStyle = { id: "bars", label: "Bars", draw: fallbackDraw };
    const broken: SpectrumStyle = {
      id: "broken",
      label: "Broken",
      draw: () => {
        throw new Error("draw exploded");
      },
    };
    const report = vi.fn();
    const failed = new Set<string>();
    const frame = {} as SpectrumFrame;

    expect(drawWithFallback(broken, fallback, frame, failed, report)).toBe(fallback);
    expect(drawWithFallback(broken, fallback, frame, failed, report)).toBe(fallback);
    expect(fallbackDraw).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledTimes(1);
  });
});

describe("FrameBudgetMeter", () => {
  it("emits deterministic disjoint-window statistics", () => {
    const meter = new FrameBudgetMeter(4);

    expect(meter.record(1)).toBeNull();
    expect(meter.record(2)).toBeNull();
    expect(meter.record(3)).toBeNull();
    expect(meter.record(10)).toEqual({
      samples: 4,
      averageMs: 4,
      p95Ms: 10,
      p99Ms: 10,
      maxMs: 10,
    });
    expect(meter.record(2)).toBeNull();
  });

  it("rejects invalid windows and ignores invalid timings", () => {
    expect(() => new FrameBudgetMeter(0)).toThrow(RangeError);
    const meter = new FrameBudgetMeter(1);
    expect(meter.record(Number.NaN)).toBeNull();
    expect(meter.record(-1)).toBeNull();
    expect(meter.record(5)?.averageMs).toBe(5);
  });
});

describe("ThreeInstanceCache", () => {
  it("rejects capacities that cannot retain the active style", () => {
    expect(() => new ThreeInstanceCache(0)).toThrow(RangeError);
    expect(() => new ThreeInstanceCache(1.5)).toThrow(RangeError);
  });

  it("disposes the least recently used style when capacity is exceeded", () => {
    const report = vi.fn();
    const cache = new ThreeInstanceCache(2, report);
    const mood = {
      render: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
    } satisfies ThreeInstance;
    const voyage = {
      render: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
    } satisfies ThreeInstance;
    const aurora = {
      render: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
    } satisfies ThreeInstance;

    cache.getOrCreate("mood", () => mood);
    cache.getOrCreate("voyage", () => voyage);
    cache.getOrCreate("aurora", () => aurora);

    expect(mood.dispose).toHaveBeenCalledOnce();
    expect(voyage.dispose).not.toHaveBeenCalled();
    expect(aurora.dispose).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith("mood", undefined);
    expect(cache.get("mood")).toBeUndefined();
  });

  it("disposes the warm entry before constructing a replacement", () => {
    const events: string[] = [];
    const cache = new ThreeInstanceCache(2);
    const instance = (id: string): ThreeInstance => ({
      render: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(() => events.push(`dispose:${id}`)),
    });

    cache.getOrCreate("mood", () => instance("mood"));
    cache.getOrCreate("voyage", () => instance("voyage"));
    cache.getOrCreate("aurora", () => {
      events.push("create:aurora");
      return instance("aurora");
    });

    expect(events).toEqual(["dispose:mood", "create:aurora"]);
    expect(cache.size).toBe(2);
  });

  it("keeps a style warm when get refreshes its recency", () => {
    const cache = new ThreeInstanceCache(2);
    const mood = {
      render: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
    } satisfies ThreeInstance;
    const voyage = {
      render: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
    } satisfies ThreeInstance;
    const aurora = {
      render: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
    } satisfies ThreeInstance;

    cache.getOrCreate("mood", () => mood);
    cache.getOrCreate("voyage", () => voyage);
    expect(cache.get("mood")).toBe(mood);
    cache.getOrCreate("aurora", () => aurora);

    expect(mood.dispose).not.toHaveBeenCalled();
    expect(voyage.dispose).toHaveBeenCalledOnce();
    expect(cache.get("mood")).toBe(mood);
    expect(cache.get("voyage")).toBeUndefined();
  });

  it("keeps a style warm when getOrCreate reuses it", () => {
    const cache = new ThreeInstanceCache(2);
    const mood = {
      render: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
    } satisfies ThreeInstance;
    const voyage = {
      render: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
    } satisfies ThreeInstance;
    const aurora = {
      render: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
    } satisfies ThreeInstance;
    const recreateMood = vi.fn(() => mood);

    cache.getOrCreate("mood", () => mood);
    cache.getOrCreate("voyage", () => voyage);
    expect(cache.getOrCreate("mood", recreateMood)).toBe(mood);
    cache.getOrCreate("aurora", () => aurora);

    expect(recreateMood).not.toHaveBeenCalled();
    expect(mood.dispose).not.toHaveBeenCalled();
    expect(voyage.dispose).toHaveBeenCalledOnce();
    expect(cache.get("voyage")).toBeUndefined();
  });

  it("removes and disposes a style explicitly", () => {
    const onDispose = vi.fn();
    const cache = new ThreeInstanceCache(2, onDispose);
    const mood = {
      render: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
    } satisfies ThreeInstance;
    cache.getOrCreate("mood", () => mood);

    expect(cache.remove("mood")).toBe(true);
    expect(cache.remove("mood")).toBe(false);
    expect(cache.size).toBe(0);
    expect(mood.dispose).toHaveBeenCalledOnce();
    expect(onDispose).toHaveBeenCalledWith("mood", undefined);
  });

  it("removes a broken instance even when disposal throws", () => {
    const failure = new Error("dispose failed");
    const report = vi.fn();
    const onDispose = vi.fn();
    const cache = new ThreeInstanceCache(2, onDispose);
    const broken = {
      render: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(() => {
        throw failure;
      }),
    } satisfies ThreeInstance;
    cache.getOrCreate("broken", () => broken);

    expect(cache.remove("broken", report)).toBe(true);
    expect(cache.get("broken")).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(report).toHaveBeenCalledWith("broken", failure);
    expect(onDispose).toHaveBeenCalledWith("broken", failure);
  });

  it("reuses initialized styles until the view is destroyed", () => {
    const cache = new ThreeInstanceCache();
    const mood = {
      render: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
    } satisfies ThreeInstance;
    const voyage = {
      render: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
    } satisfies ThreeInstance;
    const recreateMood = vi.fn(() => mood);

    expect(cache.getOrCreate("mood", () => mood)).toBe(mood);
    expect(cache.getOrCreate("voyage", () => voyage)).toBe(voyage);
    expect(cache.getOrCreate("mood", recreateMood)).toBe(mood);
    expect(recreateMood).not.toHaveBeenCalled();
    expect(mood.dispose).not.toHaveBeenCalled();
    expect(voyage.dispose).not.toHaveBeenCalled();

    cache.disposeAll();
    expect(mood.dispose).toHaveBeenCalledOnce();
    expect(voyage.dispose).toHaveBeenCalledOnce();
    expect(cache.size).toBe(0);
  });
});
