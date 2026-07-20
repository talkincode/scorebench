import type { SpectrumOptionDefinition, SpectrumStyle } from "./types";
import type { ThreeStyleModule } from "./three/types";
import { bars } from "./bars";
import { loopring } from "./loopring";
import { spectrogram } from "./spectrogram";
import { wave } from "./wave";

export type { SpectrumFrame, SpectrumOptionDefinition, SpectrumStyle } from "./types";
export type { ThreeFrame, ThreeInstance, ThreeStyleModule } from "./three/types";
export { drawWithFallback } from "./runtime";
export { AUTO_STYLE_ID, analyzeTraits, pickStyle } from "./auto";
export type { AudioTraits, BufferLike } from "./auto";

/** Registry of Canvas2D styles; add 2D styles only here. */
export const spectrumStyles: SpectrumStyle[] = [bars, wave, spectrogram, loopring];

/**
 * One entry in the unified style picker. `kind: "three"` entries lazy-load a
 * WebGL scene module so three.js never lands in the startup bundle.
 */
export type VisualStyleEntry =
  | {
      kind: "2d";
      id: string;
      label: string;
      options?: readonly SpectrumOptionDefinition[];
      style: SpectrumStyle;
    }
  | {
      kind: "three";
      id: string;
      label: string;
      options?: readonly SpectrumOptionDefinition[];
      load: () => Promise<ThreeStyleModule>;
    };

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
  { kind: "three", id: "flux", label: "Flux field", load: () => import("./three/flux") },
  { kind: "three", id: "terrain", label: "Terrain", load: () => import("./three/terrain") },
  { kind: "three", id: "rings", label: "Ring tunnel", load: () => import("./three/rings") },
  { kind: "three", id: "crystal", label: "Crystal", load: () => import("./three/crystal") },
  {
    kind: "three",
    id: "mood",
    label: "情绪 · Mood",
    options: [{ key: "moodHud", label: "HUD", min: 0, max: 1, step: 1, defaultValue: 1 }],
    load: () => import("./three/mood"),
  },
];

export function visualStyleById(id: string): VisualStyleEntry | undefined {
  return visualStyles.find((entry) => entry.id === id);
}
