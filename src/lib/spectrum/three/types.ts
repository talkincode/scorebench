import type { MoodState } from "../mood";

/**
 * Contract for WebGL (three.js) spectrum scenes. Like 2D styles they are
 * observation-only: they receive analyser buffers and never touch playback.
 * Modules are lazy-loaded so three.js stays out of the startup bundle.
 */
export interface ThreeFrame {
  freq: Uint8Array;
  time: Uint8Array;
  positionFraction: number;
  /** Seconds since the previous frame, clamped for tab-switch spikes. */
  dt: number;
  /** Seconds since the instance was created. */
  elapsed: number;
  prefersReducedMotion: boolean;
  options: Readonly<Record<string, number>>;
  /**
   * Perception substrate: emotion coordinates computed once per frame by the
   * view's shared MoodEngine, present only while the active style is
   * mood-aware (`VisualStyleEntry.moodAware`). Mood-blind scenes ignore it.
   */
  mood?: MoodState;
}

export interface ThreeInstance {
  render(frame: ThreeFrame): void;
  resize(width: number, height: number, dpr: number): void;
  dispose(): void;
}

export interface ThreeStyleModule {
  create(canvas: HTMLCanvasElement): ThreeInstance;
}
