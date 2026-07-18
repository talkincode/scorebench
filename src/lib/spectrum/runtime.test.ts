import { describe, expect, it, vi } from "vitest";
import { drawWithFallback } from "./runtime";
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
