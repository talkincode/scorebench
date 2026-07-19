# Spectrum style contract

Visual styles are observation-only renderers over `AnalyserNode` buffers. They never control playback, audio nodes, or project state. The registry in `index.ts` exposes every style as a `VisualStyleEntry` with one of two kinds:

## 2D styles (`kind: "2d"`)

A draw function over a `CanvasRenderingContext2D`. A 2D style:

- receives one `SpectrumFrame` object per animation frame;
- clears its own canvas region on every draw;
- honors `prefersReducedMotion` by reducing temporal movement or update frequency;
- should stay near a 1 ms/frame budget at the default 64 bars;
- may declare numeric options through `options`; the player renders those controls generically;
- may keep canvas-local visual history, such as the spectrogram ring buffer, but no audio-derived state outside analyser data.

## Three.js styles (`kind: "three"`)

A lazily-imported scene module under `three/` (the `three` package is only downloaded into the bundle graph when first selected, keeping startup light). A three style exports `createStyle(canvas): ThreeInstance` and:

- builds its scene once, then renders one `ThreeFrame` (freq/time arrays, bass/energy levels, theme hue) per animation frame;
- must be deterministic per frame — all motion derives from elapsed time and analyser data;
- honors `prefersReducedMotion` via the frame flag;
- disposes GPU resources (`geometry`, `material`, `renderer`, `WEBGL_lose_context`) in `dispose()`;
- follows the theme hue from `ThreeFrame.hue` — no hard-coded palettes.

Shared helpers (shell setup, glow sprites, band levels) live in `three/common.ts`. Audio-reactive dynamics (attack/release envelopes, band smoothing, bass-impact detection, idle breathing) live in `dynamics.ts` — pure per-frame math, unit-tested without audio.

`SpectrumView` remounts the `<canvas>` element whenever the style kind changes (2D ↔ three). A canvas that has ever produced a WebGL context cannot go back to `2d`, so each style family always receives a fresh element.

## Auto selection (`auto`)

`auto.ts` derives coarse traits (energy, dynamics, brightness, density) from a decoded
`AudioBuffer` — pure functions, unit-tested without audio playback — and picks a style
deterministically. The player stores `"auto"` as the persisted style id and re-picks on
every asset load.

## Failure handling

Add a style under this directory and append it to `visualStyles` in `index.ts`. A thrown 2D draw error is logged once and falls back to `bars`; a three style that fails to import or initialize (e.g. WebGL unavailable) falls back to `bars`. Playback is never stopped by a visual failure.
