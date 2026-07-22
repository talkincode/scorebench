import type { MoodState } from "./mood";

export interface SpectrumFrame {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  freq: Uint8Array;
  time: Uint8Array;
  positionFraction: number;
  prefersReducedMotion: boolean;
  options: Readonly<Record<string, number>>;
  /**
   * Perception substrate: emotion coordinates computed once per frame by the
   * view's shared MoodEngine, present only while the active style is
   * mood-aware (`VisualStyleEntry.moodAware`). Mood-blind styles ignore it.
   */
  mood?: MoodState;
}

export interface SpectrumOptionDefinition {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
}

/**
 * A spectrum style receives only analyser/player observations and a canvas.
 * It must clear its own frame and must never control playback or audio nodes.
 */
export interface SpectrumStyle {
  id: string;
  label: string;
  options?: readonly SpectrumOptionDefinition[];
  draw(frame: SpectrumFrame): void;
}
