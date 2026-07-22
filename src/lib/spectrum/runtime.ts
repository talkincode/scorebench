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

/**
 * Retains initialized WebGL styles so switching visuals does not repeatedly
 * rebuild scenes, shaders and post-processing targets on the interaction path.
 */
export class ThreeInstanceCache {
  private readonly instances = new Map<string, ThreeInstance>();

  get(styleId: string): ThreeInstance | undefined {
    return this.instances.get(styleId);
  }

  getOrCreate(styleId: string, create: () => ThreeInstance): ThreeInstance {
    const cached = this.instances.get(styleId);
    if (cached) return cached;
    const instance = create();
    this.instances.set(styleId, instance);
    return instance;
  }

  disposeAll(
    report: (styleId: string, error: unknown) => void = (styleId, error) =>
      console.error(`spectrum style ${styleId} failed to dispose`, error),
  ): void {
    for (const [styleId, instance] of this.instances) {
      try {
        instance.dispose();
      } catch (error) {
        report(styleId, error);
      }
    }
    this.instances.clear();
  }
}
