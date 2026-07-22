import type { SpectrumFrame, SpectrumStyle } from "./types";
import type { ThreeInstance } from "./three/types";

export function drawWithFallback(
  style: SpectrumStyle,
  fallback: SpectrumStyle,
  frame: SpectrumFrame,
  failedStyles: Set<string>,
  report: (error: unknown) => void = console.error,
): SpectrumStyle {
  try {
    style.draw(frame);
    return style;
  } catch (error) {
    if (!failedStyles.has(style.id)) {
      failedStyles.add(style.id);
      report(error);
    }
    fallback.draw(frame);
    return fallback;
  }
}

export interface FrameTimingSummary {
  samples: number;
  averageMs: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

/** Allocation-free hot path; percentile work happens only when a window closes. */
export class FrameBudgetMeter {
  private readonly timings: Float64Array;
  private count = 0;

  constructor(private readonly windowSize = 120) {
    if (!Number.isInteger(windowSize) || windowSize < 1) {
      throw new RangeError("FrameBudgetMeter window size must be a positive integer");
    }
    this.timings = new Float64Array(windowSize);
  }

  record(milliseconds: number): FrameTimingSummary | null {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
    this.timings[this.count++] = milliseconds;
    if (this.count < this.windowSize) return null;

    let total = 0;
    let maxMs = 0;
    for (const timing of this.timings) {
      total += timing;
      maxMs = Math.max(maxMs, timing);
    }
    const sorted = Array.from(this.timings).sort((left, right) => left - right);
    const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
    const p99Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1);
    const summary = {
      samples: this.windowSize,
      averageMs: total / this.windowSize,
      p95Ms: sorted[p95Index],
      p99Ms: sorted[p99Index],
      maxMs,
    };
    this.count = 0;
    return summary;
  }
}

/**
 * Retains initialized WebGL styles so switching visuals does not repeatedly
 * rebuild scenes, shaders and post-processing targets on the interaction path.
 */
export class ThreeInstanceCache {
  private readonly instances = new Map<string, ThreeInstance>();

  constructor(
    private readonly capacity = 2,
    private readonly onDispose: (styleId: string, error?: unknown) => void = () => {},
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("ThreeInstanceCache capacity must be a positive integer");
    }
  }

  get size(): number {
    return this.instances.size;
  }

  get(styleId: string): ThreeInstance | undefined {
    const instance = this.instances.get(styleId);
    if (instance === undefined) return undefined;
    this.instances.delete(styleId);
    this.instances.set(styleId, instance);
    return instance;
  }

  getOrCreate(styleId: string, create: () => ThreeInstance): ThreeInstance {
    const cached = this.get(styleId);
    if (cached) return cached;
    // Free the warm slot before constructing a new WebGL scene. Evicting
    // afterwards would transiently create capacity + 1 live GPU contexts,
    // exactly when initialization pressure is highest.
    while (this.instances.size >= this.capacity) this.evictOldest();
    const instance = create();
    this.instances.set(styleId, instance);
    return instance;
  }

  remove(
    styleId: string,
    report: (styleId: string, error: unknown) => void = (failedStyleId, error) =>
      console.error(`spectrum style ${failedStyleId} failed to dispose`, error),
  ): boolean {
    const instance = this.instances.get(styleId);
    if (!instance) return false;
    this.disposeEntry(styleId, instance, report);
    return true;
  }

  private evictOldest(): void {
    const oldest = this.instances.entries().next().value as
      | [string, ThreeInstance]
      | undefined;
    if (!oldest) return;
    this.disposeEntry(oldest[0], oldest[1]);
  }

  private disposeEntry(
    styleId: string,
    instance: ThreeInstance,
    report?: (styleId: string, error: unknown) => void,
  ): void {
    this.instances.delete(styleId);
    let error: unknown;
    try {
      instance.dispose();
    } catch (caught) {
      error = caught;
      report?.(styleId, caught);
    }
    this.onDispose(styleId, error);
  }

  disposeAll(
    report: (styleId: string, error: unknown) => void = (styleId, error) =>
      console.error(`spectrum style ${styleId} failed to dispose`, error),
  ): void {
    for (const [styleId, instance] of [...this.instances]) {
      this.disposeEntry(styleId, instance, report);
    }
  }
}
