import type { SpectrumOptionDefinition, SpectrumStyle } from "./types";
import type { ThreeStyleModule } from "./three/types";
import { bars } from "./bars";

export type { SpectrumFrame, SpectrumOptionDefinition, SpectrumStyle } from "./types";
export type { ThreeFrame, ThreeInstance, ThreeStyleModule } from "./three/types";
export { drawWithFallback, ThreeInstanceCache } from "./runtime";
export { AUTO_STYLE_ID, analyzeTraits, pickStyle } from "./auto";
export type { AudioTraits, BufferLike } from "./auto";
export { MoodEngine, neutralMoodState } from "./mood";
export type { MoodIntent, MoodState } from "./mood";

/** Registry of Canvas2D styles; add 2D styles only here. */
export const spectrumStyles: SpectrumStyle[] = [bars];

interface VisualStyleBase {
  id: string;
  label: string;
  options?: readonly SpectrumOptionDefinition[];
  /**
   * Declares that the style consumes `frame.mood`. The view runs the shared
   * MoodEngine (perception substrate) only while a mood-aware style is
   * active; mood-blind styles stay valid by omitting the flag.
   */
  moodAware?: boolean;
}

/**
 * One entry in the unified style picker. `kind: "three"` entries lazy-load a
 * WebGL scene module so three.js never lands in the startup bundle.
 */
export type VisualStyleEntry =
  | (VisualStyleBase & { kind: "2d"; style: SpectrumStyle })
  | (VisualStyleBase & { kind: "three"; load: () => Promise<ThreeStyleModule> });

export const visualStyles: VisualStyleEntry[] = [
  ...spectrumStyles.map(
    (style): VisualStyleEntry => ({
      kind: "2d",
      id: style.id,
      label: style.label,
      options: style.options,
      style,
    }),
  ),
  {
    kind: "three",
    id: "mood",
    label: "Mood",
    moodAware: true,
    options: [{ key: "moodHud", label: "HUD", min: 0, max: 1, step: 1, defaultValue: 1 }],
    load: () => import("./three/mood"),
  },
  {
    kind: "three",
    id: "voyage",
    label: "Voyage",
    moodAware: true,
    options: [
      { key: "moodHud", label: "HUD", min: 0, max: 1, step: 1, defaultValue: 1 },
      { key: "wireframe", label: "Line layers", min: 0, max: 1, step: 1, defaultValue: 1 },
      { key: "bloom", label: "Bloom", min: 0, max: 1, step: 1, defaultValue: 1 },
    ],
    load: () => import("./three/voyage"),
  },
];

export function visualStyleById(id: string): VisualStyleEntry | undefined {
  return visualStyles.find((entry) => entry.id === id);
}
