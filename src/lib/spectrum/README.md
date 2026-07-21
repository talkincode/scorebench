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
- follows the theme hue from `ThreeFrame.hue` — no hard-coded palettes (the mood style may temperature-shift around it, see below).

Shared helpers (shell setup, glow sprites, band levels) live in `three/common.ts`. Audio-reactive dynamics (attack/release envelopes, band smoothing, bass-impact detection, idle breathing) live in `dynamics.ts` — pure per-frame math, unit-tested without audio.

### 情绪 · Mood (`mood`)

An abstract "random digital world" that morphs between five archetypes — 宇宙 cosmos, 星空 starlight, 大海 ocean, 草原 meadow, 城市 city — instead of drawing bins directly. It doubles as the visual acceptance surface for scorekit's "mood compiler": what the agent *intended* and what the renderer *hears* meet on screen.

The mapping is pure and unit-tested, split in two layers:

- **`features.ts` — perceptual features.** Folds FFT bins into a 12-class chroma (≥400 Hz, with an 80–400 Hz bass band for root evidence), then derives `modeMajor` (major-vs-minor third evidence, root-weighted), `dissonance` (semitone/whole-tone adjacency roughness), `tonalness`, log-Hz `centroid` (brightness), and spectral `flux`. Synthetic chord fixtures (major/minor/cluster/fifths) must stay distinguishable in tests. `modeFromKey` parses scene key strings ("D minor", "Am", …) into an intent prior.
- **`mood.ts` — V-A-T emotion space.** Features integrate into four axes — valence (mode + consonance + brightness), arousal (energy + flux), tension (dissonance × tonalness + build-up), pulse — across three time scales (texture ~0.1 s, phrase ~2 s, form ~20 s). A build-up detector tracks the slope of the slow energy envelope; `swell` exposes the phrase envelope. Each world holds a signature in V-A-T-P space and receives a Gaussian affinity weight; the dominant world only flips after a challenger stays ahead for a dwell period. An optional intent prior (`intentMode` from the scene's key) nudges valence and is reported back as `MoodState.intent` so intended vs. heard mood can be compared. On top of the worlds, a **weather layer** reads the same axes as atmosphere — 晴 clear, 雾 mist, 雨 rain, 雪 snow, 雷 storm — via axis-weighted Gaussian affinities (valence/tension count roughly double, so an energetic-but-neutral groove stays clear while dark strain storms). Weather weights crossfade independently of worlds with a shorter dwell (~1.6 s), and a continuous `wind` axis follows spectral restlessness.

The scene in `three/mood.ts` cross-fades every element along those weights (nebulae, star twinkle, a sea↔grass wave field, an equalizer skyline, fireflies/spray motes, impact meteors, a drifting first-person camera). On top of the archetype weights it renders the mood axes directly: valence shifts the palette temperature around the theme hue (warm ↔ cold, the one sanctioned deviation from `ThreeFrame.hue`), tension sharpens ground chop and adds incommensurate camera jitter, build-up charges ripple/horizon energy and releases as an FOV kick, swell breathes the camera. The weather weights drive an atmosphere pass: rain streaks (storm rains harder and faster) and wind-swayed snow fall through pooled point fields, mist pulls the fog wall in and thickens the moon haze, storms strike lightning (sky-wide flash + scene boosts; impact-triggered or a seeded poisson trickle, disabled under reduced motion), and `overcast` slides a cloud deck over stars, nebulae, moon and meteors so precipitation always falls from a closed sky. Wind shears the rain, widens snow sway, and hurries wisps, motes, nebula sway and the wave field. A read-only ortho HUD overlay (toggle via the `moodHud` option) plots V/A/T bars, the build-up line, the dominant world with the weather glyph (晴/雾/雨/雪/雷), and an ◆ intent marker on the valence track — the acceptance view. World layout randomness is seeded (`seededRandom`) — random-looking, deterministic per instance.

The player injects `sampleRate` (for correct bin→Hz mapping) and `intentMode` (from the current scene's `key`) through the shared style-options record; both are optional and the style degrades gracefully without them.

`SpectrumView` remounts the `<canvas>` element whenever the style kind changes (2D ↔ three). A canvas that has ever produced a WebGL context cannot go back to `2d`, so each style family always receives a fresh element.

## Auto selection (`auto`)

`auto.ts` derives coarse traits (energy, dynamics, brightness, density) from a decoded
`AudioBuffer` — pure functions, unit-tested without audio playback — and picks a style
deterministically. The player stores `"auto"` as the persisted style id and re-picks on
every asset load.

## Failure handling

Add a style under this directory and append it to `visualStyles` in `index.ts`. A thrown 2D draw error is logged once and falls back to `bars`; a three style that fails to import or initialize (e.g. WebGL unavailable) falls back to `bars`. Playback is never stopped by a visual failure.
