import { describe, expect, it, vi } from "vitest";
import { drawWithFallback, ThreeInstanceCache } from "./runtime";
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

describe("ThreeInstanceCache", () => {
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
  });
});
